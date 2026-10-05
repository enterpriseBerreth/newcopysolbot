export type Side = "buy" | "sell";

export interface TradeEvent {
  wallet: string;
  signature: string;
  blockTime: number;
  mint: string;
  side: Side;
  /** Absolute change in the copied wallet's balance of this mint. */
  tokenDelta: number;
  /** Copied wallet's post-tx balance of this mint (0 if fully exited). */
  remainingTokens: number;
  /** Native SOL change over the tx, in SOL (informational). */
  solDelta: number;
}

export interface Position {
  /** `${wallet}:${mint}` — per-wallet so exits map back to the right copy. */
  key: string;
  wallet: string;
  mint: string;
  symbol: string;
  qty: number;
  /** Total USD spent opening / topping up. */
  costUsd: number;
  openedAt: number;
  clipUsd: number;
}

export interface PaperTrade {
  id: string;
  ts: number;
  wallet: string;
  mint: string;
  symbol: string;
  side: Side;
  priceUsd: number;
  qty: number;
  /** USD moved by our paper account. */
  usd: number;
  /** Estimated notional of the copied wallet's trade. */
  walletTradeUsd: number;
  pnlUsd?: number;
  pnlPct?: number;
  reason: string;
  signature: string;
}

export interface PaperState {
  cashUsd: number;
  positions: Record<string, Position>;
  /** Last processed signature per wallet (restart dedup). */
  lastSigByWallet: Record<string, string>;
  /** Bounded ring of processed `${wallet}:${signature}` keys. */
  processedSigs: string[];
}

export interface PairInfo {
  priceUsd: number;
  liquidityUsd: number;
  symbol: string;
  dexId: string;
  pairUrl: string;
}

export interface WalletRankRow {
  wallet: string;
  short: string;
  dayPnl: number;
  dayTrades: number;
  dayPos: number;
  dayNeg: number;
  weekPnl: number;
  weekTrades: number;
  weekPos: number;
  weekNeg: number;
  unrealizedUsd: number;
  rank: number;
}
