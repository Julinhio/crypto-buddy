import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { config, tradableBaseAssets } from '../config/index.js';
import { dec, type Decimal } from '../money.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { savePositionStates } from '../persistence/positionState.js';
import { claimManualRun, releaseManualRun } from '../persistence/schedulerState.js';

import { backfillOne, type Fill, type ObservedPrice } from '../portfolio/backfill.js';

/**
 * ONE-TIME BACKFILL of `position_state` (Strategy V2, PR 3 — mandate §9).
 *
 * This is the single exception to "never reconstruct the state at execution": it
 * INITIALIZES the state once, from the history that exists at the moment it runs.
 * Every cycle afterwards writes the state forward and never rebuilds it.
 *
 * Two rules the mandate makes imperative, because the bot keeps trading while the V2
 * is being built:
 *
 *  1. The peak is computed AT MIGRATION TIME from the history available at that
 *     instant. No value is hardcoded — the illustrative table in the mandate is a
 *     feasibility check, not an input, and it will have moved by the time this runs.
 *  2. The history starts at the LAST zero → positive transition of each position, not
 *     at the beginning of the table. The bot can still close a small line before the
 *     switch, and a line sold off and bought back would otherwise inherit the peak of
 *     a previous life.
 *
 * The peak is sampled from the SAME source the live cycle will use — the spot price
 * in each `decisions.market_context`, plus the valuation price of each booked fill.
 * Sampling the backfill from one source and the live ratchet from another would make
 * the peak jump the day the switch happened.
 *
 * DELIBERATELY NOT AUTOMATIC. It writes state; it runs once, by hand, after the
 * migration and before the deploy, and it refuses to overwrite an existing state
 * unless asked (`--force`).
 *
 * Run with `npm run backfill:position-state`.
 */


/** Every booked fill, oldest first. Only `executed` intents ever moved the book. */
async function loadFills(supabase: NonNullable<ReturnType<typeof getSupabaseClient>>): Promise<Fill[]> {
  const fills: Fill[] = [];
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('executions')
      .select('created_at, symbol, ledger_base_delta, valuation_price')
      .eq('event_type', 'intent')
      .eq('validation_status', 'executed')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`backfill: could not read executions (${error.message}).`);
    const page = (data ?? []) as Array<{
      created_at: string;
      symbol: string;
      ledger_base_delta: string;
      valuation_price: string;
    }>;
    for (const row of page) {
      const asset = row.symbol.split('/')[0];
      if (!asset) continue;
      fills.push({
        at: row.created_at,
        asset,
        baseDelta: dec(row.ledger_base_delta),
        price: dec(row.valuation_price),
      });
    }
    if (page.length < PAGE) break;
  }
  return fills;
}

/** The equity the bot recorded at each cycle, oldest first — the significance denominator. */
export interface EquitySample {
  at: string;
  equity: Decimal;
}

/**
 * The equity in force at a timestamp: the latest cycle at or before it. Fills happen
 * during a cycle, so the cycle that produced them is the right denominator — using a
 * later one would measure a movement against a book it helped create.
 */
export function equityLookup(samples: EquitySample[]): (at: string) => Decimal | null {
  const sorted = [...samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (at: string): Decimal | null => {
    const t = Date.parse(at);
    let found: Decimal | null = null;
    for (const s of sorted) {
      if (Date.parse(s.at) > t) break;
      found = s.equity;
    }
    return found;
  };
}

/** Every spot price and equity the bot ever recorded, with timestamps. */
async function loadObservedPrices(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
): Promise<{ prices: Map<string, ObservedPrice[]>; equity: EquitySample[] }> {
  const observed = new Map<string, ObservedPrice[]>();
  const equity: EquitySample[] = [];
  const PAGE = 200; // market_context rows are large; keep the pages modest
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('decisions')
      .select('created_at, market_context')
      .not('market_context', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`backfill: could not read decisions (${error.message}).`);
    const page = (data ?? []) as Array<{ created_at: string; market_context: unknown }>;
    for (const row of page) {
      const ctx = row.market_context as {
        market?: { tradable?: Array<{ symbol?: string; price?: number }> };
        account?: { portfolio?: { equity?: number } };
      };
      for (const pair of ctx?.market?.tradable ?? []) {
        const asset = pair.symbol?.split('/')[0];
        if (!asset || typeof pair.price !== 'number' || !Number.isFinite(pair.price) || pair.price <= 0) continue;
        const list = observed.get(asset) ?? [];
        list.push({ at: row.created_at, price: dec(pair.price) });
        observed.set(asset, list);
      }
      const eq = ctx?.account?.portfolio?.equity;
      if (typeof eq === 'number' && Number.isFinite(eq) && eq > 0) {
        equity.push({ at: row.created_at, equity: dec(eq) });
      }
    }
    if (page.length < PAGE) break;
  }
  return { prices: observed, equity };
}

