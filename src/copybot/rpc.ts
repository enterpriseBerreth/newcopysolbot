import { createLogger } from "../logger.js";

const log = createLogger("rpc");

export class SolRpc {
  /** Serialized request chain: enforces global spacing between RPC calls. */
  private chain: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(
    private url: string,
    /** Minimum spacing between any two RPC calls (ms). Keeps us under provider rate limits. */
    private minIntervalMs = 120,
  ) {}

  async call<T>(method: string, params: unknown[], retries = 3): Promise<T> {
    const run = async (): Promise<T> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const gap = this.minIntervalMs - (Date.now() - this.lastCallAt);
          if (gap > 0) await sleep(gap);
          this.lastCallAt = Date.now();
          const res = await fetch(this.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(20_000),
          });
          if (res.status === 429) {
            const retryAfter = Number(res.headers.get("retry-after"));
            const cooldown = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000;
            this.minIntervalMs = Math.min(5_000, Math.max(this.minIntervalMs * 2, 1_000));
            await sleep(Math.min(60_000, cooldown));
            throw new Error(`rpc ${method} -> HTTP 429`);
          }
          if (res.status >= 500) throw new Error(`rpc ${method} -> HTTP ${res.status}`);
          const json = (await res.json()) as { result?: T; error?: { message: string } };
          if (json.error) throw new Error(`rpc ${method} -> ${json.error.message}`);
          if (json.result === undefined) throw new Error(`rpc ${method} -> empty result`);
          return json.result;
        } catch (err) {
          lastErr = err;
          if (attempt < retries) {
            const delay = 1000 * 2 ** attempt;
            log.warn(`${method} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${String(err)}`);
            await sleep(delay);
          }
        }
      }
      throw lastErr;
    };
    const p = this.chain.then(run, run) as Promise<T>;
    this.chain = p.catch(() => {});
    return p;
  }

  getSignaturesForAddress(address: string, limit: number) {
    return this.call<Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>>(
      "getSignaturesForAddress",
      [address, { limit }],
    );
  }

  getTransaction(signature: string) {
    // version 1 txs now exist on mainnet; maxSupportedTransactionVersion: 1
    // accepts legacy, v0 and v1.
    return this.call<JsonTransaction | null>("getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
    ]);
  }
}

export interface JsonAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
  source?: string;
}

export interface JsonTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { uiAmount: number | null; uiAmountString?: string; decimals: number };
}

export interface JsonTransaction {
  blockTime: number | null;
  slot: number;
  transaction: {
    message: { accountKeys: JsonAccountKey[] };
    signatures: string[];
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: JsonTokenBalance[];
    postTokenBalances?: JsonTokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
