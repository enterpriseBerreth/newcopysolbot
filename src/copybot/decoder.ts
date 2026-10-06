import { DEX_PROGRAMS, LAMPORTS_PER_SOL, QUOTE_MINTS } from "./constants.js";
import type { JsonTransaction, JsonTokenBalance } from "./rpc.js";
import type { TradeEvent } from "./types.js";

/**
 * Extract copyable trades from a transaction using balance diffs:
 * any mint whose balance changed for the tracked wallet is a trade event.
 * This works across every DEX / aggregator (Raydium, Pump.fun, Jupiter, ...)
 * without per-DEX instruction parsing.
 *
 * Transfers (airdrops, payments) are filtered out: they contain no DEX
 * program at the top level of the transaction.
 */
export function extractTrades(tx: JsonTransaction, wallet: string): TradeEvent[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];

  const keys = [
    ...tx.transaction.message.accountKeys.map((k) => k.pubkey),
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const touchesDex = keys.some((k) => DEX_PROGRAMS.has(k));
  if (!touchesDex) return [];

  const walletIdx = keys.indexOf(wallet);
  if (walletIdx < 0) return [];

  const preSol = meta.preBalances[walletIdx] ?? 0;
  const postSol = meta.postBalances[walletIdx] ?? 0;
  const fee = walletIdx === 0 ? meta.fee : 0;
  const solDelta = (postSol - preSol + fee) / LAMPORTS_PER_SOL;

  const preByMint = sumWalletBalances(meta.preTokenBalances ?? [], wallet);
  const postByMint = sumWalletBalances(meta.postTokenBalances ?? [], wallet);

  const events: TradeEvent[] = [];
  const mints = new Set<string>([...preByMint.keys(), ...postByMint.keys()]);
  const changedTokens = [...mints].filter(
    (mint) => !QUOTE_MINTS.has(mint) && (preByMint.get(mint) ?? 0) !== (postByMint.get(mint) ?? 0),
  );
  for (const mint of changedTokens) {
    const pre = preByMint.get(mint) ?? 0;
    const post = postByMint.get(mint) ?? 0;
    const delta = post - pre;
    events.push({
      wallet,
      signature: tx.transaction.signatures[0] ?? "",
      blockTime: tx.blockTime ?? Math.floor(Date.now() / 1000),
      mint,
      side: delta > 0 ? "buy" : "sell",
      tokenDelta: Math.abs(delta),
      remainingTokens: post,
      solDelta: changedTokens.length === 1 ? solDelta : 0,
    });
  }
  return events;
}

function sumWalletBalances(balances: JsonTokenBalance[], wallet: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const tb of balances) {
    if (tb.owner !== wallet) continue;
    const amount = Number(tb.uiTokenAmount?.uiAmountString ?? tb.uiTokenAmount?.uiAmount ?? 0);
    out.set(tb.mint, (out.get(tb.mint) ?? 0) + amount);
  }
  return out;
}
