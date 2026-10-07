export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** Stable/quote mints we never open paper positions in. */
export const QUOTE_MINTS = new Set<string>([SOL_MINT, USDC_MINT, USDT_MINT]);

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const PROCESSED_SIG_RING_SIZE = 2000;

/**
 * Known DEX / aggregator / launchpad programs. A tx that only moves tokens
 * through the SPL Token program and touches none of these is treated as a
 * plain transfer (airdrop / payment), NOT a trade, and is not copied.
 */
export const DEX_PROGRAMS = new Set<string>([
  // Raydium
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // AMM v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // CPMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // CLMM
  "9KEPoZMTMCxqM7v6dZB5t2rE2zR2NKLBaqMBZQBMWgp", // Router (older)
  "routeUW7wHcay6j2NUW3s46HKkgbWVIUadP1jgvT9oPr8", // Router
  // Jupiter
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Aggregator v6
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", // Aggregator v4
  "JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo", // Aggregator v2
  "JupoNsbAxX2wBQN4GofUgn4HFftfDf3Mcbnw7mXWbGA", // Limit order
  "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M", // DCA
  // Pump.fun
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // Bonding curve
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // Pump AMM
  // Meteora
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Dynamic AMM pools
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi", // Vaults
  // Orca
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Whirlpool
  // Phoenix
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
  // Lifinity
  "EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S",
  // OpenBook
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
]);

/** Wallets we start with (set TRACKED_WALLETS to override). Deduped. */
export const DEFAULT_WALLETS = [
  "9BMzTpSo4URse1oN666pmexhdjpU1vA5p7LtroCFQdLU",
  "3bzaJd5yZG73EVDz8xosQb7gfZm2LN5auFGh6wnP1n1f",
  "ACTbvbNm5qTLuofNRPxFPMtHAAtdH1CtzhCZatYHy831",
  "GijFWw4oNyh9ko3FaZforNsi3jk6wDovARpkKahPD4o5",
  "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9",
  "29yFzeBZgxf5zqrAkKXwgZtQehRf4pL8WbV2nRJikbw8",
  "ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT",
  "BvApEL9H3nnn2mezyUQQsSxvnwwBpkVFF3Yh61MZSruZ",
  "3VUNtVtjjx5ckUojT7UocJ5fbuAJRsNUXNfTBnPte9vC",
  "EeXvxkcGqMDZeTaVeawzxm9mbzZwqDUMmfG3bF7uzumH",
  "DkjBeKvadAtE3d8ZBvhp1AhmqBdzTM6URUUXgKKjGeQQ",
  "AimUs5AnmPfyCzDdUhvz4BTvb2fGsNonAb8uuSyHByw9",
  "CHCLtC1AWpSshZkiU8TNoNn9r7CHecVhTakuao7u4aBX",
  "4b3ZctHLzPBQt3biFbDWp12hf6ADkaruQx4aj9kiDQKh",
  "9LXWa7V3AE15VfBupcx5gDts2ix3Y9NzbcKZKjkkq6hV",
  "GeUnv1jmtviRbR7Gu1JnXSGkUMUgFVBHuEVQVpTaUX1W",
  "9aztChMYbsF5HRFG2ECkjfEdHHZChB1b3tRHQ2TPgKjv",
  "2dE3XMa3y4um1XXstv1ZUdNk96NctLW1cP5ewnLBUsRV",
  "8UfkYXd2cSE8CXmcfnbtF7DcgUeJJoQpt2TmSHrkCvD6",
  "Fpf2DJPM3n7LB9RWKaZ2zQ3KRcVWACHXpjngBNS99Q2H",
  "136MvvCwqUA8DJmVS38WYyrXaRJzSPcWy5gmM27Y4FKt",
  "8Ltv5royXzxVG3tAhVhRnfXrzapS5Dwqt1ocxprgu6YP",
  "8ZN71XTdVo8yRovnGLmNgW3Tgniw6A4J3JGLvPD686FP",
].join(",");
