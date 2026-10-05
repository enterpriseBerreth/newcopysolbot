import { createLogger } from "../logger.js";

const log = createLogger("rpc");

export class SolRpc {
  constructor(private url: string) {}

  async call<T>(method: string, params: unknown[], retries = 3): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`rpc ${method} -> HTTP ${res.status}`);
        }
        const json = (await res.json()) as { result?: T; error?: { message: string } };
        if (json.error) throw new Error(`rpc ${method} -> ${json.error.message}`);
        if (json.result === undefined) throw new Error(`rpc ${method} -> empty result`);
        return json.result;
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          const delay = 750 * 2 ** attempt;
          log.warn(`${method} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${String(err)}`);
          await sleep(delay);
        }
      }
    }
    throw lastErr;
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
  tokenAmount: { uiAmount: number | null; decimals: number };
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
