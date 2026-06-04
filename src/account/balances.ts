import type { Exchange } from 'ccxt';

export interface AssetBalance {
  asset: string;
  free: number;
  used: number;
  total: number;
}

export async function fetchNonZeroBalances(
  exchange: Exchange,
): Promise<AssetBalance[]> {
  const raw = await exchange.fetchBalance();
  const out: AssetBalance[] = [];

  for (const [asset, entry] of Object.entries(raw.total ?? {})) {
    const total = Number(entry ?? 0);
    if (!Number.isFinite(total) || total === 0) continue;

    const free = Number((raw.free as Record<string, number> | undefined)?.[asset] ?? 0);
    const used = Number((raw.used as Record<string, number> | undefined)?.[asset] ?? 0);

    out.push({ asset, free, used, total });
  }

  out.sort((a, b) => b.total - a.total);
  return out;
}
