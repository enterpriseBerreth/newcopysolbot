import { createLogger } from "../logger.js";
import { SOL_MINT } from "./constants.js";
import type { PairInfo } from "./types.js";

const log = createLogger("prices");

const JUPITER_PRICE_API_URL = process.env["JUPITER_PRICE_API_URL"] ?? "https://api.jup.ag/price/v2";

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

export function selectTrustedPair(mint: string, pairs: DexPair[]): DexPair | undefined {
  const validPairs = pairs.filter(
    (pair) => pair.chainId === "solana" && pair.baseToken?.address === mint && Number(pair.priceUsd) > 0,
  );
  const sortedPrices = validPairs.map((pair) => Number(pair.priceUsd)).sort((a, b) => a - b);
  const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];
  if (!medianPrice || !Number.isFinite(medianPrice)) return undefined;
  const trustedPairs = validPairs.filter((pair) => {
    const ratio = Number(pair.priceUsd) / medianPrice;
    return Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 5;
  });
  trustedPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return trustedPairs[0];
}

async function fetchJupiterPrice(mint: string): Promise<PairInfo | null> {
  try {
    const res = await fetch(`${JUPITER_PRICE_API_URL}?ids=${mint}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log.warn(`jupiter ${mint.slice(0, 8)}… -> HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { data?: Record<string, { price?: string }> };
    const entry = json.data?.[mint];
    const price = entry?.price ? Number(entry.price) : 0;
    if (!price || !Number.isFinite(price)) return null;
    return {
      priceUsd: price,
      liquidityUsd: 0,
      symbol: mint.slice(0, 6),
      dexId: "jupiter",
      pairUrl: "",
    };
  } catch (err) {
    log.warn(`jupiter ${mint.slice(0, 8)}… failed: ${String(err)}`);
    return null;
  }
}

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
      const best = selectTrustedPair(mint, json.pairs ?? []);
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

  if (!info) {
    info = await fetchJupiterPrice(mint);
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
