import type { Exchange } from 'ccxt';

export interface AssetBalance {
  asset: string;
  free: number;
  used: number;
  total: number;
}

/**
 * Reads account balances but keeps ONLY the relevant assets: the quote
 * currency (USDT) and the base assets of tradable pairs (see
 * `tradableAssets` in config).
 *
 * The testnet seeds hundreds of unrelated assets into every account; without
 * this allowlist the context package would be drowned in noise the bot never
 * touches. Reference-watchlist assets are intentionally absent — we never
 * hold or allocate them.
 *
 * Relevant assets are returned even when their balance is zero, so the LLM
 * always sees the full current allocation of what it can trade (holding 0 of
 * a tradable asset is itself decision-relevant).
 */
export async function fetchRelevantBalances(
  exchange: Exchange,
  relevantAssets: Set<string>,
): Promise<AssetBalance[]> {
  const raw = await exchange.fetchBalance();
  const totals = (raw.total ?? {}) as Record<string, number>;
  const frees = (raw.free ?? {}) as Record<string, number>;
  const useds = (raw.used ?? {}) as Record<string, number>;

  const out: AssetBalance[] = [];
  for (const asset of relevantAssets) {
    out.push({
      asset,
      free: Number(frees[asset] ?? 0),
      used: Number(useds[asset] ?? 0),
      total: Number(totals[asset] ?? 0),
    });
  }

  out.sort((a, b) => b.total - a.total);
  return out;
}