/**
 * Does this process STILL own the run-lock it claimed?
 *
 * Holding the lease at the start is not the same as holding it at the write. The
 * history reads are paginated and could, on a bad day, outlast `lockTtlSeconds`; a
 * scheduled cycle would then reclaim the lease, book a fill, and this stale rebuild
 * would overwrite the result with a snapshot of a ledger that no longer exists —
 * discovering the loss only from the release warning, after the damage.
 *
 * Same fencing idea the scheduler uses on `finishRun`: verify ownership immediately
 * before the write. It cannot close the window to zero, but it shrinks it from
 * minutes to milliseconds, and the deadline check below refuses to even try once the
 * lease is near expiry.
 */
async function stillOwnsRun(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  runToken: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('bot_state')
    .select('run_token, locked_until')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`backfill: could not verify the run-lock (${error.message}).`);
  const row = data as { run_token: string | null; locked_until: string | null };
  if (row.run_token !== runToken) return false;
  return row.locked_until != null && Date.parse(row.locked_until) > Date.now();
}

/** Margin before the lease expires within which we refuse to start the write at all. */
const LEASE_MARGIN_MS = 30_000;

/** The whole rebuild, run while the run-lock is HELD. */
async function rebuild(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  force: boolean,
  runToken: string,
  claimedAt: number,
): Promise<number> {
  const { count, error: countError } = await supabase
    .from('position_state')
    .select('*', { count: 'exact', head: true });
  if (countError) throw new Error(`backfill: could not read position_state (${countError.message}).`);
  if ((count ?? 0) > 0 && !force) {
    console.error(
      `[backfill] position_state already holds ${count} row(s) — refusing to overwrite. ` +
        'This is a ONE-TIME initialization; re-running it would rewrite state the live cycles have ' +
        'been maintaining since. Pass --force only if you know the existing state is wrong.',
    );
    return 1;
  }

  const [fills, observed] = await Promise.all([loadFills(supabase), loadObservedPrices(supabase)]);
  const equityAt = equityLookup(observed.equity);
  const now = new Date().toISOString();
  console.log('='.repeat(96));
  console.log(`POSITION STATE BACKFILL — computed at ${now}`);
  console.log(
    `${fills.length} booked fills, ` +
      `${[...observed.prices.values()].reduce((n, l) => n + l.length, 0)} price observations, ` +
      `${observed.equity.length} equity samples`,
  );
  console.log(
    `significance: a move counts only at or above ${config.execution.minMovementPercent}% of the equity ` +
      'in force at that moment — the same floor the executor now enforces',
  );
  console.log('='.repeat(96));

  const states = tradableBaseAssets(config).map((asset) =>
    backfillOne({
      asset,
      fills,
      observed: observed.prices.get(asset) ?? [],
      equityAt,
      minMovementPercent: config.execution.minMovementPercent,
    }),
  );

  for (const s of states) {
    const spot = (observed.prices.get(s.asset) ?? []).at(-1)?.price ?? null;
    const gap =
      s.peakPriceSinceEntry && spot ? spot.minus(s.peakPriceSinceEntry).div(s.peakPriceSinceEntry).times(100) : null;
    const move =
      s.lastSignificantMoveAt == null
        ? 'none'
        : `${s.lastSignificantMoveSide} ${s.lastSignificantMoveNotional?.toFixed(2)} on ${s.lastSignificantMoveAt.slice(0, 10)}`;
    console.log(
      `  ${s.asset.padEnd(4, ' ')} entry ${s.entryDate?.slice(0, 19) ?? 'flat'}  ` +
        `qty ${s.qty.toString().padStart(10, ' ')}  ` +
        `peak ${s.peakPriceSinceEntry?.toString().padStart(12, ' ') ?? 'n/a'}  ` +
        `last ${spot?.toString().padStart(12, ' ') ?? 'n/a'}  ` +
        `gap ${(gap ? `${gap.toFixed(1)}%` : 'n/a').padStart(7, ' ')}  ` +
        `last significant move: ${move}`,
    );
  }

  // FENCE the write. A deterministic deadline first (no round trip, cannot itself
  // stall), then an ownership check on the lease. Either failing means the snapshot
  // above may already describe a ledger someone else has moved on from — the only safe
  // move is to write nothing and let the operator re-run.
  const elapsedMs = Date.now() - claimedAt;
  const leaseMs = config.scheduler.lockTtlSeconds * 1000;
  if (elapsedMs > leaseMs - LEASE_MARGIN_MS) {
    console.error(
      `[backfill] the history reads took ${Math.round(elapsedMs / 1000)}s of a ` +
        `${config.scheduler.lockTtlSeconds}s lease — too close to expiry to write safely. ` +
        'Nothing was written; re-run when the base is quieter.',
    );
    return 1;
  }
  if (!(await stillOwnsRun(supabase, runToken))) {
    console.error(
      '[backfill] the run-lock was reclaimed while the history was being read — a cycle may have ' +
        'booked since. Writing now would overwrite it with a stale snapshot. Nothing was written; re-run.',
    );
    return 1;
  }

  const written = await savePositionStates(supabase, states, now);
  if (!written) {
    console.error('[backfill] the write did NOT succeed — nothing was initialized.');
    return 1;
  }
  console.log('');
  console.log(
    `[backfill] ${states.length} rows written. The peak is the TRUE historical high since each entry, ` +
      'not the price of the switch day: restarting from today would hide a real drawdown and lie to the ' +
      'bot about its own past. No catch-up liquidation is triggered by this — the first v5 wake-up ' +
      'evaluates these lines under the normal rules.',
  );
  return 0;
}

