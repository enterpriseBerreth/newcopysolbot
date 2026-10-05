/**
 * Sends sample alerts to Telegram to verify bot + chat wiring.
 * Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/telegram-test.mjs
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
  process.exit(1);
}

async function send(text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const j = await res.json();
  console.log("HTTP", res.status, "message_id:", j.result?.message_id ?? JSON.stringify(j));
  if (!j.ok) process.exit(1);
}

const closed =
  "TEST — TRADE CLOSED — COPY SELL EXAMPLE\n" +
  "Wallet: 9BMzTpSo4URse1oN666pmexhdjpU1vA5p7LtroCFQdLU\n" +
  "Token: EXAMPLE (ExampleMint11111111111111111111111111111)\n" +
  "Exit: 100% of position @ $0.00421000\n" +
  "PnL: +$3.42 (+34.2%)\n" +
  "Capital: $1000.00 -> $1003.42";

const rankings =
  "TEST — WALLET RANKINGS — " + new Date().toUTCString() + "\n" +
  "\n" +
  "1. 9BMz…QdLU  +$12.40 day\n" +
  "   day:   8 trades | 5 pos / 2 neg\n" +
  "   week:  +$45.10 | 31 trades | 18 pos / 9 neg\n" +
  "   open:  +$2.10 unrealized\n" +
  "\n" +
  "2. 3bza…1n1f  +$4.10 day\n" +
  "   day:   5 trades | 3 pos / 1 neg\n" +
  "   week:  +$12.90 | 22 trades | 12 pos / 7 neg\n" +
  "   open:  -$0.40 unrealized";

await send(closed);
await send(rankings);
console.log("both test alerts delivered");
