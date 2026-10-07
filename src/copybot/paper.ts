import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";
import { PROCESSED_SIG_RING_SIZE } from "./constants.js";
import type { PairProvider } from "./prices.js";
import { getPairInfo, getSolPriceUsd } from "./prices.js";
import { short } from "./watcher.js";
import type { NotifierLike } from "./notifier.js";
import type { PairInfo, PaperState, PaperTrade, Position, TradeEvent, WalletRankRow } from "./types.js";

const log = createLogger("paper");

export interface EngineOpts {
  startingBudgetUsd: number;
  clipPct: number;
  premiumWallets?: string[];
  premiumClipPct?: number;
  premiumFallbackClipPct?: number;
  minWalletTradeUsd: number;
  maxPositions: number;
  entrySlippagePct: number;
  exitSlippagePct: number;
  stopLossPct: number;
  dataDir: string;
  trackedWallets?: string[];
  /** Wallets to observe without deploying capital: trades are decoded and
   *  logged, exits on pre-existing positions still mirror, but no new buys. */
  shadowWallets?: string[];
  /** Skip entries into tokens with less DexScreener liquidity (USD). 0 disables. */
  liquidityFloorUsd?: number;
  /** Stop copying a wallet while cumulative realized PnL <= this. 0 disables. */
  killSwitchPnlUsd?: number;
  /** Win-rate kill needs >= this many closed sells. */
  killSwitchMinSells?: number;
  /** Win-rate kill fires below this win rate (with negative PnL). */
  killSwitchMaxWinRate?: number;
  /** Max accumulated position cost, as a multiple of the first clip. 0 disables. */
  topUpCostCapMultiple?: number;
  /** Operation id for a capital reset: when it differs from the last applied
   *  reset, previous state + ledger are archived and a fresh account starts
   *  from startingBudgetUsd. Empty disables. */
  resetId?: string;
  pairProvider?: PairProvider;
  solPriceProvider?: () => Promise<number>;
  notifier?: NotifierLike;
}

function defaultState(startingBudgetUsd: number): PaperState {
  return { cashUsd: startingBudgetUsd, positions: {}, lastSigByWallet: {}, processedSigs: [] };
}

export class PaperEngine {
  state: PaperState;
  /** Full realized trade ledger (rebuilt from disk on boot). */
  ledger: PaperTrade[] = [];

  private pair: PairProvider;
  private solPrice: () => Promise<number>;
  private notifier: NotifierLike;
  private ledgerFile: string;
  private snapshotFile: string;
  private seq = 0;
  private processing: Promise<void> = Promise.resolve();
  private completedTransactions = new Set<string>();
  private shadow = new Set<string>();
  private premium = new Set<string>();
  private liquidityFloor: number;
  private killPnl: number;
  private killMinSells: number;
  private killMaxWinRate: number;
  private topUpCap: number;

  shadowTradesSkipped = 0;

  constructor(private opts: EngineOpts) {
    this.state = defaultState(opts.startingBudgetUsd);
    this.shadow = new Set(opts.shadowWallets ?? []);
    this.premium = new Set(opts.premiumWallets ?? []);
    this.liquidityFloor = opts.liquidityFloorUsd ?? 25_000;
    this.killPnl = opts.killSwitchPnlUsd ?? -50;
    this.killMinSells = opts.killSwitchMinSells ?? 20;
    this.killMaxWinRate = opts.killSwitchMaxWinRate ?? 0.3;
    this.topUpCap = opts.topUpCostCapMultiple ?? 2;
    this.pair = opts.pairProvider ?? getPairInfo;
    this.solPrice = opts.solPriceProvider ?? getSolPriceUsd;
    this.notifier = opts.notifier ?? { send: async () => {} };
    this.ledgerFile = path.join(opts.dataDir, "paper-trades.jsonl");
    this.snapshotFile = path.join(opts.dataDir, "positions-snapshot.json");
  }

  // ── persistence ──────────────────────────────────────────────

