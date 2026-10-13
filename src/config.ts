import { DEFAULT_WALLETS } from "./copybot/constants.js";

function str(key: string, def: string): string {
  const v = process.env[key]?.trim();
  return v ? v : def;
}

function num(key: string, def: number): number {
  const v = parseFloat(process.env[key]?.trim() ?? "");
  return Number.isFinite(v) ? v : def;
}

function bool(key: string, def: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return def;
  return v !== "false" && v !== "0" && v !== "off";
}

export const config = {
  rpcUrl: str("SOLANA_RPC_URL", "https://solana-rpc.publicnode.com"),
  // WebSocket endpoint for push-based capture (e.g. Helius wss://...?api-key=...).
  // Empty = polling only.
  wsUrl: str("SOLANA_WS_URL", ""),
  port: num("PORT", 3000),
  pollIntervalMs: num("POLL_INTERVAL_MS", 15000),
  enabled: bool("COPYBOT_ENABLED", true),

  trackedWallets: [
    ...new Set(
      str("TRACKED_WALLETS", DEFAULT_WALLETS)
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ],

  // Copy sizing: our entry = CLIP_PCT% of the copied wallet's trade notional.
  clipPct: num("CLIP_PCT", 1),
  premiumWallets: str(
    "PREMIUM_CLIP_WALLETS",
    "29yFzeBZgxf5zqrAkKXwgZtQehRf4pL8WbV2nRJikbw8,CHCLtC1AWpSshZkiU8TNoNn9r7CHecVhTakuao7u4aBX",
  ).split(",").map((wallet) => wallet.trim()).filter(Boolean),
  premiumClipPct: num("PREMIUM_CLIP_PCT", 10),
  premiumFallbackClipPct: num("PREMIUM_FALLBACK_CLIP_PCT", 5),
  // Ignore copied trades whose notional is below this. Data shows wallet trades
  // under ~$200 are overwhelmingly unprofitable to copy; >=$500 trades are net positive.
  minWalletTradeUsd: num("MIN_WALLET_TRADE_USD", 200),
  // Lower floor for live (non-shadow) wallets so CHCL/29yF capture more of their flow.
  liveMinWalletTradeUsd: num("LIVE_MIN_WALLET_TRADE_USD", 50),

  // Paper account.
  startingBudgetUsd: num("STARTING_BUDGET_USD", 10_000),
  // Concurrency is meant to be budget-bound, not position-count-bound;
  // 1000 is effectively "as many as cash allows" (override via env).
  maxPositions: num("MAX_POSITIONS", 1000),
  entrySlippagePct: num("ENTRY_SLIPPAGE_PCT", 1),
  exitSlippagePct: num("EXIT_SLIPPAGE_PCT", 1),
  // Close a position when it is down this many percent (0 disables).
  stopLossPct: num("STOP_LOSS_PCT", 40),
  // Close a position once it has pulled back this many percent from its peak (0 disables).
  trailingStopPct: num("TRAILING_STOP_PCT", 15),
  // Close a position once it is up this many percent from entry (0 disables).
  takeProfitPct: num("TAKE_PROFIT_PCT", 50),
  markIntervalMs: num("MARK_INTERVAL_MS", 30_000),

  // Risk gates:
  // Skip entries into tokens whose deepest DexScreener pool has less liquidity
  // than this (USD). 0 disables. Missing/zero liquidity counts as below floor.
  liquidityFloorUsd: num("LIQUIDITY_FLOOR_USD", 25_000),
  // Stop copying a wallet while its cumulative realized PnL is at or below
  // this (USD). It auto-re-enables if realized PnL recovers (e.g. open
  // positions exit profitably). 0 disables.
  killSwitchPnlUsd: num("KILL_SWITCH_PNL_USD", -50),
  // Win-rate kill: needs at least this many closed sells, a negative PnL,
  // and a win rate below killSwitchMaxWinRate.
  killSwitchMinSells: num("KILL_SWITCH_MIN_SELLS", 20),
  killSwitchMaxWinRate: num("KILL_SWITCH_MAX_WIN_RATE", 0.3),
  // Use only the last N sells for kill-switch math so a wallet can recover
  // after a profitable streak. 0 = use entire history (old behavior).
  killSwitchLookbackSells: num("KILL_SWITCH_LOOKBACK_SELLS", 20),
  // One-time boot restore: rename .archive-<stamp> state/ledger back into
  // place before loading (consumed by the rename; safe to leave set).
  restoreFromArchiveStamp: str("RESTORE_FROM_ARCHIVE_STAMP", ""),
  // Max accumulated cost per position, as a multiple of the first clip
  // (blocks wallets from DCA-ing many times into one token). 0 disables.
  topUpCostCapMultiple: num("TOP_UP_COST_CAP_MULTIPLE", 2),
  maxExposurePct: num("MAX_EXPOSURE_PCT", 15),

  // Dynamic clip sizing: scale a wallet's clip up/down based on its last N sells.
  // 0 disables (static 1% / 10%).
  dynamicClipLookbackSells: num("DYNAMIC_CLIP_LOOKBACK_SELLS", 20),
  dynamicClipMaxMultiplier: num("DYNAMIC_CLIP_MAX_MULTIPLIER", 1.5),
  dynamicClipMinMultiplier: num("DYNAMIC_CLIP_MIN_MULTIPLIER", 0.6),

  // Ranking report hours (UTC). Default = 12:00am and 12:00pm GMT-6.
  reportHoursUtc: str("REPORT_HOURS_UTC", "6,18")
    .split(",")
    .map((h) => parseInt(h.trim(), 10))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),

  dataDir: str("DATA_DIR", "data"),
  manualCloseId: str("MANUAL_CLOSE_ID", ""),
  // Operation id for a capital reset: setting a NEW value archives the previous
  // paper state + ledger and restarts the account at STARTING_BUDGET_USD.
  resetId: str("RESET_ID", ""),
  // Shadow wallets: monitored (cursor, decode, rankings) but never funded.
  shadowWallets: [
    ...new Set(
      str("SHADOW_WALLETS", [
        "3bzaJd5yZG73EVDz8xosQb7gfZm2LN5auFGh6wnP1n1f",
        "ACTbvbNm5qTLuofNRPxFPMtHAAtdH1CtzhCZatYHy831",
        "GijFWw4oNyh9ko3FaZforNsi3jk6wDovARpkKahPD4o5",
        "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9",
        "ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT",
        "BvApEL9H3nnn2mezyUQQsSxvnwwBpkVFF3Yh61MZSruZ",
        "3VUNtVtjjx5ckUojT7UocJ5fbuAJRsNUXNfTBnPte9vC",
        "EeXvxkcGqMDZeTaVeawzxm9mbzZwqDUMmfG3bF7uzumH",
        "DkjBeKvadAtE3d8ZBvhp1AhmqBdzTM6URUUXgKKjGeQQ",
        "AimUs5AnmPfyCzDdUhvz4BTvb2fGsNonAb8uuSyHByw9",
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
        "9BMzTpSo4URse1oN666pmexhdjpU1vA5p7LtroCFQdLU",
      ].join(","))
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ],
  // Virtual starting budget for the shadow simulation: each shadow wallet is
  // copy-traded with the same strategy rules against this paper budget so we
  // can evaluate promotion candidates without risking real paper capital.
  shadowSimBudgetUsd: num("SHADOW_SIM_BUDGET_USD", 10_000),

  // Tracked firehose ("spam-speed") wallets: their MEV bots emit so many txs
  // that they saturate the fetch queue and crowd out every other wallet. They
  // are sampled up to 5 txs per 2-second window. Default covers the known
  // MEV-speed tracked wallets (ACTb included: 94% fail rate, firehose).
  spamSampleWallets: str(
    "SPAM_SAMPLE_WALLETS",
    "GijFWw4oNyh9ko3FaZforNsi3jk6wDovARpkKahPD4o5,4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9,ACTbvbNm5qTLuofNRPxFPMtHAAtdH1CtzhCZatYHy831",
  )
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean),

  telegramBotToken: str("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: str("TELEGRAM_CHAT_ID", ""),
  telegramTestOnBoot: bool("TELEGRAM_TEST_ON_BOOT", false),

  logLevel: str("LOG_LEVEL", "info"),
};

export const minWalletTradeUsdByWallet: Record<string, number> = (() => {
  const shadow = new Set(config.shadowWallets);
  const map: Record<string, number> = {};
  for (const w of config.trackedWallets) {
    if (!shadow.has(w)) map[w] = config.liveMinWalletTradeUsd;
  }
  return map;
})();

export type Config = typeof config;
