import { createLogger } from "../logger.js";
import type { SolRpc } from "./rpc.js";
import { sleep } from "./rpc.js";
import { short } from "./watcher.js";

const log = createLogger("botwatch");

export interface SignatureRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface BotSignals {
  wallet: string;
  short: string;
  sampled: number;
  windowHours: number;
  failRate: number;
  txPerHour: number;
  medianIntervalSec: number;
  botLike: boolean;
  reasons: string[];
}

/** Classify a wallet from its recent signature history.
 *  Bot-like when any of: majority of txs fail (MEV/failure farming),
 *  sustained throughput far beyond manual trading, or near-zero gaps
 *  between consecutive transactions. */
export function classifySignatures(wallet: string, sigs: SignatureRow[]): BotSignals {
  const base: BotSignals = {
    wallet,
    short: short(wallet),
    sampled: sigs.length,
    windowHours: 0,
    failRate: 0,
    txPerHour: 0,
    medianIntervalSec: 0,
    botLike: false,
    reasons: [],
  };
  if (sigs.length === 0) return base;

  const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === "number").sort((a, b) => a - b);
  const failRate = sigs.filter((s) => s.err != null).length / sigs.length;
  const windowHours = times.length >= 2 ? (times[times.length - 1]! - times[0]!) / 3600 : 0;
  const txPerHour = windowHours > 0 ? sigs.length / windowHours : 0;

  let medianIntervalSec = 0;
  if (times.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
    gaps.sort((a, b) => a - b);
    medianIntervalSec = gaps[Math.floor(gaps.length / 2)]!;
  }

  const signals: BotSignals = { ...base, windowHours, failRate, txPerHour, medianIntervalSec, reasons: [] };

  if (sigs.length >= 20 && failRate >= 0.5) signals.reasons.push(`${(failRate * 100).toFixed(0)}% of sampled txs failed`);
  if (txPerHour >= 100) signals.reasons.push(`${Math.round(txPerHour)} tx/hour sustained`);
  if (sigs.length >= 20 && medianIntervalSec <= 2) signals.reasons.push(`median ${medianIntervalSec.toFixed(2)}s between txs`);
  signals.botLike = signals.reasons.length > 0;
  return signals;
}

export async function analyzeWallet(rpc: SolRpc, wallet: string, sampleLimit = 1000): Promise<BotSignals | null> {
  try {
    const sigs = await rpc.getSignaturesForAddress(wallet, sampleLimit);
    return classifySignatures(wallet, sigs);
  } catch (err) {
    log.warn(`bot analysis for ${short(wallet)} failed: ${String(err)}`);
    return null;
  }
}

export interface BotRegistry {
  [wallet: string]: { analyzedAt: number; botLike: boolean };
}

/** Analyze every tracked wallet missing from the registry (i.e. newly added),
 *  send one Telegram alert naming the bot-like ones, and persist the registry
 *  so each wallet is only flagged once. */
export async function runBotCheck(
  rpc: SolRpc,
  wallets: string[],
  registry: BotRegistry,
  persist: (registry: BotRegistry) => Promise<void>,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  const pending = wallets.filter((w) => !registry[w]);
  if (pending.length === 0) return;
  log.info(`bot check: analyzing ${pending.length} new wallet(s)`);

  const results: BotSignals[] = [];
  for (const w of pending) {
    const signals = await analyzeWallet(rpc, w);
    if (signals) {
      results.push(signals);
      registry[w] = { analyzedAt: Date.now(), botLike: signals.botLike };
    }
    await sleep(300);
  }
  await persist(registry);

  const bots = results.filter((r) => r.botLike);
  if (bots.length > 0) {
    const lines = [
      `BOT-WALLET CHECK — ${bots.length} bot-like wallet(s) detected among ${results.length} newly added`,
      "",
      ...bots.map(
        (b) =>
          `${b.short}: ${b.sampled} txs sampled` +
          (b.windowHours > 0 ? `, ${Math.round(b.txPerHour)} tx/hr over ${b.windowHours.toFixed(1)}h` : "") +
          `, ${(b.failRate * 100).toFixed(0)}% failed` +
          (b.medianIntervalSec > 0 ? `, median gap ${b.medianIntervalSec.toFixed(2)}s` : "") +
          `\n  signals: ${b.reasons.join("; ")}`,
      ),
      "",
      "Bot-like wallets copy poorly (their edge is latency, not strategy) — consider shadow mode instead of capital.",
    ];
    await notify(lines.join("\n"));
    log.warn(`bot check: ${bots.length}/${results.length} wallet(s) flagged as bot-like; alert sent`);
  } else {
    log.info(`bot check: ${results.length} wallet(s) analyzed, none bot-like`);
  }
}
