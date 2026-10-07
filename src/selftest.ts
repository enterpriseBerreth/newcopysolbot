/**
 * Self-test: feeds synthetic transactions through the decoder and the paper
 * engine, simulating a full copy-trade lifecycle (entry sizing, dust filter,
 * partial/full exits, stop loss, rankings). Run: npm run selftest
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAMPORTS_PER_SOL } from "./copybot/constants.js";
import { classifySignatures, type SignatureRow } from "./copybot/botwatch.js";
import { extractTrades } from "./copybot/decoder.js";
import { PaperEngine, splitShadowEvents } from "./copybot/paper.js";
import type { NotifierLike } from "./copybot/notifier.js";
import type { JsonTransaction, JsonTokenBalance } from "./copybot/rpc.js";
import { sleep } from "./copybot/rpc.js";
import { WalletWatcher, short } from "./copybot/watcher.js";
import { WsTradeWatcher } from "./copybot/ws.js";
import type { WsLike, WsFactory } from "./copybot/ws.js";
import type { PairInfo, TradeEvent } from "./copybot/types.js";

let passed = 0;
let failed = 0;

function expect(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ok: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

const WALLET = "CopyTestWallet1111111111111111111111111111111";
const SPAM_WALLET = "SpamWallet111111111111111111111111111111111";
const DEX = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT_A = "TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_B = "TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

interface TxOpts {
  sig?: string;
  err?: unknown;
  programs?: string[];
  solDeltaLamports?: number;
  feeLamports?: number;
  wallet?: string;
  tokens?: Array<{ mint: string; pre: number; post: number }>;
}

function makeTx(opts: TxOpts): JsonTransaction {
  const owner = opts.wallet ?? WALLET;
  const keys = [{ pubkey: owner, signer: true, writable: true }];
  for (const p of opts.programs ?? []) keys.push({ pubkey: p, signer: false, writable: false });
  const pre = 5 * LAMPORTS_PER_SOL;
  const post = pre + (opts.solDeltaLamports ?? 0);
  const tb = (which: "pre" | "post"): JsonTokenBalance[] =>
    (opts.tokens ?? []).map((t) => ({
      accountIndex: 2,
      mint: t.mint,
      owner,
      uiTokenAmount: { uiAmount: which === "pre" ? t.pre : t.post, uiAmountString: String(which === "pre" ? t.pre : t.post), decimals: 6 },
    }));
  return {
    blockTime: Math.floor(Date.now() / 1000),
    slot: 1,
    transaction: { message: { accountKeys: keys }, signatures: [opts.sig ?? "SIG"] },
    meta: {
      err: opts.err ?? null,
      fee: opts.feeLamports ?? 5000,
      preBalances: [pre, 1e9],
      postBalances: [post, 1e9],
      preTokenBalances: tb("pre"),
      postTokenBalances: tb("post"),
    },
  };
}

async function main(): Promise<void> {
  console.log("── decoder ──");

  const buyTx = makeTx({
    sig: "BUYSIG",
    programs: [DEX],
    solDeltaLamports: -1.2 * LAMPORTS_PER_SOL,
    tokens: [{ mint: MINT_A, pre: 0, post: 100 }],
  });
  const buyEvents = extractTrades(buyTx, WALLET);
  expect(buyEvents.length === 1, "buy tx yields exactly one event");
  const b = buyEvents[0]!;
  expect(b.side === "buy" && b.mint === MINT_A, "buy event has right side + mint");
  expect(approx(b.tokenDelta, 100), "buy tokenDelta = 100");
  expect(approx(b.remainingTokens, 100), "buy remainingTokens = 100");
  expect(buyTx.meta?.postTokenBalances?.[0]?.uiTokenAmount?.uiAmountString === "100", "decoder fixture uses live RPC uiTokenAmount shape");

  const realisticUsdcBuy = makeTx({
    sig: "USDCBUY",
    programs: [DEX],
    tokens: [
      { mint: MINT_A, pre: 34313184.415534, post: 34470574.116279 },
      { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", pre: 138.773707, post: 0.38 },
    ],
  });
  expect(
    extractTrades(realisticUsdcBuy, WALLET).length === 1 &&
    approx(extractTrades(realisticUsdcBuy, WALLET)[0]!.tokenDelta, 157389.700745, 1e-5),
    "live-shaped USDC buy decodes token balance difference",
  );

  const partialSellTx = makeTx({
    sig: "SELLSIG",
    programs: [DEX],
    solDeltaLamports: 0.5 * LAMPORTS_PER_SOL,
    tokens: [{ mint: MINT_A, pre: 100, post: 60 }],
  });
  const sellEvents = extractTrades(partialSellTx, WALLET);
  expect(sellEvents.length === 1 && sellEvents[0]!.side === "sell", "sell detected");
  expect(approx(sellEvents[0]!.tokenDelta, 40), "sell tokenDelta = 40");
  expect(approx(sellEvents[0]!.remainingTokens, 60), "sell remaining = 60 (fraction = 40/100)");

  const transferTx = makeTx({
    sig: "TRANSFERSIG",
    programs: [TOKEN_PROGRAM],
    tokens: [{ mint: MINT_A, pre: 0, post: 5000 }],
  });
  expect(extractTrades(transferTx, WALLET).length === 0, "plain transfer (no DEX program) is not copied");

  const failedTx = makeTx({
    sig: "FAILEDSIG",
    err: { InstructionError: [0, 0] },
    programs: [DEX],
    tokens: [{ mint: MINT_A, pre: 0, post: 100 }],
  });
  expect(extractTrades(failedTx, WALLET).length === 0, "failed tx is not copied");

  const quoteTx = makeTx({
    sig: "QUOTESIG",
    programs: [DEX],
    tokens: [{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", pre: 0, post: 500 }],
  });
  expect(extractTrades(quoteTx, WALLET).length === 0, "stablecoin-only change is not copied");
  const multiTx = makeTx({
    sig: "MULTI",
    programs: [DEX],
    solDeltaLamports: -1e9,
    tokens: [{ mint: MINT_A, pre: 0, post: 100 }, { mint: MINT_B, pre: 0, post: 200 }],
  });
  const multiEvents = extractTrades(multiTx, WALLET);
  expect(multiEvents.length === 2 && multiEvents.every((event) => event.solDelta === 0), "multiple tokens cannot each claim the full SOL spend");

  console.log("── engine ──");

  const dataDir = path.join(os.tmpdir(), `copysol-selftest-${Date.now()}`);
  const prices = new Map<string, PairInfo>([
    [MINT_A, { priceUsd: 1, liquidityUsd: 1_000_000, symbol: "AAAA", dexId: "raydium", pairUrl: "" }],
    [MINT_B, { priceUsd: 0.5, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" }],
  ]);
  const sent: string[] = [];
  const notifier: NotifierLike = { send: async (t) => void sent.push(t) };
  const engine = new PaperEngine({
    startingBudgetUsd: 1000,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 40,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir,
    // The cap has a dedicated engine below; the shared lifecycle tests
    // top-up a position past the default multiple.
    topUpCostCapMultiple: 0,
    pairProvider: async (mint) => prices.get(mint) ?? null,
    solPriceProvider: async () => 10,
    notifier,
  });
  await engine.load();

  const ev = (over: Partial<TradeEvent>): TradeEvent => ({
    wallet: WALLET,
    signature: "SIGX",
    blockTime: Math.floor(Date.now() / 1000),
    mint: MINT_A,
    side: "buy",
    tokenDelta: 100,
    remainingTokens: 100,
    solDelta: 0,
    ...over,
  });

  // 1) Entry: wallet buys 100 AAAA @ $1 = $100 notional -> our clip $1, fill $1.01.
  await engine.onTrades([ev({ signature: "E1" })]);
  const pos1 = engine.state.positions[`${WALLET}:${MINT_A}`]!;
  expect(approx(engine.state.cashUsd, 999), "entry clip = $1 (1% of $100 notional)");
  expect(approx(pos1.qty, 1 / 1.01), "entry qty = clip / slipped price");
  expect(pos1.symbol === "AAAA", "position symbol set");
  expect(sent.length === 0, "no telegram alert on entry (closed trades only)");

  // 2) Dust: wallet buys 40 AAAA @ $1 = $40 notional < $50 -> skipped.
  const cashBefore = engine.state.cashUsd;
  await engine.onTrades([ev({ signature: "E2", tokenDelta: 40, remainingTokens: 140 })]);
  expect(approx(engine.state.cashUsd, cashBefore), "dust buy (< $50 wallet notional) skipped");

  // 3) Top-up: wallet buys 100 more @ $1 -> another $1 clip, qty adds.
  await engine.onTrades([ev({ signature: "E3", tokenDelta: 100, remainingTokens: 240 })]);
  const pos2 = engine.state.positions[`${WALLET}:${MINT_A}`]!;
  expect(approx(pos2.costUsd, 2, 1e-9), "top-up raises cost to $2");
  expect(approx(pos2.qty, 2 / 1.01), "top-up adds qty at new fill");

  // 4) Partial exit: wallet sells 60 of 240 (25%) -> we sell 25% of ours.
  prices.set(MINT_A, { priceUsd: 2, liquidityUsd: 1_000_000, symbol: "AAAA", dexId: "raydium", pairUrl: "" });
  await engine.onTrades([ev({ signature: "E4", side: "sell", tokenDelta: 60, remainingTokens: 180 })]);
  const pos3 = engine.state.positions[`${WALLET}:${MINT_A}`]!;
  expect(approx(pos3.qty, (2 / 1.01) * 0.75), "partial exit sells the mirrored 25% of our bag");
  const t4 = engine.ledger[engine.ledger.length - 1]!;
  expect(t4.side === "sell" && (t4.pnlUsd ?? 0) > 0, "partial exit books a profit (price doubled)");
  expect(approx(engine.state.cashUsd, 999 - 1 + t4.usd, 1e-6), "cash refilled by exit proceeds");

  // 5) Full exit: wallet sells everything remaining.
  await engine.onTrades([ev({ signature: "E5", side: "sell", tokenDelta: 180, remainingTokens: 0 })]);
  expect(!engine.state.positions[`${WALLET}:${MINT_A}`], "full exit removes position");
  const closeMsg = sent.find((m) => m.includes("TRADE CLOSED"));
  expect(
    !!closeMsg && closeMsg.includes(WALLET) && closeMsg.includes(MINT_A),
    "close alert carries full wallet + token address",
  );
  expect(!!closeMsg && closeMsg.includes("PnL:") && closeMsg.includes("Capital:"), "close alert carries PnL + capital before/after");
  const realizedSoFar = engine.ledger.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  expect(approx(engine.capital(), 1000 + realizedSoFar, 1e-6), "capital = budget + realized PnL (profits compound)");

  // 6) Stop loss: new entry, then price -45% -> markAll force-closes.
  prices.set(MINT_B, { priceUsd: 2, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
  await engine.onTrades([ev({ signature: "E6", mint: MINT_B, tokenDelta: 50, remainingTokens: 50 })]); // $100 notional
  prices.set(MINT_B, { priceUsd: 1.0, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" }); // -50%
  await engine.markAll();
  expect(!engine.state.positions[`${WALLET}:${MINT_B}`], "stop-loss (-40%) force-closes position");
  const sl = engine.ledger[engine.ledger.length - 1]!;
  expect(sl.reason === "stop-loss" && (sl.pnlUsd ?? 0) < 0, "stop-loss trade booked with reason + loss");

  // 6b) Realistic fills: wallet's actual price derived from the SOL leg (SOL = $10).
  prices.set(MINT_A, { priceUsd: 1, liquidityUsd: 1_000_000, symbol: "AAAA", dexId: "raydium", pairUrl: "" });
  // Wallet buys 100 tokens for 6 SOL ($60): derived fill $0.60, notional $60.
  await engine.onTrades([ev({ signature: "E7", solDelta: -6 })]);
  const pos7 = engine.state.positions[`${WALLET}:${MINT_A}`]!;
  expect(approx(pos7.costUsd, 0.6, 1e-9), "clip = 1% of wallet's real $60 SOL spend");
  expect(approx(pos7.qty, 0.6 / (0.6 * 1.01)), "entry fill = wallet's derived price + entry slippage");
  const t7 = engine.ledger[engine.ledger.length - 1]!;
  expect(approx(t7.priceUsd, 0.606), "ledger records wallet-derived entry price");
  // Wallet sells 40 tokens for 1.2 SOL ($12): derived exit fill $0.30.
  const qtyBeforeExit = pos7.qty;
  await engine.onTrades([ev({ signature: "E8", side: "sell", tokenDelta: 40, remainingTokens: 60, solDelta: 1.2 })]);
  const t8 = engine.ledger[engine.ledger.length - 1]!;
  expect(approx(t8.priceUsd, 0.3 * 0.99), "exit fill = wallet's derived price - exit slippage");
  expect(approx(t8.qty, qtyBeforeExit * 0.4), "exit still mirrors the sold fraction of the bag");
  // Implausible SOL attribution (derived 20x market) -> fall back to market price.
  await engine.onTrades([ev({ signature: "E9", tokenDelta: 100, remainingTokens: 160, solDelta: -200 })]);
  const t9 = engine.ledger[engine.ledger.length - 1]!;
  expect(approx(t9.priceUsd, 1.01), "derived fill 20x off market is rejected; market price used");

  // 7) Rankings + persistence.
  const rows = await engine.walletRankings();
  expect(rows.length === 1 && rows[0]!.wallet === WALLET, "rankings cover the traded wallet");
  expect(rows[0]!.dayTrades >= 5, "daily trade count reflects ledger");
  expect(rows[0]!.dayPos >= 2 && rows[0]!.dayNeg >= 1, "daily pos/neg breakdown counts wins and losses");
  const report = engine.formatRankings(rows);
  expect(report.includes("trades |") && report.includes("pos / "), "report lists trades with pos/neg split");
  await engine.save();
  const engine2 = new PaperEngine({
    startingBudgetUsd: 1000,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 40,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir,
    pairProvider: async (mint) => prices.get(mint) ?? null,
    solPriceProvider: async () => 10,
    notifier,
  });
  await engine2.load();
  expect(engine2.ledger.length === engine.ledger.length, "ledger rebuilt from disk on restart");
  expect(engine2.state.processedSigs.includes(`${WALLET}:E1:${MINT_A}`), "processed trade dedup survives restart");
  const ledgerCount = engine2.ledger.length;
  await engine2.onTrades([ev({ signature: "E1" })]);
  expect(engine2.ledger.length === ledgerCount, "replayed wallet/mint trade cannot double-spend after restart");
  await engine2.onTrades(multiEvents);
  expect(engine2.state.processedSigs.includes(`${WALLET}:MULTI:${MINT_A}`) && engine2.state.processedSigs.includes(`${WALLET}:MULTI:${MINT_B}`), "all token mints in one signature are processed");

  // 8) Budget guard: a buy the account cannot afford is skipped entirely.
  const poorSent: string[] = [];
  const poorDir = `${dataDir}-poor`;
  const poorEngine = new PaperEngine({
    startingBudgetUsd: 0.5,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 100,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir: poorDir,
    trackedWallets: [WALLET, "InactiveWallet"],
    pairProvider: async (mint) => prices.get(mint) ?? null,
    solPriceProvider: async () => 10,
    notifier: { send: async (t) => void poorSent.push(t) },
  });
  await poorEngine.load();
  await poorEngine.onTrades([ev({ signature: "P1" })]); // $100 notional -> $1 clip > $0.50 cash
  expect(!poorEngine.state.positions[`${WALLET}:${MINT_A}`], "unaffordable buy is skipped entirely");
  expect(approx(poorEngine.state.cashUsd, 0.5, 1e-9), "cash untouched when skipping unaffordable buy");
  expect(poorSent.length === 0, "no alert for skipped entry");
  expect((await poorEngine.walletRankings()).length === 2, "rankings include wallets with no paper trades");
  const tinyDir = `${dataDir}-tiny`;
  const tinyEngine = new PaperEngine({
    startingBudgetUsd: 100,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 100,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir: tinyDir,
    pairProvider: async (mint) => prices.get(mint) ?? null,
    solPriceProvider: async () => 10,
  });
  await tinyEngine.load();
  await tinyEngine.onTrades([ev({ signature: "TINY_BUY" })]);
  await tinyEngine.onTrades([ev({ signature: "TINY_SELL", side: "sell", tokenDelta: 99.999, remainingTokens: 0.001 })]);
  expect(Boolean(tinyEngine.state.positions[`${WALLET}:${MINT_A}`]), "tiny residual after partial exit retains cost basis");
  const tinyPnl = tinyEngine.ledger.reduce((sum, trade) => sum + (trade.pnlUsd ?? 0), 0);
  expect(approx(tinyEngine.capital(), 100 + tinyPnl), "partial exits preserve the capital accounting invariant");

  const manualDir = `${dataDir}-manual`;
  const manualPrices = new Map(prices);
  manualPrices.set(MINT_B, { priceUsd: 1, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
  const manualAlerts: string[] = [];
  const manualOpts = {
    startingBudgetUsd: 100,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 100,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir: manualDir,
    pairProvider: async (mint: string) => manualPrices.get(mint) ?? null,
    solPriceProvider: async () => 10,
    notifier: { send: async (text: string) => void manualAlerts.push(text) },
  };
  const manual = new PaperEngine(manualOpts);
  await manual.load();
  await manual.onTrades([ev({ signature: "MANUAL_A", mint: MINT_A })]);
  await manual.onTrades([ev({ signature: "MANUAL_B", mint: MINT_B })]);
  manualPrices.set(MINT_A, { priceUsd: 2, liquidityUsd: 1_000_000, symbol: "AAAA", dexId: "raydium", pairUrl: "" });
  manualPrices.delete(MINT_B);
  const firstClose = await manual.closeAll("close-1");
  expect(firstClose.closed === 1 && firstClose.skipped === 1 && Object.keys(manual.state.positions).length === 1, "manual close sells priced positions and leaves unpriced positions open");
  expect(manual.ledger.filter((trade) => trade.reason === "manual close").length === 1 && Boolean(manualAlerts[0]?.includes("TRADE CLOSED — MANUAL CLOSE")), "manual close records sale and sends closed-trade alert");
  const restoredManual = new PaperEngine(manualOpts);
  await restoredManual.load();
  await restoredManual.closeAll("close-1");
  expect(restoredManual.ledger.filter((trade) => trade.reason === "manual close").length === 1 && restoredManual.state.lastManualCloseId === "close-1", "manual close cannot repeat after restart with the same operation id");
  manualPrices.set(MINT_B, { priceUsd: 0.5, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
  const secondClose = await restoredManual.closeAll("close-2");
  const manualPnl = restoredManual.ledger.reduce((sum, trade) => sum + (trade.pnlUsd ?? 0), 0);
  expect(secondClose.closed === 1 && secondClose.skipped === 0 && Object.keys(restoredManual.state.positions).length === 0, "new operation id closes previously unpriced position");
  expect(approx(restoredManual.capital(), 100 + manualPnl) && manualAlerts.length === 2, "manual liquidation reconciles cash and notifies for both winning and losing closes");

  const shadowDir = `${dataDir}-shadow`;
  const shadowAlerts: string[] = [];
  const shadowEngine = new PaperEngine({
    startingBudgetUsd: 1000,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 100,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir: shadowDir,
    trackedWallets: [WALLET],
    shadowWallets: [WALLET],
    pairProvider: async (mint) => prices.get(mint) ?? null,
    solPriceProvider: async () => 10,
    notifier: { send: async (t) => void shadowAlerts.push(t) },
  });
  await shadowEngine.load();
  await shadowEngine.onTrades([ev({ signature: "SHADOW_BUY" })]);
  expect(!shadowEngine.state.positions[`${WALLET}:${MINT_A}`] && approx(shadowEngine.state.cashUsd, 1000), "shadow wallet buy deploys no capital");
  expect(shadowEngine.ledger.length === 0 && shadowEngine.shadowTradesSkipped === 1, "shadow wallet trade is counted but not ledgered");
  await shadowEngine.onTrades([ev({ signature: "SHADOW_SELL", side: "sell", tokenDelta: 100, remainingTokens: 0 })]);
  expect(shadowEngine.ledger.length === 0 && shadowAlerts.length === 0, "shadow wallet sell is ignored without position");
  const shadowRows = await shadowEngine.walletRankings();
  expect(shadowRows.length === 1 && shadowRows[0]!.dayTrades === 0, "shadow wallet stays in rankings with zero activity");

  console.log("── risk gates ──");

  const MINT_C = "TokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const gateAlerts: string[] = [];
  const baseGateOpts = (dir: string) => ({
    startingBudgetUsd: 1000,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 100,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir: dir,
    trackedWallets: [WALLET],
    pairProvider: async (mint: string) => gatePrices.get(mint) ?? null,
    solPriceProvider: async () => 10,
    notifier: { send: async (t: string) => void gateAlerts.push(t) } satisfies NotifierLike,
  });

  // PnL kill-switch: ten losing buy->sell rounds trip the threshold, a
  // profitable exit on a held position auto-re-enables the wallet.
  const gatePrices = new Map<string, PairInfo>(prices);
  const killEngine = new PaperEngine({ ...baseGateOpts(`${dataDir}-kill`), killSwitchPnlUsd: -5, killSwitchMinSells: 0 });
  await killEngine.load();
  await killEngine.onTrades([ev({ signature: "K-A1" })]);
  for (let i = 0; i < 10; i++) {
    gatePrices.set(MINT_B, { priceUsd: 1, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
    await killEngine.onTrades([ev({ signature: `K-B${i}`, mint: MINT_B })]);
    gatePrices.set(MINT_B, { priceUsd: 0.5, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
    await killEngine.onTrades([ev({ signature: `K-BS${i}`, mint: MINT_B, side: "sell", tokenDelta: 100, remainingTokens: 0 })]);
  }
  const killPnl = killEngine.ledger.filter((t) => t.side === "sell").reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  expect(killPnl <= -5, `ten losing rounds push wallet past the kill threshold (realized ${killPnl.toFixed(2)})`);
  const killCash = killEngine.state.cashUsd;
  const killBuys = killEngine.ledger.filter((t) => t.side === "buy").length;
  await killEngine.onTrades([ev({ signature: "K-BLOCKED", mint: MINT_B })]);
  expect(killEngine.ledger.filter((t) => t.side === "buy").length === killBuys && approx(killEngine.state.cashUsd, killCash), "killed wallet cannot open new positions");
  gatePrices.set(MINT_A, { priceUsd: 10, liquidityUsd: 1_000_000, symbol: "AAAA", dexId: "raydium", pairUrl: "" });
  await killEngine.onTrades([ev({ signature: "K-AS1", side: "sell", tokenDelta: 100, remainingTokens: 0 })]);
  expect(!killEngine.isKilled(WALLET), "wallet auto-re-enables after realized PnL recovers");
  await killEngine.onTrades([ev({ signature: "K-REENTRY", mint: MINT_B })]);
  expect(killEngine.ledger.some((t) => t.side === "buy" && t.mint === MINT_B && t.signature === "K-REENTRY"), "re-enabled wallet can buy again");

  // Win-rate kill: >= min sells, negative PnL, win rate below max.
  const wrPrices = new Map<string, PairInfo>(prices);
  const wrEngine = new PaperEngine({
    ...baseGateOpts(`${dataDir}-winrate`),
    killSwitchPnlUsd: -1000,
    killSwitchMinSells: 3,
    killSwitchMaxWinRate: 0.5,
    pairProvider: async (mint: string) => wrPrices.get(mint) ?? null,
  });
  await wrEngine.load();
  for (let i = 0; i < 3; i++) {
    wrPrices.set(MINT_B, { priceUsd: 1, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
    await wrEngine.onTrades([ev({ signature: `W-B${i}`, mint: MINT_B })]);
    wrPrices.set(MINT_B, { priceUsd: 0.99, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
    await wrEngine.onTrades([ev({ signature: `W-BS${i}`, mint: MINT_B, side: "sell", tokenDelta: 100, remainingTokens: 0 })]);
  }
  expect(wrEngine.isKilled(WALLET), "wallet with 0% win rate over the sell minimum is killed");
  const wrBuys = wrEngine.ledger.filter((t) => t.side === "buy").length;
  await wrEngine.onTrades([ev({ signature: "W-BLOCKED", mint: MINT_B })]);
  expect(wrEngine.ledger.filter((t) => t.side === "buy").length === wrBuys, "win-rate-killed wallet cannot open positions");
  expect(wrEngine.killSwitchedWallets().includes(short(WALLET)), "killSwitchedWallets reports the killed wallet");

  // Liquidity floor.
  const liqPrices = new Map<string, PairInfo>(prices);
  const liqEngine = new PaperEngine({
    ...baseGateOpts(`${dataDir}-liq`),
    liquidityFloorUsd: 10_000,
    pairProvider: async (mint: string) => liqPrices.get(mint) ?? null,
  });
  await liqEngine.load();
  liqPrices.set(MINT_C, { priceUsd: 1, liquidityUsd: 5_000, symbol: "CCCC", dexId: "raydium", pairUrl: "" });
  await liqEngine.onTrades([ev({ signature: "L-LOW", mint: MINT_C })]);
  expect(!liqEngine.state.positions[`${WALLET}:${MINT_C}`], "buy into token below the liquidity floor is skipped");
  liqPrices.set(MINT_C, { priceUsd: 1, liquidityUsd: 50_000, symbol: "CCCC", dexId: "raydium", pairUrl: "" });
  await liqEngine.onTrades([ev({ signature: "L-OK", mint: MINT_C })]);
  expect(Boolean(liqEngine.state.positions[`${WALLET}:${MINT_C}`]), "buy into token above the liquidity floor proceeds");

  // Top-up cap: accumulated cost may reach but not exceed cap x first clip.
  const capPrices = new Map<string, PairInfo>(prices);
  const capEngine = new PaperEngine({
    ...baseGateOpts(`${dataDir}-cap`),
    topUpCostCapMultiple: 2,
    pairProvider: async (mint: string) => capPrices.get(mint) ?? null,
  });
  await capEngine.load();
  await capEngine.onTrades([ev({ signature: "C-1" })]);
  await capEngine.onTrades([ev({ signature: "C-2", tokenDelta: 100, remainingTokens: 200 })]);
  expect(approx(capEngine.state.positions[`${WALLET}:${MINT_A}`]!.costUsd, 2, 1e-9), "top-up reaching exactly the cap multiple is allowed");
  await capEngine.onTrades([ev({ signature: "C-3", tokenDelta: 100, remainingTokens: 300 })]);
  expect(approx(capEngine.state.positions[`${WALLET}:${MINT_A}`]!.costUsd, 2, 1e-9), "top-up beyond the cap multiple is skipped");
  expect(capEngine.ledger.some((t) => t.side === "buy" && t.signature === "C-2") && !capEngine.ledger.some((t) => t.side === "buy" && t.signature === "C-3"), "only cap-compliant top-ups are ledgered");

  console.log("── watcher cursor ──");

  const fetched: TradeEvent[] = [];
  const fakeRpc = {
    async getSignaturesForAddress(_w: string, limit: number) {
      return [
        { signature: "S3", slot: 3, blockTime: 3, err: null },
        { signature: "S2", slot: 2, blockTime: 2, err: null },
        { signature: "S1", slot: 1, blockTime: 1, err: null },
      ].slice(0, limit);
    },
    async getTransaction(sig: string) {
      if (sig === "S2") return makeTx({ sig, programs: [DEX], tokens: [{ mint: MINT_A, pre: 0, post: 100 }] });
      return makeTx({ sig, programs: [TOKEN_PROGRAM], tokens: [{ mint: MINT_A, pre: 0, post: 1 }] });
    },
  };
  const watcher = new WalletWatcher(
    fakeRpc as never,
    [WALLET],
    async (events) => void fetched.push(...events),
    1000,
    { [WALLET]: "S1" },
  );
  await (watcher as unknown as { pollWallet(w: string): Promise<void> }).pollWallet(WALLET);
  expect(fetched.length === 1 && fetched[0]!.signature === "S2", "cursor skips already-seen sigs, processes only S2");
  expect(fetched[0]!.side === "buy", "watcher emitted decoded buy from S2");
  let failOnce = true;
  const cursor = { [WALLET]: "S1" };
  const retryWatcher = new WalletWatcher(
    {
      getSignaturesForAddress: fakeRpc.getSignaturesForAddress,
      async getTransaction(sig: string) {
        if (sig === "S2" && failOnce) {
          failOnce = false;
          throw new Error("temporary rate limit");
        }
        return fakeRpc.getTransaction(sig);
      },
    } as never,
    [WALLET],
    async () => {},
    1000,
    cursor,
  );
  try {
    await (retryWatcher as unknown as { pollWallet(w: string): Promise<void> }).pollWallet(WALLET);
  } catch {}
  expect(cursor[WALLET] === "S1", "failed transaction does not advance wallet cursor");
  await (retryWatcher as unknown as { pollWallet(w: string): Promise<void> }).pollWallet(WALLET);
  expect(cursor[WALLET] === "S3", "retry processes failed transaction and advances cursor");

  console.log("── ws push watcher ──");

  // Fake WS: capture the created instance so the test can drive its lifecycle.
  let wsInstance: WsLike | null = null;
  const sentFrames: string[] = [];
  const fakeWsFactory: WsFactory = () => {
    const obj: WsLike = {
      send: (data) => void sentFrames.push(data),
      close: () => {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    wsInstance = obj;
    return obj;
  };
  const wsFetched: TradeEvent[] = [];
  let batchCalls = 0;
  const batchSizes: number[] = [];
  const wsRpc = {
    async getTransaction(sig: string) {
      if (sig.startsWith("WSBUY")) return makeTx({ sig, programs: [DEX], tokens: [{ mint: MINT_A, pre: 0, post: 100 }] });
      if (sig.startsWith("SHADOWS")) return makeTx({ sig, programs: [DEX], tokens: [{ mint: MINT_B, pre: 0, post: 1 }] });
      if (sig.startsWith("SPAMS")) return makeTx({ sig, wallet: SPAM_WALLET, programs: [DEX], tokens: [{ mint: MINT_A, pre: 0, post: 100 }] });
      if (sig === "WSFAIL") return makeTx({ sig, err: { InstructionError: [0, 0] }, programs: [DEX] });
      return null;
    },
    async getTransactions(signatures: string[]) {
      batchCalls++;
      batchSizes.push(signatures.length);
      await sleep(5);
      return Promise.all(signatures.map((sig) => this.getTransaction(sig)));
    },
  };
  const wsWatcher = new WsTradeWatcher(
    "wss://fake",
    wsRpc as never,
    [WALLET],
    async (events) => void wsFetched.push(...events),
    fakeWsFactory,
  );
  wsWatcher.start();
  expect(!!wsInstance, "fake ws instance created");
  wsInstance!.onopen!();
  expect(sentFrames.length === 1 && sentFrames[0]!.includes("logsSubscribe") && sentFrames[0]!.includes(WALLET), "subscribes tracked wallets via mentions on open");
  wsInstance!.onmessage!({ data: JSON.stringify({ id: 1, result: 123 }) });
  expect(wsWatcher.healthy, "confirmed subscription makes WebSocket healthy");
  // Failed tx notification -> ignored.
  wsInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { result: { value: { signature: "WSFAIL", err: { e: 1 } } } } }) });
  // Real buy notification -> fetched + decoded.
  wsInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { result: { value: { signature: "WSBUY", err: null } } } }) });
  // Duplicate of the same signature -> deduped in the queue.
  wsInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { result: { value: { signature: "WSBUY", err: null } } } }) });
  await sleep(100);
  expect(wsFetched.length === 1 && wsFetched[0]!.signature === "WSBUY" && wsFetched[0]!.side === "buy", "ws push decodes the trade and dedups duplicate notifications");
  expect(batchCalls === 1 && wsWatcher.fetchedTransactions === 1, "ws transaction processing uses batched RPC fetch");
  for (const sig of ["WSBUY2", "WSBUY3", "WSBUY4"]) {
    wsInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { result: { value: { signature: sig, err: null } } } }) });
  }
  await sleep(100);
  expect(wsFetched.length === 4 && batchSizes.join(",") === "1,1,2" && wsWatcher.pending === 0, `ws fetches queued transactions in batches and drains them (${batchSizes.join(",")})`);
  wsWatcher.stop();

  console.log("── ws shadow sampling ──");

  let wsShadowInstance: WsLike | null = null;
  const shadowWsFactory: WsFactory = () => {
    const obj: WsLike = {
      send: () => {},
      close: () => {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    wsShadowInstance = obj;
    return obj;
  };
  const shadowWsWatcher = new WsTradeWatcher(
    "wss://fake",
    wsRpc as never,
    [WALLET],
    async (events) => void wsFetched.push(...events),
    shadowWsFactory,
    [WALLET],
  );
  shadowWsWatcher.start();
  wsShadowInstance!.onopen!();
  // Request id 1 -> confirmation carries the server-assigned subscription id 900.
  wsShadowInstance!.onmessage!({ data: JSON.stringify({ id: 1, result: 900 }) });
  expect(shadowWsWatcher.healthy, "shadow watcher subscription confirmed");
  wsShadowInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { subscription: 900, result: { value: { signature: "SHADOWS1", err: null } } } }) });
  wsShadowInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { subscription: 900, result: { value: { signature: "SHADOWS2", err: null } } } }) });
  wsShadowInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { subscription: 900, result: { value: { signature: "SHADOWS3", err: null } } } }) });
  await sleep(120);
  expect(wsFetched.filter((e) => e.signature === "SHADOWS1").length === 1, "first shadow notification sampled and fetched");
  expect(wsFetched.filter((e) => e.signature === "SHADOWS2" || e.signature === "SHADOWS3").length === 0 && shadowWsWatcher.shadowDroppedNotifications === 2, "subsequent shadow notifications within the sample window are dropped");
  shadowWsWatcher.stop();

  console.log("── ws spam sampling ──");

  const SPAM = SPAM_WALLET;
  let wsSpamInstance: WsLike | null = null;
  const spamWsFactory: WsFactory = () => {
    const obj: WsLike = {
      send: () => {},
      close: () => {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    wsSpamInstance = obj;
    return obj;
  };
  const spamWsWatcher = new WsTradeWatcher(
    "wss://fake",
    wsRpc as never,
    [SPAM],
    async (events) => void wsFetched.push(...events),
    spamWsFactory,
    [],
    [SPAM],
  );
  spamWsWatcher.start();
  wsSpamInstance!.onopen!();
  wsSpamInstance!.onmessage!({ data: JSON.stringify({ id: 1, result: 700 }) });
  wsSpamInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { subscription: 700, result: { value: { signature: "SPAMS1", err: null } } } }) });
  wsSpamInstance!.onmessage!({ data: JSON.stringify({ method: "logsNotification", params: { subscription: 700, result: { value: { signature: "SPAMS2", err: null } } } }) });
  await sleep(120);
  expect(wsFetched.filter((e) => e.signature === "SPAMS1").length === 1, "first spam-wallet notification sampled and fetched");
  expect(wsFetched.filter((e) => e.signature === "SPAMS2").length === 0 && spamWsWatcher.shadowDroppedNotifications === 1, "second spam-wallet notification within the window is dropped");
  spamWsWatcher.stop();

  console.log("── shadow sim ──");

  const simDir = `${dataDir}-simsim`;
  const simPrices = new Map(prices);
  const simEngine = new PaperEngine({
    startingBudgetUsd: 10_000,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 100,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir: simDir,
    trackedWallets: [WALLET],
    liquidityFloorUsd: 25_000,
    topUpCostCapMultiple: 2,
    killSwitchPnlUsd: 0,
    killSwitchMinSells: 0,
    pairProvider: async (mint) => simPrices.get(mint) ?? null,
    solPriceProvider: async () => 10,
  });
  await simEngine.load();

  const [simShadow, simRest] = splitShadowEvents([ev({ signature: "SIM_BUY" })], new Set([WALLET]));
  expect(simShadow.length === 1 && simRest.length === 0, "splitShadowEvents routes shadow wallet events to the sim lane");
  await simEngine.onTrades(simShadow);
  expect(Boolean(simEngine.state.positions[`${WALLET}:${MINT_A}`]) && approx(simEngine.state.cashUsd, 10_000 - 1), "shadow sim deploys virtual capital on a copied entry");
  const [simNone, simLive] = splitShadowEvents([ev({ signature: "LIVE_BUY", wallet: "LiveWallet1111111111111111111111111111" })], new Set([WALLET]));
  expect(simNone.length === 0 && simLive.length === 1, "splitShadowEvents routes non-shadow events to the live lane");

  simPrices.set(MINT_A, { priceUsd: 2, liquidityUsd: 1_000_000, symbol: "AAAA", dexId: "raydium", pairUrl: "" });
  await simEngine.onTrades([ev({ signature: "SIM_SELL", side: "sell", tokenDelta: 100, remainingTokens: 0 })]);
  const simRealized = simEngine.ledger.filter((t) => t.side === "sell").reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  expect(simRealized > 0 && approx(simEngine.capital(), 10_000 + simRealized, 1e-6), "shadow sim books realized PnL into its virtual capital");

  // Kill switch disabled: a wallet below the default PnL threshold keeps trading.
  simPrices.set(MINT_B, { priceUsd: 1, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
  await simEngine.onTrades([ev({ signature: "SIM_LOSSBUY", mint: MINT_B })]);
  simPrices.set(MINT_B, { priceUsd: 0.1, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
  await simEngine.onTrades([ev({ signature: "SIM_LOSSELL", mint: MINT_B, side: "sell", tokenDelta: 50, remainingTokens: 0 })]);
  simPrices.set(MINT_B, { priceUsd: 1, liquidityUsd: 500_000, symbol: "BBBB", dexId: "pumpfun", pairUrl: "" });
  await simEngine.onTrades([ev({ signature: "SIM_REBUY", mint: MINT_B })]);
  expect(simEngine.ledger.some((t) => t.side === "buy" && t.signature === "SIM_REBUY"), "shadow sim keeps trading with the kill switch disabled");

  const simRows = await simEngine.walletRankings();
  const simRow = simRows.find((r) => r.wallet === WALLET)!;
  simRow.simPnlUsd = simRealized;
  simRow.simTrades = 2;
  simRow.simWins = 1;
  simRow.simLosses = 1;
  simRow.simUnrealizedUsd = 0;
  const simReport = simEngine.formatRankings(simRows);
  expect(simReport.includes("sim:") && simReport.includes("sim trades") && simReport.includes("sim open"), "formatRankings renders the shadow-sim line when sim fields are present");
  const plainReport = simEngine.formatRankings(await engine.walletRankings());
  expect(!plainReport.includes("sim:"), "formatRankings omits the sim line for non-sim rows");

  console.log("── bot classification ──");

  const now = Math.floor(Date.now() / 1000);
  const botSigs: SignatureRow[] = Array.from({ length: 200 }, (_, i) => ({
    signature: `BOT${i}`,
    slot: i,
    blockTime: now - i,
    err: i % 5 === 0 ? null : { InstructionError: [0, 0] },
  }));
  const botVerdict = classifySignatures(SPAM_WALLET, botSigs);
  expect(botVerdict.botLike && botVerdict.failRate >= 0.5 && botVerdict.medianIntervalSec <= 2, "80% fail rate + 1s tx cadence classifies as bot-like");

  const humanSigs: SignatureRow[] = Array.from({ length: 20 }, (_, i) => ({
    signature: `HUM${i}`,
    slot: i,
    blockTime: now - i * 6 * 3600,
    err: i % 7 === 0 ? { InstructionError: [0, 0] } : null,
  }));
  const humanVerdict = classifySignatures(WALLET, humanSigs);
  expect(!humanVerdict.botLike && humanVerdict.reasons.length === 0, "low-frequency trading with few failures classifies as human");
  expect(classifySignatures(WALLET, []).sampled === 0 && !classifySignatures(WALLET, []).botLike, "wallet with no history is not flagged as a bot");

  console.log("── capital reset ──");

  const resetDir = `${dataDir}-reset`;
  const resetPrices = new Map(prices);
  const resetOpts = {
    startingBudgetUsd: 1000,
    clipPct: 1,
    minWalletTradeUsd: 50,
    maxPositions: 100,
    entrySlippagePct: 1,
    exitSlippagePct: 1,
    stopLossPct: 40,
    dataDir: resetDir,
    pairProvider: async (mint: string) => resetPrices.get(mint) ?? null,
    solPriceProvider: async () => 10,
  };
  const resetGen1 = new PaperEngine({ ...resetOpts, resetId: "reset-r1" });
  await resetGen1.load();
  await resetGen1.onTrades([ev({ signature: "R1" })]); // deploy $1
  expect(approx(resetGen1.state.cashUsd, 999), "reset engine starts at its budget and trades normally");
  await resetGen1.save();

  const resetGen2 = new PaperEngine({ ...resetOpts, resetId: "reset-r1" });
  await resetGen2.load();
  expect(approx(resetGen2.state.cashUsd, 999) && resetGen2.ledger.length === 1, "same reset id on restart preserves state");

  const resetGen3 = new PaperEngine({ ...resetOpts, resetId: "reset-r2" });
  await resetGen3.load();
  expect(approx(resetGen3.state.cashUsd, 1000) && resetGen3.ledger.length === 0, "new reset id archives state and starts fresh at the budget");
  await resetGen3.save();
  const resetGen4 = new PaperEngine({ ...resetOpts, resetId: "reset-r2" });
  await resetGen4.load();
  expect(approx(resetGen4.state.cashUsd, 1000) && resetGen4.ledger.length === 0, "reset id is idempotent: no re-archival on next boot");

  // Regression: a restart that only LOADS (crash/redeploy) must not drop the
  // reset marker — otherwise the next boot re-archives the live account.
  const resetGen5 = new PaperEngine({ ...resetOpts, resetId: "reset-r2" });
  await resetGen5.load();
  await resetGen5.onTrades([ev({ signature: "R2" })]);
  await resetGen5.save();
  const resetGen6 = new PaperEngine({ ...resetOpts, resetId: "reset-r2" });
  await resetGen6.load();
  await resetGen6.save(); // the load→save cycle that used to drop lastResetId
  const resetGen7 = new PaperEngine({ ...resetOpts, resetId: "reset-r2" });
  await resetGen7.load();
  expect(approx(resetGen7.state.cashUsd, 999) && resetGen7.ledger.length === 1, "load/save cycle preserves lastResetId: no spurious re-reset");

  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(`${dataDir}-poor`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-tiny`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-manual`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-shadow`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-kill`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-winrate`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-liq`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-cap`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-simsim`, { recursive: true, force: true });
  await fs.rm(`${dataDir}-reset`, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
