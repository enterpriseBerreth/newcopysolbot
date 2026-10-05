/**
 * Sends a sample CLOSED-TRADE alert to Telegram to verify bot + channel wiring.
 * Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/telegram-test.mjs
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
  process.exit(1);
}

const text =
  "TEST — TRADE CLOSED — COPY SELL EXAMPLE\n" +
  "Wallet: 9BMzTpSo4URse1oN666pmexhdjpU1vA5p7LtroCFQdLU\n" +
  "Token: EXAMPLE (ExampleMint11111111111111111111111111111)\n" +
  "Exit: 100% of position @ $0.00421000\n" +
  "PnL: +$3.42 (+34.2%)\n" +
  "Capital: $1000.00 -> $1003.42";

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chatId, text }),
});
const j = await res.json();
console.log("HTTP", res.status, JSON.stringify(j));
if (!j.ok) process.exit(1);
console.log("delivered message_id:", j.result?.message_id);
