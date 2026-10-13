const fs = require("fs");

const DIR = "/app/data";
const STAMP = process.argv[2];
const RESET_ID = process.argv[3];

(async () => {
  // Real BONK price right now (the position would be marked at this price).
  const res = await fetch("https://api.dexscreener.com/latest/dex/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
  const json = await res.json();
  const pairs = (json.pairs ?? []).filter((p) => p.chainId === "solana" && p.baseToken?.address === "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" && Number(p.priceUsd) > 0);
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const realPrice = Number(pairs[0]?.priceUsd);
  if (!realPrice || !Number.isFinite(realPrice)) throw new Error("no real BONK price");
  console.log("real BONK price:", realPrice);

  for (const [engine, dir] of [["main", DIR], ["shadow-sim", DIR + "/shadow-sim"]]) {
    // Boot restore uses one stamp for both engines; normalize shadow-sim's
    // archive name (originals kept under their own stamp as backup).
    if (engine === "shadow-sim") {
      const altStamp = STAMP.replace("00-32-27-415Z", "00-32-27-416Z");
      for (const base of ["positions-snapshot.json", "paper-trades.jsonl"]) {
        const src = `${dir}/${base}.archive-${altStamp}`;
        const dst = `${dir}/${base}.archive-${STAMP}`;
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
      }
    }
    const snapPath = `${dir}/positions-snapshot.json.archive-${STAMP}`;
    const ledgerPath = `${dir}/paper-trades.jsonl.archive-${STAMP}`;
    fs.copyFileSync(snapPath, snapPath + ".bak");
    fs.copyFileSync(ledgerPath, ledgerPath + ".bak");

    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");

    if (engine === "main") {
      let fixed = 0;
      let cashDelta = 0;
      const out = lines.map((l) => {
        const t = JSON.parse(l);
        if (t.mint === "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" && t.reason === "shadow migration" && t.pnlUsd > 1000) {
          const costBasis = t.usd - t.pnlUsd;
          const newUsd = t.qty * realPrice;
          const newPnl = newUsd - costBasis;
          cashDelta += newUsd - t.usd;
          console.log("phantom trade:", JSON.stringify({ ts: t.ts, qty: t.qty, oldUsd: t.usd, oldPnl: t.pnlUsd, newUsd, newPnl, cashDelta }));
          t.priceUsd = realPrice;
          t.usd = newUsd;
          t.pnlUsd = newPnl;
          fixed++;
        }
        return JSON.stringify(t);
      });
      if (fixed !== 1) throw new Error(`expected exactly 1 phantom trade, found ${fixed}`);
      snap.cashUsd += cashDelta;
      console.log(engine, "cash:", snap.cashUsd - cashDelta, "->", snap.cashUsd, "positions:", Object.keys(snap.positions).length);
      fs.writeFileSync(ledgerPath, out.join("\n") + "\n");
    } else {
      console.log(engine, "cash:", snap.cashUsd, "positions:", Object.keys(snap.positions).length, "ledger lines:", lines.length, "(unchanged)");
    }
    snap.lastResetId = RESET_ID;
    fs.writeFileSync(snapPath, JSON.stringify(snap));
  }
  console.log("SURGERY OK");
})().catch((e) => { console.error("SURGERY FAILED:", e.message); process.exit(1); });
