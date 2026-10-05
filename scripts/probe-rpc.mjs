const WALLETS = [
  "9BMzTpSo4URse1oN666pmexhdjpU1vA5p7LtroCFQdLU",
  "3bzaJd5yZG73EVDz8xosQb7gfZm2LN5auFGh6wnP1n1f",
  "ACTbvbNm5qTLuofNRPxFPMtHAAtdH1CtzhCZatYHy831",
];

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  return { status: res.status, ok: res.ok && !j.error, result: j.result, error: j.error?.message };
}

async function probe(name, url) {
  console.log(`── ${name} (${url}) ──`);
  const r1 = await rpc(url, "getSignaturesForAddress", [WALLETS[0], { limit: 10 }]);
  console.log("sigs:", r1.ok ? `ok ${r1.result?.length}` : `ERR ${r1.status} ${r1.error}`);
  if (!r1.ok) return;
  const sig = r1.result.find((s) => !s.err)?.signature;
  if (sig) {
    const r2 = await rpc(url, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    console.log("tx v1:", r2.ok ? `ok version=${r2.result?.version ?? "legacy"}` : `ERR ${r2.status} ${r2.error}`);
  }
  // burst: 10 rapid sig polls like the watcher would do
  const t0 = Date.now();
  let okc = 0, err429 = 0, other = 0;
  for (let i = 0; i < 10; i++) {
    const r = await rpc(url, "getSignaturesForAddress", [WALLETS[i % WALLETS.length], { limit: 25 }]);
    if (r.ok) okc++;
    else if (r.status === 429) err429++;
    else other++;
    await new Promise((res) => setTimeout(res, 300));
  }
  console.log(`burst(10 @300ms): ok=${okc} 429=${err429} other=${other} in ${Date.now() - t0}ms`);
}

await probe("publicnode", "https://solana-rpc.publicnode.com");
await new Promise((r) => setTimeout(r, 1000));
await probe("mainnet-beta", "https://api.mainnet-beta.solana.com");