  /** Capital reset: when a new RESET_ID is provided, archive the previous
   *  snapshot + ledger and start a fresh account at startingBudgetUsd. */
  private async maybeReset(): Promise<void> {
    const resetId = this.opts.resetId;
    if (!resetId) return;
    let lastResetId: string | undefined;
    try {
      const raw = await fs.readFile(this.snapshotFile, "utf8");
      lastResetId = (JSON.parse(raw) as Partial<PaperState>).lastResetId;
    } catch {
      /* no snapshot yet: nothing to archive */
    }
    if (lastResetId === resetId) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const file of [this.snapshotFile, this.ledgerFile]) {
      try {
        await fs.rename(file, `${file}.archive-${stamp}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    this.state = { ...defaultState(this.opts.startingBudgetUsd), lastResetId: resetId };
    this.ledger = [];
    log.warn(`RESET ${resetId}: previous state + ledger archived; fresh account starting at $${this.opts.startingBudgetUsd}`);
  }

  async load(): Promise<void> {
    await fs.mkdir(this.opts.dataDir, { recursive: true });
    await this.maybeReset();
    try {
      const raw = await fs.readFile(this.snapshotFile, "utf8");
      const saved = JSON.parse(raw) as Partial<PaperState>;
      this.state = {
        cashUsd: typeof saved.cashUsd === "number" ? saved.cashUsd : this.opts.startingBudgetUsd,
        positions: saved.positions ?? {},
        lastSigByWallet: saved.lastSigByWallet ?? {},
        processedSigs: saved.processedSigs ?? [],
        lastManualCloseId: saved.lastManualCloseId,
        // Preserve the reset marker across restarts; otherwise the next boot
        // would re-trigger the reset and archive the live account.
        lastResetId: saved.lastResetId ?? this.state.lastResetId,
      };
      log.info(
        `restored: cash $${this.state.cashUsd.toFixed(2)}, ${Object.keys(this.state.positions).length} position(s), ` +
          `${Object.keys(this.state.lastSigByWallet).length} wallet cursor(s)`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      log.info("no snapshot found; starting fresh paper account");
    }
    try {
      const raw = await fs.readFile(this.ledgerFile, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        this.ledger.push(JSON.parse(t) as PaperTrade);
      }
      log.info(`loaded ${this.ledger.length} ledger trade(s)`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async save(): Promise<void> {
    const tmp = `${this.snapshotFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state));
    await fs.rename(tmp, this.snapshotFile);
  }

  private async appendLedger(trade: PaperTrade): Promise<void> {
    this.ledger.push(trade);
    await fs.appendFile(this.ledgerFile, `${JSON.stringify(trade)}\n`);
  }

  // ── trade handling ───────────────────────────────────────────

  async onTrades(events: TradeEvent[]): Promise<void> {
    const next = this.processing.then(() => this.processTrades(events));
    this.processing = next.catch((err) => log.error(`processing failed: ${String(err)}`));
    return next;
  }

  private async processTrades(events: TradeEvent[]): Promise<void> {
    for (const ev of events) {
      const key = `${ev.wallet}:${ev.signature}:${ev.mint}`;
      if (this.state.processedSigs.includes(key) || this.state.processedSigs.includes(`${ev.wallet}:${ev.signature}`)) continue;
      await this.handleTrade(ev);
      this.state.processedSigs.push(key);
      if (this.state.processedSigs.length > PROCESSED_SIG_RING_SIZE) {
        this.state.processedSigs.splice(0, this.state.processedSigs.length - PROCESSED_SIG_RING_SIZE);
      }
      await this.save();
    }
    for (const ev of events) this.completedTransactions.add(`${ev.wallet}:${ev.signature}`);
    if (this.completedTransactions.size > PROCESSED_SIG_RING_SIZE) {
      this.completedTransactions.delete(this.completedTransactions.values().next().value!);
    }
  }

  hasProcessed(wallet: string, signature: string): boolean {
    return this.completedTransactions.has(`${wallet}:${signature}`);
  }

  private async handleTrade(ev: TradeEvent): Promise<void> {
    if (ev.side === "buy" && this.shadow.has(ev.wallet)) {
      this.shadowTradesSkipped++;
      log.info(`SHADOW skip buy: ${short(ev.wallet)} ${ev.mint.slice(0, 8)}… qty ${ev.tokenDelta.toPrecision(6)} (shadow wallet, no capital deployed)`);
      return;
    }
    const info = await this.pair(ev.mint);
    const marketPrice = info?.priceUsd ?? 0;
    if (!marketPrice) {
      log.warn(`no price for ${ev.mint.slice(0, 8)}…; skipped ${ev.side}`);
      return;
    }
    const { fillRef, walletNotional, derived } = await this.resolveFill(ev, marketPrice);
    log.debug(
      `${ev.side} ${ev.mint.slice(0, 8)}… fill $${fillRef.toPrecision(6)} ` +
        `(${derived ? "wallet-derived" : "market"}) notional $${walletNotional.toFixed(2)}`,
    );
    if (ev.side === "buy") await this.copyBuy(ev, fillRef, info?.symbol ?? ev.mint.slice(0, 6), walletNotional, info);
    else await this.copySell(ev, fillRef, info?.symbol ?? ev.mint.slice(0, 6), walletNotional);
  }

  /**
   * Resolve the reference price for a copy fill.
   *
   * Realistic copying: when the wallet's swap moved native SOL, derive the
   * wallet's ACTUAL fill price from the SOL leg (SOL moved x SOL price /
   * tokens moved) and use that, so paper PnL reflects entering/exiting at
   * roughly the same price as the copied wallet. Falls back to the current
   * market mark for token<->token swaps or when the derived price is
   * implausible (glitchy SOL attribution in multi-swap txs).
   */
  private async resolveFill(
    ev: TradeEvent,
    marketPrice: number,
  ): Promise<{ fillRef: number; walletNotional: number; derived: boolean }> {
    let fillRef = marketPrice;
    let walletNotional = ev.tokenDelta * marketPrice;
    let derived = false;
    const solUsd = await this.solPrice();
    const solMoved = ev.side === "buy" ? -ev.solDelta : ev.solDelta;
    if (solUsd > 0 && solMoved > 1e-9) {
      const candidate = (solMoved * solUsd) / ev.tokenDelta;
      if (
        Number.isFinite(candidate) &&
        candidate > 0 &&
        candidate <= marketPrice * 10 &&
        candidate >= marketPrice * 0.1
      ) {
        fillRef = candidate;
        walletNotional = solMoved * solUsd;
        derived = true;
      }
    }
    return { fillRef, walletNotional, derived };
  }

  private async copyBuy(
    ev: TradeEvent,
    price: number,
    symbol: string,
    walletNotional: number,
    info: PairInfo | null,
  ): Promise<void> {
    if (this.isKilled(ev.wallet)) {
      log.warn(`KILL-SWITCH skip buy: ${short(ev.wallet)} ${symbol} (wallet below PnL/win-rate threshold)`);
      return;
    }
    if (walletNotional < this.opts.minWalletTradeUsd) {
      log.info(
        `skip dust buy: ${short(ev.wallet)} ${symbol} notional $${walletNotional.toFixed(2)} < $${this.opts.minWalletTradeUsd}`,
      );
      return;
    }
    if (this.liquidityFloor > 0 && (info?.liquidityUsd ?? 0) < this.liquidityFloor) {
      log.warn(
        `skip low-liquidity buy: ${short(ev.wallet)} ${symbol} pool $${(info?.liquidityUsd ?? 0).toFixed(0)} < floor $${this.liquidityFloor}`,
      );
      return;
    }
    const premium = this.premium.has(ev.wallet);
    const primaryPct = premium ? (this.opts.premiumClipPct ?? 10) : this.opts.clipPct;
    const fallbackPct = premium ? (this.opts.premiumFallbackClipPct ?? 5) : primaryPct;
    const primaryUsd = (walletNotional * primaryPct) / 100;
    const fallbackUsd = (walletNotional * fallbackPct) / 100;
    const useFallback = premium && this.state.cashUsd < primaryUsd;
    const ourUsd = useFallback ? fallbackUsd : primaryUsd;
    const appliedPct = useFallback ? fallbackPct : primaryPct;
    const key = `${ev.wallet}:${ev.mint}`;
    const existing = this.state.positions[key];

    if (existing && this.topUpCap > 0 && existing.costUsd + ourUsd > existing.clipUsd * this.topUpCap) {
      log.warn(
        `skip top-up: ${short(ev.wallet)} ${symbol} would cost $${(existing.costUsd + ourUsd).toFixed(2)} ` +
          `> cap ${this.topUpCap}x first clip $${existing.clipUsd.toFixed(2)}`,
      );
      return;
    }

    if (!existing && Object.keys(this.state.positions).length >= this.opts.maxPositions) {
      log.warn(`max positions reached; skipped buy of ${symbol}`);
      return;
    }
    if (this.state.cashUsd < ourUsd) {
      log.warn(`insufficient cash $${this.state.cashUsd.toFixed(2)} for $${ourUsd.toFixed(2)} buy of ${symbol}`);
      return;
    }

    const fillPrice = price * (1 + this.opts.entrySlippagePct / 100);
    const qty = ourUsd / fillPrice;
    this.state.cashUsd -= ourUsd;

    let pos: Position;
    if (existing) {
      existing.qty += qty;
      existing.costUsd += ourUsd;
      pos = existing;
    } else {
      pos = {
        key,
        wallet: ev.wallet,
        mint: ev.mint,
        symbol,
        qty,
        costUsd: ourUsd,
        openedAt: Date.now(),
        clipUsd: ourUsd,
      };
      this.state.positions[key] = pos;
    }

    const trade: PaperTrade = {
      id: this.nextId(),
      ts: Date.now(),
      wallet: ev.wallet,
      mint: ev.mint,
      symbol,
      side: "buy",
      priceUsd: fillPrice,
      qty,
      usd: ourUsd,
      walletTradeUsd: walletNotional,
      reason: existing ? "copy top-up" : "copy entry",
      signature: ev.signature,
    };
    await this.appendLedger(trade);
    log.info(
      `BUY ${symbol}: ${short(ev.wallet)} spent ~$${walletNotional.toFixed(0)} -> we clip ${appliedPct}% ($${ourUsd.toFixed(2)}) ` +
        `@ $${fillPrice.toPrecision(6)} (qty ${qty.toPrecision(6)}), cash $${this.state.cashUsd.toFixed(2)}`,
    );
    // No Telegram alert for entries: only CLOSED trades alert.
  }

  private async copySell(
    ev: TradeEvent,
    price: number,
    symbol: string,
    walletNotional: number,
  ): Promise<void> {
    const key = `${ev.wallet}:${ev.mint}`;
    const pos = this.state.positions[key];
    if (!pos) {
      if (this.shadow.has(ev.wallet)) return; // shadow wallets never hold positions; stay quiet
      log.info(`sell with no position: ${short(ev.wallet)} ${symbol} (missed entry or already closed)`);
      return;
    }

    // Mirror the fraction of the wallet's bag that it sold.
    const theirBag = ev.tokenDelta + ev.remainingTokens;
    const frac = theirBag > 0 ? Math.min(1, ev.tokenDelta / theirBag) : 1;

    const fillPrice = price * (1 - this.opts.exitSlippagePct / 100);
    const sellQty = pos.qty * frac;
    const proceeds = sellQty * fillPrice;
    const costSold = pos.costUsd * frac;
    const pnlUsd = proceeds - costSold;
    const pnlPct = costSold > 0 ? (pnlUsd / costSold) * 100 : 0;
    const capitalBefore = this.capital();

    pos.qty -= sellQty;
    pos.costUsd -= costSold;
    this.state.cashUsd += proceeds;
    if (frac === 1) delete this.state.positions[key];
    const capitalAfter = this.capital();

    const trade: PaperTrade = {
      id: this.nextId(),
      ts: Date.now(),
      wallet: ev.wallet,
      mint: ev.mint,
      symbol,
      side: "sell",
      priceUsd: fillPrice,
      qty: sellQty,
      usd: proceeds,
      walletTradeUsd: walletNotional,
      pnlUsd,
      pnlPct,
      reason: `copy exit ${(frac * 100).toFixed(0)}%`,
      signature: ev.signature,
    };
    await this.appendLedger(trade);
    log.info(
      `SELL ${symbol}: ${short(ev.wallet)} sold ~$${walletNotional.toFixed(0)} -> we exit ${(frac * 100).toFixed(0)}% ` +
        `for $${proceeds.toFixed(2)} (PnL $${pnlUsd.toFixed(2)} / ${pnlPct.toFixed(1)}%), cash $${this.state.cashUsd.toFixed(2)}`,
    );
    // Closed-trade alert: capital (cash + deployed) already includes the
    // realized profit, so proceeds compound into future entries.
    await this.notifier.send(
      `TRADE CLOSED — COPY SELL ${symbol}\n` +
        `Wallet: ${ev.wallet}\n` +
        `Token: ${symbol} (${ev.mint})\n` +
        `Exit: ${(frac * 100).toFixed(0)}% of position @ $${fillPrice.toPrecision(6)}\n` +
        `PnL: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)\n` +
        `Capital: $${capitalBefore.toFixed(2)} -> $${capitalAfter.toFixed(2)}`,
    );
  }

  async closeAll(id: string): Promise<{ closed: number; skipped: number; pnlUsd: number }> {
    if (!id) throw new Error("manual close requires a nonempty operation id");
    const next = this.processing.then(async () => {
      if (this.state.lastManualCloseId === id) return { closed: 0, skipped: 0, pnlUsd: 0 };
      let closed = 0;
      let skipped = 0;
      const capitalBefore = this.capital();
      for (const pos of Object.values(this.state.positions)) {
        const info = await this.pair(pos.mint);
        if (!info?.priceUsd) {
          skipped++;
          log.warn(`manual close: no price for ${pos.symbol} (${pos.mint}); position remains open`);
          continue;
        }
        await this.forceClose(pos, "manual close", info.priceUsd);
        closed++;
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
      this.state.lastManualCloseId = id;
      await this.save();
      return { closed, skipped, pnlUsd: this.capital() - capitalBefore };
    });
    this.processing = next.then(() => undefined, (err) => log.error(`manual close failed: ${String(err)}`));
    return next;
  }

  // ── risk gates ───────────────────────────────────────────────

  private walletStats(wallet: string): { realizedPnl: number; sells: number; wins: number } {
    let realizedPnl = 0;
    let sells = 0;
    let wins = 0;
    for (const t of this.ledger) {
      if (t.wallet !== wallet || t.side !== "sell") continue;
      sells++;
      const pnl = t.pnlUsd ?? 0;
      realizedPnl += pnl;
      if (pnl > 0) wins++;
    }
    return { realizedPnl, sells, wins };
  }

  /** True while a wallet's trailing performance blocks new entries.
   *  Stateless: re-evaluated per buy, so wallets auto-re-enable when their
   *  realized PnL recovers (e.g. open positions exit profitably). */
  isKilled(wallet: string): boolean {
    const s = this.walletStats(wallet);
    if (this.killPnl !== 0 && s.realizedPnl <= this.killPnl) return true;
    if (this.killMinSells > 0 && s.sells >= this.killMinSells && s.realizedPnl < 0 && s.wins / s.sells < this.killMaxWinRate) {
      return true;
    }
    return false;
  }

  killSwitchedWallets(): string[] {
    return (this.opts.trackedWallets ?? []).filter((w) => this.isKilled(w)).map((w) => short(w));
  }

  // ── stop-loss marking ────────────────────────────────────────

  /** Re-mark every open position; force-close anything past the stop loss. */
  async markAll(): Promise<void> {
    const next = this.processing.then(() => this.markPositions());
    this.processing = next.catch((err) => log.error(`marking failed: ${String(err)}`));
    return next;
  }

  private async markPositions(): Promise<void> {
    const stops: Position[] = [];
    for (const pos of Object.values(this.state.positions)) {
      const info = await this.pair(pos.mint);
      if (!info?.priceUsd) continue;
      const entryPrice = pos.costUsd / pos.qty;
      const pnlPct = ((info.priceUsd - entryPrice) / entryPrice) * 100;
      if (this.opts.stopLossPct > 0 && pnlPct <= -this.opts.stopLossPct) stops.push(pos);
    }
    for (const pos of stops) {
      await this.forceClose(pos, "stop-loss");
    }
    if (stops.length > 0) await this.save();
  }

  private async forceClose(pos: Position, reason: string, marketPrice?: number): Promise<void> {
    const price = marketPrice ?? (await this.pair(pos.mint))?.priceUsd ?? 0;
    const fillPrice = price * (1 - this.opts.exitSlippagePct / 100);
    if (!fillPrice) {
      log.warn(`stop-loss on ${pos.symbol}: no mark price; retry next cycle`);
      return;
    }
    const proceeds = pos.qty * fillPrice;
    const pnlUsd = proceeds - pos.costUsd;
    const pnlPct = pos.costUsd > 0 ? (pnlUsd / pos.costUsd) * 100 : 0;
    const capitalBefore = this.capital();

    this.state.cashUsd += proceeds;
    delete this.state.positions[pos.key];
    const capitalAfter = this.capital();

    const trade: PaperTrade = {
      id: this.nextId(),
      ts: Date.now(),
      wallet: pos.wallet,
      mint: pos.mint,
      symbol: pos.symbol,
      side: "sell",
      priceUsd: fillPrice,
      qty: pos.qty,
      usd: proceeds,
      walletTradeUsd: 0,
      pnlUsd,
      pnlPct,
      reason,
      signature: "",
    };
    await this.appendLedger(trade);
    await this.save();
    log.warn(
      `${reason.toUpperCase()} ${pos.symbol}: exited for $${proceeds.toFixed(2)} (PnL $${pnlUsd.toFixed(2)} / ${pnlPct.toFixed(1)}%), ` +
        `cash $${this.state.cashUsd.toFixed(2)}`,
    );
    await this.notifier.send(
      `TRADE CLOSED — ${reason.toUpperCase()} ${pos.symbol}\n` +
        `Wallet: ${pos.wallet}\n` +
        `Token: ${pos.symbol} (${pos.mint})\n` +
        `Exit: 100% of position @ $${fillPrice.toPrecision(6)}\n` +
        `PnL: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)\n` +
        `Capital: $${capitalBefore.toFixed(2)} -> $${capitalAfter.toFixed(2)}`,
    );
  }

  // ── wallet performance / rankings ────────────────────────────

  async walletRankings(): Promise<WalletRankRow[]> {
    const now = Date.now();
    const nowDate = new Date(now);
    const dayStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
    const weekStart = now - 7 * 24 * 3600 * 1000;

    interface Acc {
      dayPnl: number;
      dayTrades: number;
      dayPos: number;
      dayNeg: number;
      weekPnl: number;
      weekTrades: number;
      weekPos: number;
      weekNeg: number;
    }
    const acc = new Map<string, Acc>();
    const get = (w: string): Acc => {
      let a = acc.get(w);
      if (!a) {
        a = { dayPnl: 0, dayTrades: 0, dayPos: 0, dayNeg: 0, weekPnl: 0, weekTrades: 0, weekPos: 0, weekNeg: 0 };
        acc.set(w, a);
      }
      return a;
    };

    for (const t of this.ledger) {
      const a = get(t.wallet);
      const won = t.side === "sell" && (t.pnlUsd ?? 0) > 0;
      const lost = t.side === "sell" && (t.pnlUsd ?? 0) < 0;
      if (t.ts >= dayStart) {
        a.dayTrades++;
        a.dayPnl += t.pnlUsd ?? 0;
        if (won) a.dayPos++;
        if (lost) a.dayNeg++;
      }
      if (t.ts >= weekStart) {
        a.weekTrades++;
        a.weekPnl += t.pnlUsd ?? 0;
        if (won) a.weekPos++;
        if (lost) a.weekNeg++;
      }
    }

    const wallets = new Set<string>([
      ...(this.opts.trackedWallets ?? []),
      ...acc.keys(),
      ...Object.values(this.state.positions).map((p) => p.wallet),
    ]);
    const unrealized = new Map<string, number>();
    for (const pos of Object.values(this.state.positions)) {
      const info = await this.pair(pos.mint);
      if (!info?.priceUsd) continue;
      const pnl = pos.qty * info.priceUsd - pos.costUsd;
      unrealized.set(pos.wallet, (unrealized.get(pos.wallet) ?? 0) + pnl);
    }

    const rows: WalletRankRow[] = [];
    for (const w of wallets) {
      const a =
        acc.get(w) ?? { dayPnl: 0, dayTrades: 0, dayPos: 0, dayNeg: 0, weekPnl: 0, weekTrades: 0, weekPos: 0, weekNeg: 0 };
      rows.push({
        wallet: w,
        short: short(w),
        dayPnl: a.dayPnl,
        dayTrades: a.dayTrades,
        dayPos: a.dayPos,
        dayNeg: a.dayNeg,
        weekPnl: a.weekPnl,
        weekTrades: a.weekTrades,
        weekPos: a.weekPos,
        weekNeg: a.weekNeg,
        unrealizedUsd: unrealized.get(w) ?? 0,
        rank: 0,
      });
    }

    rows.sort(
      (x, y) =>
        y.dayPnl - x.dayPnl ||
        y.dayPos - x.dayPos ||
        y.dayTrades - x.dayTrades ||
        y.weekPnl - x.weekPnl,
    );
    rows.forEach((r, i) => (r.rank = i + 1));
    return rows;
  }

  formatRankings(rows: WalletRankRow[]): string {
    const lines: string[] = [`WALLET RANKINGS — ${new Date().toUTCString()}`, ""];
    for (const r of rows) {
      lines.push(
        `${r.rank}. ${r.short}  ${fmtPnl(r.dayPnl)} day`,
        `   day:   ${r.dayTrades} trades | ${r.dayPos} pos / ${r.dayNeg} neg`,
        `   week:  ${fmtPnl(r.weekPnl)} | ${r.weekTrades} trades | ${r.weekPos} pos / ${r.weekNeg} neg`,
        `   open:  ${fmtPnl(r.unrealizedUsd)} unrealized`,
      );
      if (r.simPnlUsd !== undefined) {
        lines.push(
          `   sim:   ${fmtPnl(r.simPnlUsd)} simulated | ${r.simTrades ?? 0} sim trades | ` +
            `${r.simWins ?? 0} pos / ${r.simLosses ?? 0} neg | ${fmtPnl(r.simUnrealizedUsd ?? 0)} sim open`,
        );
      }
    }
    return lines.join("\n");
  }

  async sendDailyRankings(): Promise<void> {
    const rows = await this.walletRankings();
    await this.notifier.send(this.formatRankings(rows));
  }

  /** Total trading capital: idle cash + capital deployed in open positions. Realized profits compound into this. */
  capital(): number {
    let deployed = 0;
    for (const pos of Object.values(this.state.positions)) deployed += pos.costUsd;
    return this.state.cashUsd + deployed;
  }

  summary(): Record<string, unknown> {
    const realized = this.ledger.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
    return {
      capitalUsd: round2(this.capital()),
      cashUsd: round2(this.state.cashUsd),
      deployedUsd: round2(this.capital() - this.state.cashUsd),
      openPositions: Object.keys(this.state.positions).length,
      ledgerTrades: this.ledger.length,
      realizedPnlUsd: round2(realized),
      watchedWallets: Object.keys(this.state.lastSigByWallet).length,
    };
  }

  private nextId(): string {
    this.seq += 1;
    return `${Date.now()}-${this.seq}-${randomUUID().slice(0, 8)}`;
  }
}

function fmtPnl(v: number): string {
  return `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
}

/** Partition trade events into shadow-wallet events and the rest, so the two
 *  engines (shadow simulator / live paper account) can be fed exclusively. */
export function splitShadowEvents<T extends TradeEvent>(events: T[], shadow: Set<string>): [T[], T[]] {
  if (shadow.size === 0) return [[], events];
  const shadowEvents: T[] = [];
  const rest: T[] = [];
  for (const ev of events) (shadow.has(ev.wallet) ? shadowEvents : rest).push(ev);
  return [shadowEvents, rest];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
