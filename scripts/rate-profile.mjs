const KEY = process.env.SOLANA_RPC_URL || "";
if (!KEY) {
  console.error("set SOLANA_RPC_URL (e.g. https://mainnet.helius-rpc.com/?api-key=...)");
  process.exit(1);
}
const wallets = {
  "9BMz": "9BMzTpSo4URse1oN666pmexhdjpU1vA5p7LtroCFQdLU",
  "3bza": "3bzaJd5yZG73EVDz8xosQb7gfZm2LN5auFGh6wnP1n1f",
  ACTb: "ACTbvbNm5qTLuofNRPxFPMtHAAtdH1CtzhCZatYHy831",
  GijF: "GijFWw4oNyh9ko3FaZforNsi3jk6wDovARpkKahPD4o5",
  "4vw5": "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9",
  "29yF": "29yFzeBZgxf5zqrAkKXwgZtQehRf4pL8WbV2nRJikbw8",
  ardi: "ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT",
  BvAp: "BvApEL9H3nnn2mezyUQQsSxvnwwBpkVFF3Yh61MZSruZ",
  "3VUN": "3VUNtVtjjx5ckUojT7UocJ5fbuAJRsNUXNfTBnPte9vC",
  EeXv: "EeXvxkcGqMDZeTaVeawzxm9mbzZwqDUMmfG3bF7uzumH",
  DkjB: "DkjBeKvadAtE3d8ZBvhp1AhmqBdzTM6URUUXgKKjGeQQ",
  AimU: "AimUs5AnmPfyCzDdUhvz4BTvb2fGsNonAb8uuSyHByw9",
  CHCL: "CHCLtC1AWpSshZkiU8TNoNn9r7CHecVhTakuao7u4aBX",
  "4b3Z": "4b3ZctHLzPBQt3biFbDWp12hf6ADkaruQx4aj9kiDQKh",
  "9LXW": "9LXWa7V3AE15VfBupcx5gDts2ix3Y9NzbcKZKjkkq6hV",
  GeUn: "GeUnv1jmtviRbR7Gu1JnXSGkUMUgFVBHuEVQVpTaUX1W",
};
(async () => {
  for (const [tag, w] of Object.entries(wallets)) {
    try {
      const r = await fetch("https://mainnet.helius-rpc.com/?api-key=" + KEY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [w, { limit: 200 }] }),
      });
      const j = await r.json();
      const sigs = j.result || [];
      const times = sigs.map((s) => s.blockTime).filter(Boolean).sort((a, b) => a - b);
      const spanH = times.length > 1 ? (times[times.length - 1] - times[0]) / 3600 : 0;
      const perH = spanH > 0 ? Math.round(sigs.length / spanH) : null;
      const fail = sigs.length ? Math.round((100 * sigs.filter((s) => s.err).length) / sigs.length) : 0;
      console.log(
        tag.padEnd(5),
        ("sigs:" + sigs.length).padEnd(10),
        ("span:" + (spanH ? spanH.toFixed(1) + "h" : "?")).padEnd(10),
        ("tx/h:" + (perH === null ? "?" : perH)).padEnd(12),
        ("fail:" + fail + "%").padEnd(9),
      );
    } catch (e) {
      console.log(tag, "ERR", String(e).slice(0, 60));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
})();
