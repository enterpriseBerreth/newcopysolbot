import "dotenv/config";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { PaperEngine } from "./copybot/paper.js";
import { SolRpc } from "./copybot/rpc.js";
import { TelegramNotifier } from "./copybot/notifier.js";
import { WalletWatcher, short } from "./copybot/watcher.js";
import { WsTradeWatcher } from "./copybot/ws.js";
import { startServer } from "./server.js";
import type { Position } from "./copybot/types.js";

const log = createLogger("index");

async function main(): Promise<void> {
  log.info(`COPY-SOL booting | rpc=${new URL(config.rpcUrl).host} | wallets=${config.trackedWallets.length} | clip=${config.clipPct}% | minWalletTrade=$${config.minWalletTradeUsd} | SL=-${config.stopLossPct}%`);

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
    trackedWallets: config.trackedWallets,
    shadowWallets: config.shadowWallets,
    notifier,
  });
  await engine.load();
  let wsWatcher: WsTradeWatcher | null = null;
  let closing = Boolean(config.manualCloseId && config.manualCloseId !== engine.state.lastManualCloseId);

  const server = startServer(config.port, {
    health: async () => ({
      ok: true,
      enabled: config.enabled,
      closing,
      lastManualCloseId: engine.state.lastManualCloseId ?? null,
      shadowWallets: config.shadowWallets.map((w) => short(w)),
      shadowTradesSkipped: engine.shadowTradesSkipped,
      uptimeSec: Math.round(process.uptime()),
      wallets: config.trackedWallets.map((w) => short(w)),
      wsHealthy: wsWatcher?.healthy ?? false,
      wsPending: wsWatcher?.pending ?? 0,
      wsDropped: wsWatcher?.droppedNotifications ?? 0,
      wsShadowDropped: wsWatcher?.shadowDroppedNotifications ?? 0,
      wsFetched: wsWatcher?.fetchedTransactions ?? 0,
      wsDecodedTrades: wsWatcher?.decodedTrades ?? 0,
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

  if (closing) {
    const result = await engine.closeAll(config.manualCloseId);
    closing = false;
    log.info(`manual close ${config.manualCloseId}: ${result.closed} closed, ${result.skipped} skipped, realized $${result.pnlUsd.toFixed(2)}; ${Object.keys(engine.state.positions).length} remain open`);
  }

  if (!config.enabled) {
    log.info("COPYBOT_ENABLED=false — HTTP server only");
    return;
  }

  if (config.telegramTestOnBoot && notifier.enabled) {
    await notifier.send(`COPY-SOL online — copying ${config.trackedWallets.length} wallets, $${config.startingBudgetUsd} paper budget`);
  }

  const rpc = new SolRpc(config.rpcUrl);
  wsWatcher = config.wsUrl
    ? new WsTradeWatcher(config.wsUrl, rpc, config.trackedWallets, (events) => engine.onTrades(events), undefined, config.shadowWallets)
    : null;
  const watcher = new WalletWatcher(
    rpc,
    config.trackedWallets,
    (events) => engine.onTrades(events),
    config.pollIntervalMs,
    engine.state.lastSigByWallet,
    () => !wsWatcher?.healthy,
    (wallet, signature) => Boolean(wsWatcher?.hasSeen(signature) || engine.hasProcessed(wallet, signature)),
  );
  await watcher.start();
  await engine.save();
  wsWatcher?.start();

  // Stop-loss marking loop.
  let marking = false;
  const markTimer = setInterval(() => {
    if (marking) return;
    marking = true;
    engine.markAll()
      .catch((err) => log.error(`markAll failed: ${String(err)}`))
      .finally(() => { marking = false; });
  }, config.markIntervalMs);
  markTimer.unref();

  // Ranking reports at each configured UTC hour (default: 12am + 12pm GMT-6).
  const lastReportKey = new Set<string>();
  const reportTimer = setInterval(() => {
    const now = new Date();
    const hour = now.getUTCHours();
    if (!config.reportHoursUtc.includes(hour)) return;
    const key = `${now.toISOString().slice(0, 10)}-${hour}`;
    if (lastReportKey.has(key)) return;
    lastReportKey.add(key);
    engine
      .sendDailyRankings()
      .then(() => log.info(`ranking report sent (hour ${hour} UTC)`))
      .catch((err) => log.error(`ranking report failed: ${String(err)}`));
  }, 30_000);
  reportTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received; saving state…`);
    watcher.stop();
    wsWatcher?.stop();
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
