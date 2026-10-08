# COPY-SOL

Paper copy-trading bot for Solana. Mirrors every buy and sell of a set of tracked wallets into a simulated account — no real transactions, no private keys.

## How it works

1. **Wallet watching** — subscribes to each wallet over Solana WebSocket when configured; HTTP polling runs when subscriptions are unavailable. Every notification still needs an HTTP transaction fetch, so RPC quotas and backlog can cause missed trades.
2. **Trade detection** — balance-diff decoding for known DEX programs (Raydium, Pump.fun, Jupiter, Meteora, Orca, etc.). Plain transfers without a known DEX program are ignored.
3. **Copy sizing** — two premium wallets (29yF, CHCL) use a 10% clip of their trade notional when cash, top-up and exposure limits permit, otherwise a 5% clip if it fits; other live wallets use 1%. Buys below $200 copied-wallet notional are skipped. Exposure per copied wallet and per token is capped at 15% of paper capital.
4. **Shadow mode** — ten tracked wallets (EeXv, AimU, ardi, DkjB, 3bza, 9LXW, 9BMz, 4b3Z, Fpf2, GijF) are monitored and simulated separately without new live paper buys. Previously opened live paper positions are closed at the next available mark, realized into cash, and reported as closed trades.
5. **Exits mirrored** — when a wallet sells X% of its bag, we sell X% of our position; profits refill paper cash.
6. **Paper fills** — the copied wallet's SOL leg estimates its trade notional for clip sizing. Our paper entry/exit uses the available market price at detection, not the wallet's earlier execution price, plus entry/exit slippage.
7. **Stop loss** — open positions are re-marked every 30s and force-closed when down 40%. Rapid price gaps can exceed this threshold.
8. **Wallet rankings** — realized PnL, trade counts and positive/negative closed trades per copied wallet. Ranked reports are sent via Telegram at **12:00am and 12:00pm** (default hours 06:00/18:00 UTC = midnight/noon GMT-6, configurable via `REPORT_HOURS_UTC`) and exposed on `/rankings`.
9. **Closed-trade alerts** — Telegram message after every closed trade with the copied wallet, token address/name, capital before → after, and PnL in $ and %. Entries send nothing.
10. **Compounding** — capital = idle cash + deployed positions; all realized profits return to cash and are reused for new entries.

## Parameters (env)

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | publicnode | RPC endpoint (paid endpoint recommended for 10+ wallets) |
| `SOLANA_WS_URL` | — | WebSocket endpoint (e.g. Helius) for push-based capture; polling stays on as fallback |
| `TRACKED_WALLETS` | starter list | Comma-separated wallets to copy |
| `CLIP_PCT` | `1` | Standard entry as % of copied wallet's trade notional |
| `PREMIUM_CLIP_WALLETS` | 29yF, CHCL | Live wallets eligible for 10% then 5% fallback clips |
| `SHADOW_WALLETS` | 10 listed above | Tracked wallets simulated separately; existing live paper positions close at next available mark |
| `MAX_EXPOSURE_PCT` | `15` | Max cost basis per wallet and per token as % of paper capital; 0 disables |
| `MIN_WALLET_TRADE_USD` | `200` | Skip copied-wallet buys below this notional |
| `STARTING_BUDGET_USD` | `1000` (production) | Paper budget; persisted accounts retain their current balance |
| `STOP_LOSS_PCT` | `40` | Force-close positions down this much |
| `MAX_POSITIONS` | `1000` | Safety valve — concurrency is budget-bound |
| `ENTRY_SLIPPAGE_PCT` / `EXIT_SLIPPAGE_PCT` | `1` | Fill realism |
| `MARK_INTERVAL_MS` | `30000` | Stop-loss marking cadence |
| `REPORT_HOURS_UTC` | `6,18` | UTC hours for ranking reports (12am + 12pm GMT-6) |
| `POLL_INTERVAL_MS` | `15000` | Per-wallet signature polling cadence |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Telegram alerts |
| `COPYBOT_ENABLED` | `true` | Set `false` for healthcheck-only mode |

Full list in `env.template`.

## HTTP endpoints

- `GET /health` — liveness for the Railway healthcheck.
- `GET /stats` — cash, open positions, realized PnL, config summary.
- `GET /positions` — open paper positions.
- `GET /trades?limit=50` — recent paper trades.
- `GET /rankings` — daily/weekly per-wallet PnL ranking.

## Persistence

State lives in `DATA_DIR`: `positions-snapshot.json` (cash, positions, wallet cursors) and `paper-trades.jsonl` (append-only ledger, rebuilt on boot). On Railway, `DATA_DIR=/app/data` is mounted on the persistent volume. Without a volume, the paper account resets on deploy.

## Quick start

```bash
npm install
copy env.template .env   # then edit
npm run typecheck
npm run selftest
npm start
```

## Deployment (Railway)

`railway.json` + `Procfile` are included. Push to `main` and the connected Railway service deploys automatically; the `/health` endpoint keeps it alive. Set the environment variables in the Railway dashboard.

## Self-test

`npm run selftest` feeds synthetic transactions through the decoder and the paper engine, simulating entries, dust filtering, partial/full exits, stop loss and rankings.

## Limitations

- Paper fills use DexScreener's latest available market quote at observation time plus configured slippage; the wallet's own SOL fill only estimates its trade notional for sizing. Cached quotes can be up to 30 seconds old. Simulation still omits MEV, swap fees, token taxes, transfer restrictions and market impact; historical trades remain on their original recorded basis.
- Exposure caps block only new buys; positions opened before a cap was introduced are not automatically sold and may remain over the limit until copied exits or stop-losses occur.
- WebSocket notifications are not transaction data: each still requires an HTTP fetch. A sustained 429, subscription outage or full queue means some fast-wallet trades will be missed; `/health` reports `wsHealthy`, `wsPending` and `wsDropped` so coverage is not assumed.
- Balance-diff detection can misread exotic transfers through a known DEX program; trades on unlisted programs and tokens with no price cannot be copied.
- High-volume wallet coverage requires enough provider capacity for transaction fetches, not just WebSocket subscriptions.
