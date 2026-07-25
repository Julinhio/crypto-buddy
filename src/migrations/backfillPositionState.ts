import 'dotenv/config';
import { config, tradableBaseAssets } from '../config/index.js';
import { dec, type Decimal } from '../money.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { savePositionStates } from '../persistence/positionState.js';

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

/** Every spot price the bot ever recorded, per asset, with its timestamp. */
async function loadObservedPrices(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
): Promise<Map<string, ObservedPrice[]>> {
  const observed = new Map<string, ObservedPrice[]>();
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
      const ctx = row.market_context as { market?: { tradable?: Array<{ symbol?: string; price?: number }> } };
      for (const pair of ctx?.market?.tradable ?? []) {
        const asset = pair.symbol?.split('/')[0];
        if (!asset || typeof pair.price !== 'number' || !Number.isFinite(pair.price) || pair.price <= 0) continue;
        const list = observed.get(asset) ?? [];
        list.push({ at: row.created_at, price: dec(pair.price) });
        observed.set(asset, list);
      }
    }
    if (page.length < PAGE) break;
  }
  return observed;
}

async function main(): Promise<number> {
  const force = process.argv.includes('--force');
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('backfill: Supabase is not configured.');

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
  const now = new Date().toISOString();
  console.log('='.repeat(96));
  console.log(`POSITION STATE BACKFILL — computed at ${now}`);
  console.log(`${fills.length} booked fills, ${[...observed.values()].reduce((n, l) => n + l.length, 0)} price observations`);
  console.log('='.repeat(96));

  const states = tradableBaseAssets(config).map((asset) =>
    backfillOne(asset, fills, observed.get(asset) ?? []),
  );

  for (const s of states) {
    const spot = (observed.get(s.asset) ?? []).at(-1)?.price ?? null;
    const gap =
      s.peakPriceSinceEntry && spot ? spot.minus(s.peakPriceSinceEntry).div(s.peakPriceSinceEntry).times(100) : null;
    console.log(
      `  ${s.asset.padEnd(4, ' ')} entry ${s.entryDate?.slice(0, 19) ?? 'flat'}  ` +
        `qty ${s.qty.toString().padStart(10, ' ')}  ` +
        `peak ${s.peakPriceSinceEntry?.toString().padStart(12, ' ') ?? 'n/a'}  ` +
        `last ${spot?.toString().padStart(12, ' ') ?? 'n/a'}  ` +
        `gap ${gap ? `${gap.toFixed(1)}%` : 'n/a'}`,
    );
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

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Position state backfill failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
