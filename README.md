# COPY-SOL

Paper copy-trading bot for Solana. Mirrors every buy and sell of a set of tracked wallets into a simulated account — no real transactions, no private keys.

## How it works

1. **Wallet watching** — polls `getSignaturesForAddress` for each tracked wallet and fetches each new transaction.
2. **Trade detection** — balance-diff decoding: any mint whose balance changed for the tracked wallet is a trade event. This works across every DEX/aggregator (Raydium, Pump.fun, Jupiter, Meteora, Orca, …) without per-DEX parsing. Plain transfers (airdrops, payments) are ignored: the tx must touch a known DEX program.
3. **Copy sizing** — our entry is **1% of the copied wallet's trade notional** (they buy $1,400 → we enter $14; they buy $100 → we enter $1). Trades where the wallet spends **less than $50** are skipped.
4. **Exits mirrored** — when a wallet sells X% of its bag, we sell X% of our position. Profits refill the paper cash balance.
5. **Stop loss** — open positions are re-marked every 60s and force-closed at **-40%**.
6. **Wallet rankings** — daily and weekly realized PnL, trade count and win rate per copied wallet; a ranked report is sent via Telegram once per day (default 00:00 UTC) and exposed on `/rankings`.

## Parameters (env)

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | public mainnet | RPC endpoint (paid endpoint recommended for 10+ wallets) |
| `TRACKED_WALLETS` | starter list | Comma-separated wallets to copy |
| `CLIP_PCT` | `1` | Our entry as % of wallet's trade notional |
| `MIN_WALLET_TRADE_USD` | `50` | Skip wallet trades below this notional |
| `STARTING_BUDGET_USD` | `1000` | Paper budget |
| `STOP_LOSS_PCT` | `40` | Force-close positions down this much |
| `MAX_POSITIONS` | `40` | Max simultaneous open positions |
| `ENTRY_SLIPPAGE_PCT` / `EXIT_SLIPPAGE_PCT` | `1` | Fill realism |
| `MARK_INTERVAL_MS` | `60000` | Stop-loss marking cadence |
| `DAILY_REPORT_HOUR_UTC` | `0` | Hour of the daily rankings report |
| `POLL_INTERVAL_MS` | `5000` | Per-wallet signature polling cadence |
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

State lives in `DATA_DIR` (default `data/`): `positions-snapshot.json` (cash, positions, wallet cursors) and `paper-trades.jsonl` (append-only ledger, rebuilt into memory on boot). Note: Railway's filesystem is ephemeral across deploys — the paper account resets on redeploys unless you add a volume mounted at `DATA_DIR`.

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

- Static/paper only: fills use DexScreener prices with a fixed slippage haircut; no MEV, taxes or honey-pot simulation.
- Balance-diff detection can misread exotic transfers that route through a DEX program; the $50 notional filter keeps the damage small.
- Wallet trade notional is estimated as `token amount × current price`, which can drift from the wallet's actual fill for fast-moving tokens.
