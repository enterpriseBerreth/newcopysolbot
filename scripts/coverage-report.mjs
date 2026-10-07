// Estimates per-wallet copied vs missed trades since the paper account opened.
// Opportunities = successful on-chain signatures since window start (includes
// non-swap txs, so "missed" is an upper bound). Copied = distinct signatures
// in the paper ledger for that wallet. Run: node scripts/coverage-report.mjs
const RAILWAY = process.env.RAILWAY_VARS_JSON ?? "";
const vars = RAILWAY ? JSON.parse(RAILWAY) : null;

async function main() {
  const root = process.env.BOT_URL ?? "https://newcopysolbot-production.up.railway.app";
  const rpcUrl = vars?.SOLANA_RPC_URL ?? process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL required (pass RAILWAY_VARS_JSON)");
  const windowStart = Number(process.env.WINDOW_START_EPOCH ?? 1791249900);

  const [rankings, trades] = await Promise.all([
    fetch(root + "/rankings").then((r) => r.json()),
    fetch(root + "/trades?limit=500").then((r) => r.json()),
  ]);
  const copiedByWallet = new Map();
  for (const t of trades) copiedByWallet.set(t.wallet, (copiedByWallet.get(t.wallet) ?? 0) + 1);

  const rpc = async (method, params) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      const json = await res.json();
      if (json.error) throw new Error(method + " -> " + JSON.stringify(json.error).slice(0, 120));
      return json.result;
    }
    throw new Error(method + " rate limited");
  };

  const rows = [];
  for (const r of rankings) {
    const wallet = r.wallet;
    let before = undefined;
    let inWindow = 0;
    let failed = 0;
    let oldest = null;
    let pages = 0;
    let truncated = false;
    const MAX_PAGES = 80;
    while (pages < MAX_PAGES) {
      const opts = { limit: 1000 };
      if (before) opts.before = before;
      const sigs = await rpc("getSignaturesForAddress", [wallet, opts]);
      if (!sigs || sigs.length === 0) break;
      pages++;
      let stop = false;
      for (const s of sigs) {
        const ts = s.blockTime ?? 0;
        if (ts < windowStart) { stop = true; break; }
        if (s.err) failed++; else inWindow++;
        oldest = s;
      }
      before = sigs[sigs.length - 1].signature;
      if (stop || sigs.length < 1000) break;
      await new Promise((r2) => setTimeout(r2, 380));
    }
    if (pages >= MAX_PAGES) truncated = true;
    const windowSec = Math.floor(Date.now() / 1000) - windowStart;
    let opportunities = inWindow + failed;
    let estimated = false;
    if (truncated && oldest) {
      const sampledSec = Math.floor(Date.now() / 1000) - oldest.blockTime;
      if (sampledSec > 60) {
        opportunities = Math.round(opportunities * (windowSec / sampledSec));
        estimated = true;
      }
    }
    rows.push({
      wallet,
      short: r.short,
      opportunities,
      estimated,
      failedTx: failed,
      copied: r.dayTrades ?? copiedByWallet.get(wallet) ?? 0,
      pages,
      truncated,
      oldestTs: oldest?.blockTime ?? null,
    });
    console.error(`scanned ${r.short}: ${inWindow + failed} sigs (${pages} pages, truncated=${truncated}, estimated=${estimated})`);
  }
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
