import { createLogger } from "../logger.js";
import { extractTrades } from "./decoder.js";
import { short } from "./watcher.js";
import type { SolRpc } from "./rpc.js";
import type { TradeEvent } from "./types.js";

const log = createLogger("ws");

const MAX_QUEUE = 500;
const MAX_BACKOFF_MS = 30_000;

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

function defaultWsFactory(url: string): WsLike {
  const Ctor = (globalThis as unknown as { WebSocket: new (url: string) => WsLike }).WebSocket;
  return new Ctor(url);
}

/**
 * Push-based trade capture: one logsSubscribe over WebSocket for all tracked
 * wallets ("mentions"). Every confirmed tx that touches any wallet lands here
 * within ~1s — no polling race. HTTP polling keeps running as a fallback for
 * anything this stream drops (dedup happens in the engine).
 */
export class WsTradeWatcher {
  private ws: WsLike | null = null;
  private stopped = false;
  private queue: string[] = [];
  private queued = new Set<string>();
  private draining = false;
  private backoffMs = 1000;
  private nextId = 1;
  private subscriptions = new Set<number>();
  private recent = new Set<string>();
  private dropped = 0;

  get droppedNotifications(): number {
    return this.dropped;
  }

  get healthy(): boolean {
    return this.subscriptions.size === this.wallets.length && !this.stopped;
  }

  get pending(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }

  hasSeen(signature: string): boolean {
    return this.recent.has(signature);
  }

  constructor(
    private url: string,
    private rpc: SolRpc,
    private wallets: string[],
    private onTrades: (events: TradeEvent[]) => Promise<void>,
    private wsFactory: WsFactory = defaultWsFactory,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.subscriptions.clear();
    const ws = this.wsFactory(this.url);
    this.ws = ws;

    ws.onopen = () => {
      log.info(`connected; subscribing ${this.wallets.length} wallet(s) via logsSubscribe`);
      // One subscription per wallet: Solana RPCs (incl. Helius) accept only a
      // single address per logsSubscribe call, but many calls per connection.
      for (const w of this.wallets) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "logsSubscribe",
            params: [{ mentions: [w] }, { commitment: "confirmed" }],
          }),
        );
      }
      this.backoffMs = 1000;
    };

    ws.onmessage = (ev: { data: unknown }) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: number;
          method?: string;
          error?: unknown;
          params?: { result?: { value?: { signature?: string; err?: unknown } } };
        };
        if (msg.error) {
          log.warn(`ws rpc error: ${JSON.stringify(msg.error)}`);
          return;
        }
        if (typeof msg.id === "number" && typeof msg.result === "number") {
          this.subscriptions.add(msg.id);
          if (this.healthy) log.info(`all ${this.wallets.length} wallet subscriptions confirmed`);
          return;
        }
        if (msg.method !== "logsNotification") return;
        const value = msg.params?.result?.value;
        if (!value?.signature || value.err) return; // failed tx: nothing to copy
        this.enqueue(value.signature);
      } catch (err) {
        log.warn(`bad ws message: ${String(err)}`);
      }
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.subscriptions.clear();
      log.warn(`ws closed; reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    };
  }

  private enqueue(sig: string): void {
    if (this.queued.has(sig) || this.recent.has(sig)) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.dropped++;
      if (this.dropped === 1 || this.dropped % 100 === 0) {
        log.warn(`ws queue full (${MAX_QUEUE}); ${this.dropped} notifications dropped; provider throughput cannot keep up`);
      }
      return;
    }
    this.queued.add(sig);
    this.queue.push(sig);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const sig = this.queue.shift()!;
        try {
          const tx = await this.rpc.getTransaction(sig);
          if (tx) {
            const events: TradeEvent[] = [];
            for (const w of this.wallets) events.push(...extractTrades(tx, w));
            if (events.length > 0) await this.onTrades(events);
            this.recent.add(sig);
            if (this.recent.size > 2000) this.recent.delete(this.recent.values().next().value!);
          } else {
            log.warn(`transaction ${short(sig)} unavailable; polling will retry`);
          }
        } catch (err) {
          log.warn(`fetch ${short(sig)} failed: ${String(err)}`);
        } finally {
          this.queued.delete(sig);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
