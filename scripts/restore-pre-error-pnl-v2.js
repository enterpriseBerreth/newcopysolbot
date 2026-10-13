const fs = require("fs");

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const DIR = "/app/data";
const STAMP = process.argv[2];
const RESET_ID = process.argv[3];

// Same trusted-pair logic as src/copybot/prices.ts (median +/- 5x).
function trustedPrice(pairs) {
  const valid = pairs.filter((p) => p.chainId === "solana" && p.baseToken?.address === MINT && Number(p.priceUsd) > 0);
  const sorted = valid.map((p) => Number(p.priceUsd)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!median || !Number.isFinite(median)) return null;
  const kept = valid.filter((p) => {
    const r = Number(p.priceUsd) / median;
    return Number.isFinite(r) && r >= 0.2 && r <= 5;
  });
  kept.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return Number(kept[0]?.priceUsd);
}

function scanLedger(label, lines) {
  let suspicious = 0;
  for (const l of lines) {
    const t = JSON.parse(l);
    if (t.mint === MINT && t.side === "sell") {
      const implied = t.usd / t.qty;
      if (implied > 0.0001) {
        suspicious++;
        console.log(label, "suspicious close:", JSON.stringify({ ts: new Date(t.ts).toISOString(), wallet: t.wallet?.slice(0, 6), reason: t.reason, qty: t.qty, impliedPrice: implied, usd: t.usd, pnl: t.pnlUsd }));
      }
    }
  }
  console.log(label, "suspicious closes:", suspicious);
}

(async () => {
  const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + MINT);
  const json = await res.json();
  const realPrice = trustedPrice(json.pairs ?? []);
  if (!realPrice) throw new Error("no trusted BONK price");
  console.log("trusted BONK price:", realPrice);

  for (const [engine, dir] of [["main", DIR], ["shadow-sim", DIR + "/shadow-sim"]]) {
    const snapPath = `${dir}/positions-snapshot.json.archive-${STAMP}`;
    const ledgerPath = `${dir}/paper-trades.jsonl.archive-${STAMP}`;
    // .bak files hold the pre-correction originals from the first (wrong-price) pass.
    const lines = fs.readFileSync(ledgerPath + ".bak", "utf8").trim().split("\n");
    scanLedger(engine, lines);
    const snap = JSON.parse(fs.readFileSync(snapPath + ".bak", "utf8"));
    console.log(engine, "archived cash (pre-correction):", snap.cashUsd, "positions:", Object.keys(snap.positions).length);

    if (engine === "main") {
      let fixed = 0;
      let cashDelta = 0;
      const out = lines.map((l) => {
        const t = JSON.parse(l);
        if (t.mint === MINT && t.reason === "shadow migration" && t.pnlUsd > 1000) {
          const costBasis = t.usd - t.pnlUsd;
          const newUsd = t.qty * realPrice;
          const newPnl = newUsd - costBasis;
          cashDelta += newUsd - t.usd;
          console.log(engine, "correcting:", JSON.stringify({ qty: t.qty, oldUsd: t.usd, oldPnl: t.pnlUsd, newUsd, newPnl, cashDelta }));
          t.priceUsd = realPrice;
          t.usd = newUsd;
          t.pnlUsd = newPnl;
          fixed++;
        }
        return JSON.stringify(t);
      });
      if (fixed !== 1) throw new Error(`expected exactly 1 phantom trade, found ${fixed}`);
      snap.cashUsd += cashDelta;
      console.log(engine, "cash:", snap.cashUsd - cashDelta, "->", snap.cashUsd);
      fs.writeFileSync(ledgerPath, out.join("\n") + "\n");
    }
    snap.lastResetId = RESET_ID;
    fs.writeFileSync(snapPath, JSON.stringify(snap));
  }
  console.log("SURGERY2 OK");
})().catch((e) => { console.error("SURGERY2 FAILED:", e.message); process.exit(1); });
