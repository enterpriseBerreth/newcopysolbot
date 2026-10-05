(async () => {
  const res1 = await fetch("https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: ["ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT", { limit: 1 }],
    }),
  });
  const j1 = await res1.json();
  console.log("sigs status", res1.status, JSON.stringify(j1.result?.[0] ?? j1.error));
  const sig = j1.result?.[0]?.signature;
  if (!sig) return;
  for (const v of [0, 1]) {
    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: v, commitment: "confirmed" }],
      }),
    });
    const j = await res.json();
    console.log("version", v, "->", res.status, j.error ? JSON.stringify(j.error.message) : "OK keys=" + Object.keys(j.result ?? {}));
    await new Promise((r) => setTimeout(r, 500));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
