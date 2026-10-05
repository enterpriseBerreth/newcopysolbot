import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";
import { PROCESSED_SIG_RING_SIZE } from "./constants.js";
import type { PairProvider } from "./prices.js";
import { getPairInfo } from "./prices.js";
import { short } from "./watcher.js";
import type { NotifierLike } from "./notifier.js";
import type { PaperState, PaperTrade, Position, TradeEvent, WalletRankRow } from "./types.js";

const log = createLogger("paper");

export interface EngineOpts {
  startingBudgetUsd: number;
  clipPct: number;
  minWalletTradeUsd: number;
  maxPositions: number;
  entrySlippagePct: number;
  exitSlippagePct: number;
  stopLossPct: number;
  dataDir: string;
  pairProvider?: PairProvider;
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
  private notifier: NotifierLike;
  private ledgerFile: string;
  private snapshotFile: string;
  private seq = 0;

  constructor(private opts: EngineOpts) {
    this.state = defaultState(opts.startingBudgetUsd);
    this.pair = opts.pairProvider ?? getPairInfo;
    this.notifier = opts.notifier ?? { send: async () => {} };
    this.ledgerFile = path.join(opts.dataDir, "paper-trades.jsonl");
    this.snapshotFile = path.join(opts.dataDir, "positions-snapshot.json");
  }

  // ── persistence ──────────────────────────────────────────────

  async load(): Promise<void> {
    await fs.mkdir(this.opts.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.snapshotFile, "utf8");
      const saved = JSON.parse(raw) as Partial<PaperState>;
      this.state = {
        cashUsd: typeof saved.cashUsd === "number" ? saved.cashUsd : this.opts.startingBudgetUsd,
        positions: saved.positions ?? {},
        lastSigByWallet: saved.lastSigByWallet ?? {},
        processedSigs: saved.processedSigs ?? [],
      };
      log.info(
        `restored: cash $${this.state.cashUsd.toFixed(2)}, ${Object.keys(this.state.positions).length} position(s), ` +
          `${Object.keys(this.state.lastSigByWallet).length} wallet cursor(s)`,
      );
    } catch {
      log.info("no snapshot found; starting fresh paper account");
    }
    try {
      const raw = await fs.readFile(this.ledgerFile, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          this.ledger.push(JSON.parse(t) as PaperTrade);
        } catch {
          /* skip corrupt line */
        }
      }
      log.info(`loaded ${this.ledger.length} ledger trade(s)`);
    } catch {
      /* no ledger yet */
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
    let dirty = false;
    for (const ev of events) {
      const key = `${ev.wallet}:${ev.signature}`;
      if (this.state.processedSigs.includes(key)) continue;
      this.state.processedSigs.push(key);
      if (this.state.processedSigs.length > PROCESSED_SIG_RING_SIZE) {
        this.state.processedSigs.splice(0, this.state.processedSigs.length - PROCESSED_SIG_RING_SIZE);
      }
      try {
        await this.handleTrade(ev);
      } catch (err) {
        log.error(`handleTrade ${short(ev.wallet)} ${ev.mint.slice(0, 8)} failed: ${String(err)}`);
      }
      dirty = true;
    }
    if (dirty) await this.save();
  }

  private async handleTrade(ev: TradeEvent): Promise<void> {
    const info = await this.pair(ev.mint);
    const price = info?.priceUsd ?? 0;
    if (!price) {
      log.warn(`no price for ${ev.mint.slice(0, 8)}…; skipped ${ev.side}`);
      return;
    }
    const walletNotional = ev.tokenDelta * price;
    if (ev.side === "buy") await this.copyBuy(ev, price, info?.symbol ?? ev.mint.slice(0, 6), walletNotional);
    else await this.copySell(ev, price, info?.symbol ?? ev.mint.slice(0, 6), walletNotional);
  }

  private async copyBuy(
    ev: TradeEvent,
    price: number,
    symbol: string,
    walletNotional: number,
  ): Promise<void> {
    if (walletNotional < this.opts.minWalletTradeUsd) {
      log.info(
        `skip dust buy: ${short(ev.wallet)} ${symbol} notional $${walletNotional.toFixed(2)} < $${this.opts.minWalletTradeUsd}`,
      );
      return;
    }
    const ourUsd = (walletNotional * this.opts.clipPct) / 100;
    const key = `${ev.wallet}:${ev.mint}`;
    const existing = this.state.positions[key];

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
      `BUY ${symbol}: ${short(ev.wallet)} spent ~$${walletNotional.toFixed(0)} -> we clip $${ourUsd.toFixed(2)} ` +
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
    if (pos.qty * fillPrice < 0.01) delete this.state.positions[key];
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

  // ── stop-loss marking ────────────────────────────────────────

  /** Re-mark every open position; force-close anything past the stop loss. */
  async markAll(): Promise<void> {
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

  private async forceClose(pos: Position, reason: string): Promise<void> {
    const info = await this.pair(pos.mint);
    const fillPrice = (info?.priceUsd ?? 0) * (1 - this.opts.exitSlippagePct / 100);
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
    log.warn(
      `STOP-LOSS ${pos.symbol}: exited for $${proceeds.toFixed(2)} (PnL $${pnlUsd.toFixed(2)} / ${pnlPct.toFixed(1)}%), ` +
        `cash $${this.state.cashUsd.toFixed(2)}`,
    );
    await this.notifier.send(
      `TRADE CLOSED — STOP LOSS ${pos.symbol}\n` +
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

    const wallets = new Set<string>([...acc.keys(), ...Object.values(this.state.positions).map((p) => p.wallet)]);
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
