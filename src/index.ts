import "dotenv/config";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { PaperEngine } from "./copybot/paper.js";
import { SolRpc } from "./copybot/rpc.js";
import { TelegramNotifier } from "./copybot/notifier.js";
import { WalletWatcher, short } from "./copybot/watcher.js";
import { startServer } from "./server.js";
import type { Position } from "./copybot/types.js";

const log = createLogger("index");

async function main(): Promise<void> {
  log.info(`COPY-SOL booting | rpc=${config.rpcUrl} | wallets=${config.trackedWallets.length} | clip=${config.clipPct}% | minWalletTrade=$${config.minWalletTradeUsd} | SL=-${config.stopLossPct}%`);

  const notifier = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);
  const engine = new PaperEngine({
    startingBudgetUsd: config.startingBudgetUsd,
    clipPct: config.clipPct,
    minWalletTradeUsd: config.minWalletTradeUsd,
    maxPositions: config.maxPositions,
    entrySlippagePct: config.entrySlippagePct,
    exitSlippagePct: config.exitSlippagePct,
    stopLossPct: config.stopLossPct,
    dataDir: config.dataDir,
    notifier,
  });
  await engine.load();

  const server = startServer(config.port, {
    health: async () => ({
      ok: true,
      enabled: config.enabled,
      uptimeSec: Math.round(process.uptime()),
      wallets: config.trackedWallets.map((w) => short(w)),
    }),
    stats: async () => ({
      ...engine.summary(),
      enabled: config.enabled,
      pollIntervalMs: config.pollIntervalMs,
      clipPct: config.clipPct,
      minWalletTradeUsd: config.minWalletTradeUsd,
      stopLossPct: config.stopLossPct,
    }),
    positions: async () => Object.values(engine.state.positions),
    trades: async (limit) => engine.ledger.slice(-limit),
    rankings: async () => engine.walletRankings(),
  });

  if (!config.enabled) {
    log.info("COPYBOT_ENABLED=false — HTTP server only");
    return;
  }

  if (config.telegramTestOnBoot && notifier.enabled) {
    await notifier.send(`COPY-SOL online — copying ${config.trackedWallets.length} wallets, $${config.startingBudgetUsd} paper budget`);
  }

  const rpc = new SolRpc(config.rpcUrl);
  const watcher = new WalletWatcher(
    rpc,
    config.trackedWallets,
    (events) => engine.onTrades(events),
    config.pollIntervalMs,
    engine.state.lastSigByWallet,
  );
  await watcher.start();

  // Stop-loss marking loop.
  const markTimer = setInterval(() => {
    engine.markAll().catch((err) => log.error(`markAll failed: ${String(err)}`));
  }, config.markIntervalMs);
  markTimer.unref();

  // Daily rankings report.
  let lastReportDay = "";
  const reportTimer = setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === config.dailyReportHourUtc && lastReportDay !== day) {
      lastReportDay = day;
      engine.sendDailyRankings().catch((err) => log.error(`daily report failed: ${String(err)}`));
    }
  }, 30_000);
  reportTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received; saving state…`);
    watcher.stop();
    await engine.save();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

// Keep Position type referenced for API docs consumers.
export type { Position };
