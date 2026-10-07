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
  // Ignore copied trades whose notional is below this. Data shows wallet trades
  // under ~$200 are overwhelmingly unprofitable to copy; >=$500 trades are net positive.
  minWalletTradeUsd: num("MIN_WALLET_TRADE_USD", 200),

  // Paper account.
  startingBudgetUsd: num("STARTING_BUDGET_USD", 10_000),
  // Concurrency is meant to be budget-bound, not position-count-bound;
  // 1000 is effectively "as many as cash allows" (override via env).
  maxPositions: num("MAX_POSITIONS", 1000),
  entrySlippagePct: num("ENTRY_SLIPPAGE_PCT", 1),
  exitSlippagePct: num("EXIT_SLIPPAGE_PCT", 1),
  // Close a position when it is down this many percent (0 disables).
  stopLossPct: num("STOP_LOSS_PCT", 40),
  markIntervalMs: num("MARK_INTERVAL_MS", 60_000),

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
  // Max accumulated cost per position, as a multiple of the first clip
  // (blocks wallets from DCA-ing many times into one token). 0 disables.
  topUpCostCapMultiple: num("TOP_UP_COST_CAP_MULTIPLE", 2),

  // Ranking report hours (UTC). Default = 12:00am and 12:00pm GMT-6.
  reportHoursUtc: str("REPORT_HOURS_UTC", "6,18")
    .split(",")
    .map((h) => parseInt(h.trim(), 10))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),

  dataDir: str("DATA_DIR", "data"),
  manualCloseId: str("MANUAL_CLOSE_ID", ""),
  // Shadow wallets: monitored (cursor, decode, rankings) but never funded.
  shadowWallets: [
    ...new Set(
      str("SHADOW_WALLETS", "")
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ],

  telegramBotToken: str("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: str("TELEGRAM_CHAT_ID", ""),
  telegramTestOnBoot: bool("TELEGRAM_TEST_ON_BOOT", false),

  logLevel: str("LOG_LEVEL", "info"),
};

export type Config = typeof config;
