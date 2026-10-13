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

/** Last accepted price per mint — the reference for jump-guard checks. */
const lastGood = new Map<string, { priceUsd: number; at: number }>();
/** A price this much newer/older than a recently accepted one is treated as suspect. */
const JUMP_RATIO = 5;
/** How long a previously accepted price stays a valid reference. */
const JUMP_WINDOW_MS = 10 * 60_000;

export type PairProvider = (mint: string) => Promise<PairInfo | null>;

/** True when newPrice is implausibly far from oldPrice (>5x or <1/5x). */
export function isSuspectJump(newPrice: number, oldPrice: number): boolean {
  if (!(oldPrice > 0) || !(newPrice > 0)) return false;
  const ratio = newPrice / oldPrice;
  return ratio > JUMP_RATIO || ratio < 1 / JUMP_RATIO;
}

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

  // Jump guard: a >5x move vs a recently accepted price is almost always a
  // manipulated pool or bad data, not the market. Cross-check with Jupiter
  // (which prices via routed liquidity) and reject the outlier if it disagrees.
  const prev = lastGood.get(mint);
  if (info && prev && now - prev.at < JUMP_WINDOW_MS && isSuspectJump(info.priceUsd, prev.priceUsd)) {
    log.warn(
      `price jump guard: ${mint.slice(0, 8)}… $${prev.priceUsd.toPrecision(6)} -> $${info.priceUsd.toPrecision(6)}; verifying via Jupiter`,
    );
    const jup = await fetchJupiterPrice(mint);
    if (jup) {
      const agreesWithNew = isSuspectJump(jup.priceUsd, info.priceUsd) === false;
      if (!agreesWithNew) {
        log.warn(`price jump guard: rejected $${info.priceUsd.toPrecision(6)}; using Jupiter $${jup.priceUsd.toPrecision(6)}`);
        info = jup;
      }
    } else {
      log.warn(`price jump guard: Jupiter unavailable; holding last trusted price $${prev.priceUsd.toPrecision(6)}`);
      info = { ...info, priceUsd: prev.priceUsd, dexId: "jump-guard" };
    }
  }
  if (info?.priceUsd) lastGood.set(mint, { priceUsd: info.priceUsd, at: now });

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
  lastGood.clear();
}
