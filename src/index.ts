import "dotenv/config";
import path from "node:path";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { PaperEngine, splitShadowEvents } from "./copybot/paper.js";
import { SolRpc } from "./copybot/rpc.js";
import { TelegramNotifier } from "./copybot/notifier.js";
import { WalletWatcher, short } from "./copybot/watcher.js";
import { WsTradeWatcher } from "./copybot/ws.js";
import { startServer } from "./server.js";
import type { Position, TradeEvent } from "./copybot/types.js";

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
    liquidityFloorUsd: config.liquidityFloorUsd,
    killSwitchPnlUsd: config.killSwitchPnlUsd,
    killSwitchMinSells: config.killSwitchMinSells,
    killSwitchMaxWinRate: config.killSwitchMaxWinRate,
    topUpCostCapMultiple: config.topUpCostCapMultiple,
    notifier,
  });

  // Shadow simulation: a second virtual account fed ONLY the shadow wallets'
  // events, with the same strategy rules but the kill switch disabled so bad
  // performers keep producing evaluation data. No Telegram alerts from the sim.
  const shadowSet = new Set(config.shadowWallets);
  const shadowSim = new PaperEngine({
    startingBudgetUsd: config.shadowSimBudgetUsd,
    clipPct: config.clipPct,
    minWalletTradeUsd: config.minWalletTradeUsd,
    maxPositions: config.maxPositions,
    entrySlippagePct: config.entrySlippagePct,
    exitSlippagePct: config.exitSlippagePct,
    stopLossPct: config.stopLossPct,
    dataDir: path.join(config.dataDir, "shadow-sim"),
    trackedWallets: config.shadowWallets,
    liquidityFloorUsd: config.liquidityFloorUsd,
    topUpCostCapMultiple: config.topUpCostCapMultiple,
    killSwitchPnlUsd: 0,
    killSwitchMinSells: 0,
  });
  await Promise.all([engine.load(), shadowSim.load()]);
  log.info(
    `shadow sim: ${shadowSet.size} wallet(s) on $${config.shadowSimBudgetUsd} virtual budget ` +
      `(restored capital $${shadowSim.capital().toFixed(2)}, ${shadowSim.ledger.length} sim ledger trade(s))`,
  );

  // Route each incoming event batch to exactly one engine: shadow wallets feed
  // the simulator, everything else feeds the live paper account.
  const routeTrades = async (events: TradeEvent[]): Promise<void> => {
    const [shadowEvents, rest] = splitShadowEvents(events, shadowSet);
    await Promise.all([
      rest.length > 0 ? engine.onTrades(rest) : Promise.resolve(),
      shadowEvents.length > 0 ? shadowSim.onTrades(shadowEvents) : Promise.resolve(),
    ]);
  };

  let wsWatcher: WsTradeWatcher | null = null;
  let closing = Boolean(config.manualCloseId && config.manualCloseId !== engine.state.lastManualCloseId);

  // Rankings with shadow-sim columns merged in: cumulative sim PnL / trades /
  // win-loss split from the sim ledger, plus the sim's unrealized marks.
  const buildMergedRankings = async () => {
    const [rows, simRows] = await Promise.all([engine.walletRankings(), shadowSim.walletRankings()]);
    const simUnrealized = new Map(simRows.map((r) => [r.wallet, r.unrealizedUsd]));
    const simStats = new Map<string, { pnl: number; trades: number; wins: number; losses: number }>();
    for (const t of shadowSim.ledger) {
      if (t.side !== "sell") continue;
      const s = simStats.get(t.wallet) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
      const pnl = t.pnlUsd ?? 0;
      s.trades++;
      s.pnl += pnl;
      if (pnl > 0) s.wins++;
      else if (pnl < 0) s.losses++;
      simStats.set(t.wallet, s);
    }
    for (const row of rows) {
      if (!shadowSet.has(row.wallet)) continue;
      const s = simStats.get(row.wallet) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
      row.simPnlUsd = s.pnl;
      row.simTrades = s.trades;
      row.simWins = s.wins;
      row.simLosses = s.losses;
      row.simUnrealizedUsd = simUnrealized.get(row.wallet) ?? 0;
    }
    return rows;
  };

  const server = startServer(config.port, {
    health: async () => ({
      ok: true,
      enabled: config.enabled,
      closing,
      lastManualCloseId: engine.state.lastManualCloseId ?? null,
      shadowWallets: config.shadowWallets.map((w) => short(w)),
      shadowTradesSkipped: engine.shadowTradesSkipped,
      killSwitchedWallets: engine.killSwitchedWallets(),
      shadowSim: shadowSim.summary(),
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
      shadowSim: shadowSim.summary(),
      enabled: config.enabled,
      pollIntervalMs: config.pollIntervalMs,
      clipPct: config.clipPct,
      minWalletTradeUsd: config.minWalletTradeUsd,
      stopLossPct: config.stopLossPct,
    }),
    positions: async () => Object.values(engine.state.positions),
    trades: async (limit) => engine.ledger.slice(-limit),
    rankings: async () => buildMergedRankings(),
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
    ? new WsTradeWatcher(config.wsUrl, rpc, config.trackedWallets, routeTrades, undefined, config.shadowWallets, config.spamSampleWallets)
    : null;
  const watcher = new WalletWatcher(
    rpc,
    config.trackedWallets,
    routeTrades,
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
      .then(() => shadowSim.markAll())
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
    buildMergedRankings()
      .then((rows) => notifier.send(engine.formatRankings(rows)))
      .then(() => log.info(`ranking report sent (hour ${hour} UTC)`))
      .catch((err) => log.error(`ranking report failed: ${String(err)}`));
  }, 30_000);
  reportTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received; saving state…`);
    watcher.stop();
    wsWatcher?.stop();
    await Promise.all([engine.save(), shadowSim.save()]);
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
