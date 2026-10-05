import { createLogger } from "../logger.js";
import { extractTrades } from "./decoder.js";
import type { SolRpc } from "./rpc.js";
import type { TradeEvent } from "./types.js";

const log = createLogger("watcher");
const SIGS_PER_POLL = 12;

export class WalletWatcher {
  private stopped = false;

  constructor(
    private rpc: SolRpc,
    private wallets: string[],
    private onTrades: (events: TradeEvent[]) => Promise<void>,
    private pollMs: number,
    /** Shared, persisted: mutated in place so restarts skip old history. */
    private lastSigByWallet: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    for (const w of this.wallets) {
      if (this.lastSigByWallet[w]) continue;
      try {
        const sigs = await this.rpc.getSignaturesForAddress(w, 1);
        this.lastSigByWallet[w] = sigs[0]?.signature ?? "";
        log.info(`watching ${short(w)} from ${short(this.lastSigByWallet[w])} (history skipped)`);
      } catch (err) {
        log.error(`failed to init wallet ${short(w)}: ${String(err)}`);
      }
    }
    this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const started = Date.now();
      for (const w of this.wallets) {
        if (this.stopped) break;
        try {
          await this.pollWallet(w);
        } catch (err) {
          log.warn(`poll ${short(w)} failed: ${String(err)}`);
        }
      }
      const elapsed = Date.now() - started;
      const wait = Math.max(250, this.pollMs - elapsed);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async pollWallet(wallet: string): Promise<void> {
    const sigs = await this.rpc.getSignaturesForAddress(wallet, SIGS_PER_POLL);
    if (sigs.length === 0) return;

    const last = this.lastSigByWallet[wallet];
    let fresh: typeof sigs;
    if (!last) {
      fresh = [];
    } else {
      const idx = sigs.findIndex((s) => s.signature === last);
      if (idx === -1 && sigs.length >= SIGS_PER_POLL) {
        log.warn(`${short(wallet)} has more new sigs than we fetched; taking newest ${SIGS_PER_POLL}`);
        fresh = sigs;
      } else {
        fresh = sigs.slice(0, idx === -1 ? sigs.length : idx);
      }
    }
    if (fresh.length === 0) return;

    // sigs are newest-first; process oldest -> newest.
    const ordered = [...fresh].reverse();
    this.lastSigByWallet[wallet] = sigs[0]!.signature;

    const events: TradeEvent[] = [];
    for (const s of ordered) {
      if (s.err) continue; // failed tx: no effective balance change
      const tx = await this.rpc.getTransaction(s.signature);
      if (!tx) continue;
      events.push(...extractTrades(tx, wallet));
    }
    if (events.length > 0) {
      log.info(`${short(wallet)}: ${ordered.length} new tx(s), ${events.length} trade event(s)`);
      await this.onTrades(events);
    }
  }
}

export function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}
