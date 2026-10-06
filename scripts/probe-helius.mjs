/**
 * Probe a Solana RPC endpoint: HTTP sigs + tx v1, and WebSocket logsSubscribe.
 * Usage: node scripts/probe-helius.mjs <http-url> [ws-url]
 */
const httpUrl = process.argv[2];
const wsUrl = process.argv[3] ?? httpUrl?.replace(/^http/, "ws");
if (!httpUrl) {
  console.error("usage: node scripts/probe-helius.mjs <http-url> [ws-url]");
  process.exit(1);
}

const WALLET = "ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT";

async function rpc(method, params) {
  const res = await fetch(httpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  return { status: res.status, ok: res.ok && !j.error, result: j.result, error: j.error?.message };
}

const r1 = await rpc("getSignaturesForAddress", [WALLET, { limit: 100 }]);
console.log("http sigs(100):", r1.ok ? `ok ${r1.result?.length}` : `ERR ${r1.status} ${r1.error}`);
const sig = r1.result?.find((s) => !s.err)?.signature;
if (sig) {
  const r2 = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  console.log("http tx v1:", r2.ok ? "ok" : `ERR ${r2.status} ${r2.error}`);
  const t0 = Date.now();
  let ok = 0, fail = 0;
  for (let i = 0; i < 20; i++) {
    const r = await rpc("getSignaturesForAddress", [WALLET, { limit: 50 }]);
    r.ok ? ok++ : fail++;
    await new Promise((res) => setTimeout(res, 100));
  }
  console.log(`burst(20 @100ms): ok=${ok} fail=${fail} in ${Date.now() - t0}ms`);
}

console.log("ws url:", wsUrl?.replace(/api-key=[^&]+/, "api-key=***"));
const ws = new WebSocket(wsUrl);
const timeout = setTimeout(() => {
  console.log("ws: TIMEOUT after 15s");
  process.exit(1);
}, 15000);
ws.onopen = () => {
  console.log("ws: connected");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [WALLET] }, { commitment: "confirmed" }] }));
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.result !== undefined && msg.id === 1) {
    console.log("ws: subscribed, subscription id =", msg.result);
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }
};
ws.onerror = (e) => {
  console.log("ws: error", e.message ?? "");
  clearTimeout(timeout);
  process.exit(1);
};
