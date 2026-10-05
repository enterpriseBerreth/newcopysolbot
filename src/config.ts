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
  rpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  port: num("PORT", 3000),
  pollIntervalMs: num("POLL_INTERVAL_MS", 15000),
  enabled: bool("COPYBOT_ENABLED", true),

  trackedWallets: str("TRACKED_WALLETS", DEFAULT_WALLETS)
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean),

  // Copy sizing: our entry = CLIP_PCT% of the copied wallet's trade notional.
  clipPct: num("CLIP_PCT", 1),
  // Ignore copied trades whose notional is below this.
  minWalletTradeUsd: num("MIN_WALLET_TRADE_USD", 50),

  // Paper account.
  startingBudgetUsd: num("STARTING_BUDGET_USD", 1000),
  maxPositions: num("MAX_POSITIONS", 40),
  entrySlippagePct: num("ENTRY_SLIPPAGE_PCT", 1),
  exitSlippagePct: num("EXIT_SLIPPAGE_PCT", 1),
  // Close a position when it is down this many percent (0 disables).
  stopLossPct: num("STOP_LOSS_PCT", 40),
  markIntervalMs: num("MARK_INTERVAL_MS", 60_000),

  // Daily wallet ranking report hour (UTC).
  dailyReportHourUtc: num("DAILY_REPORT_HOUR_UTC", 0),

  dataDir: str("DATA_DIR", "data"),

  telegramBotToken: str("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: str("TELEGRAM_CHAT_ID", ""),
  telegramTestOnBoot: bool("TELEGRAM_TEST_ON_BOOT", true),

  logLevel: str("LOG_LEVEL", "info"),
};

export type Config = typeof config;