/**
 * Takes the bot's EXISTING run-lock — the same one `npm run decide` claims — and holds
 * it across the history reads AND the final write.
 *
 * Without it the rebuild races the bot: a cycle that books an intent after the fills
 * are read but before the state is written would produce a row describing a ledger
 * that no longer exists. The quantity would be corrected by the next live cycle, but
 * that cycle would then register a NEW entry and lose the intervening move for good —
 * and an exit caught in the same window would lose its true timestamp.
 *
 * This matters for the RESET path, not for the first initialization. After migration
 * 0018, `reset_bot` truncates `position_state`, so a rebuild now happens against a bot
 * that is running. Reusing the existing lock rather than inventing a second mechanism
 * is deliberate: two mutual-exclusion schemes over the same state is how they end up
 * disagreeing.
 */
async function main(): Promise<number> {
  const force = process.argv.includes('--force');
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('backfill: Supabase is not configured.');

  const runToken = randomUUID();
  const claimedAt = Date.now();
  const claimed = await claimManualRun(supabase, runToken, config.scheduler.lockTtlSeconds);
  if (!claimed) {
    console.error(
      '[backfill] the bot is mid-cycle (run-lock held) — refusing to rebuild. A fill booked ' +
        'between the history read and the write would be silently lost. Retry shortly.',
    );
    return 1;
  }

  try {
    return await rebuild(supabase, force, runToken, claimedAt);
  } finally {
    if (!(await releaseManualRun(supabase, runToken))) {
      console.warn('[backfill] the run-lock was already reclaimed (the rebuild overran its TTL) before release.');
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Position state backfill failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
