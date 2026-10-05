/**
 * Self-test: feeds synthetic transactions through the decoder and the paper
 * engine, simulating a full copy-trade lifecycle (entry sizing, dust filter,
 * partial/full exits, stop loss, rankings). Run: npm run selftest
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAMPORTS_PER_SOL } from "./copybot/constants.js";
import { extractTrades } from "./copybot/decoder.js";
import { PaperEngine } from "./copybot/paper.js";
import type { NotifierLike } from "./copybot/notifier.js";
import type { JsonTransaction, JsonTokenBalance } from "./copybot/rpc.js";
import { WalletWatcher } from "./copybot/watcher.js";
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
  tokens?: Array<{ mint: string; pre: number; post: number }>;
}

function makeTx(opts: TxOpts): JsonTransaction {
  const keys = [{ pubkey: WALLET, signer: true, writable: true }];
  for (const p of opts.programs ?? []) keys.push({ pubkey: p, signer: false, writable: false });
  const pre = 5 * LAMPORTS_PER_SOL;
  const post = pre + (opts.solDeltaLamports ?? 0);
  const tb = (which: "pre" | "post"): JsonTokenBalance[] =>
    (opts.tokens ?? []).map((t) => ({
      accountIndex: 2,
      mint: t.mint,
      owner: WALLET,
      tokenAmount: { uiAmount: which === "pre" ? t.pre : t.post, decimals: 6 },
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
    pairProvider: async (mint) => prices.get(mint) ?? null,
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
    notifier,
  });
  await engine2.load();
  expect(engine2.ledger.length === engine.ledger.length, "ledger rebuilt from disk on restart");
  expect(engine2.state.processedSigs.includes(`${WALLET}:E1`), "processed-sig dedup survives restart");

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

  await fs.rm(dataDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
