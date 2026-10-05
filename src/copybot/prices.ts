import { createLogger } from "../logger.js";
import { SOL_MINT } from "./constants.js";
import type { PairInfo } from "./types.js";

const log = createLogger("prices");

const TTL_TOKEN_MS = 30_000;
const TTL_SOL_MS = 60_000;

interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

const cache = new Map<string, { at: number; info: PairInfo | null; ttl: number }>();

export type PairProvider = (mint: string) => Promise<PairInfo | null>;

export async function getPairInfo(mint: string): Promise<PairInfo | null> {
  const now = Date.now();
  const ttl = mint === SOL_MINT ? TTL_SOL_MS : TTL_TOKEN_MS;
  const hit = cache.get(mint);
  if (hit && now - hit.at < hit.ttl) return hit.info;

  let info: PairInfo | null = null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { pairs?: DexPair[] | null };
      const pairs = (json.pairs ?? []).filter(
        (p) => p.chainId === "solana" && p.baseToken?.address === mint && Number(p.priceUsd) > 0,
      );
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const best = pairs[0];
      if (best) {
        info = {
          priceUsd: Number(best.priceUsd),
          liquidityUsd: best.liquidity?.usd ?? 0,
          symbol: best.baseToken.symbol ?? mint.slice(0, 6),
          dexId: best.dexId,
          pairUrl: best.url,
        };
      }
    } else {
      log.warn(`dexscreener ${mint.slice(0, 8)}… -> HTTP ${res.status}`);
    }
  } catch (err) {
    log.warn(`dexscreener ${mint.slice(0, 8)}… failed: ${String(err)}`);
  }

  cache.set(mint, { at: now, info, ttl });
  return info;
}

export async function getSolPriceUsd(): Promise<number> {
  const info = await getPairInfo(SOL_MINT);
  return info?.priceUsd ?? 0;
}

/** Clear the cache (used by tests). */
export function clearPriceCache(): void {
  cache.clear();
}
