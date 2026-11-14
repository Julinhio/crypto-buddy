import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { completeS4Notification, formatS4Activity, prepareS4Notification } from '../alerting/s4Activity.js';
import { formatDailySummary, gatherDailySummary, localNow } from '../alerting/dailySummary.js';
import { buildEquitySnapshot } from '../persistence/equitySnapshots.js';
import { readDecidingRows } from '../persistence/s4State.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { reserveStables } from '../decision/schema.js';
import {
  bookWith,
  decidingFromRows,
  feesOf,
  reportOf,
  type StoredJournalRow,
  type StoredPhoto,
  type StoredS4Cycle,
} from './s4StoredCycle.js';

/**
 * WHAT THE BOT SHOWS, REPLAYED ON WHAT IT RECORDED — chantier du 14/11/2026.
 *
 * READ-ONLY. Reads `decisions`, `executions`, `equity_snapshots`, `s4_close_decisions`,
 * `s4_pilot`, `bot_state` and `scheduler_runs`; writes nothing to the database, claims nothing,
 * sends nothing. Its only outputs are the terminal and, with `--fixture <file>`, a JSON copy of
 * the rows it read (the offline test replays that file).
 *
 *   npm run replay:display                       the pilot's three trading cycles
 *   npm run replay:display -- 3323               chosen cycles
 *   npm run replay:display -- --fixture <file>   also write the rows read
 *
 * For each cycle:
 *   1. the notification the new formatter writes — cause from `s4MoveReason`, values from the
 *      journal row of the deciding close;
 *   2. the photo: the one stored (taken BEFORE the orders until this change), the one the new
 *      code takes (after the orders and their fees), and the next cycle's stored photo, which is
 *      the first that showed the true book.
 * Then the daily summary as it would be sent now.
 */

const PILOT_CYCLES = [3278, 3293, 3323];
type Supabase = NonNullable<ReturnType<typeof getSupabaseClient>>;

async function loadPhoto(supabase: Supabase, decisionId: number): Promise<StoredPhoto | null> {
  const { data, error } = await supabase
    .from('equity_snapshots')
    .select('decision_id, equity_usd, cash_usd, positions')
    .eq('decision_id', decisionId)
    .maybeSingle();
  if (error) throw new Error(`equity_snapshots ${decisionId}: ${error.message}`);
  return (data as StoredPhoto | null) ?? null;
}

async function loadCycle(supabase: Supabase, id: number, reserveAsset: string): Promise<StoredS4Cycle | null> {
  const { data: row, error } = await supabase
    .from('decisions')
    .select('id, created_at, status, prompt_version, market_context')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`decisions ${id}: ${error.message}`);
  if (!row || row.status !== 'decided' || !String(row.prompt_version).startsWith('s4-')) return null;
  const mc = row.market_context as {
    pilot: StoredS4Cycle['pilot'];
    closesDecided: string[];
    lines: StoredS4Cycle['lines'];
    plan: StoredS4Cycle['plan'];
    book: StoredS4Cycle['book'];
  };
  const { data: intents, error: execError } = await supabase
    .from('executions')
    .select('id, symbol, side, valuation_price, ledger_base_delta, ledger_quote_delta, fee')
    .eq('decision_id', id)
    .eq('event_type', 'intent')
    .eq('validation_status', 'executed')
    .order('id', { ascending: true });
  if (execError) throw new Error(`executions ${id}: ${execError.message}`);
  const { data: next, error: nextError } = await supabase
    .from('decisions')
    .select('id')
    .gt('id', id)
    .eq('status', 'decided')
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (nextError) throw new Error(`decisions after ${id}: ${nextError.message}`);
  return {
    id,
    createdAt: String(row.created_at),
    reserveAsset,
    pilot: mc.pilot,
    closesDecided: mc.closesDecided ?? [],
    lines: mc.lines,
    plan: mc.plan,
    book: mc.book,
    intents: (intents ?? []) as StoredS4Cycle['intents'],
    photo: await loadPhoto(supabase, id),
    nextPhoto: next ? await loadPhoto(supabase, Number(next.id)) : null,
  };
}

const usd = (n: number): string => n.toFixed(2);
const composition = (p: { positions: Array<{ asset: string; qty: number }>; cash_usd: number }): string =>
  [...p.positions.map((x) => `${x.asset} ${x.qty}`), `cash ${usd(p.cash_usd)}`].join(' · ');

function box(title: string, text: string): void {
  console.log(`  ┌─ ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
  for (const line of text.split('\n')) console.log(`  │ ${line}`);
  console.log(`  └${'─'.repeat(61)}`);
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('display replay: Supabase is not configured.');
  const args = process.argv.slice(2);
  const fixtureAt = args.indexOf('--fixture');
  const fixturePath = fixtureAt >= 0 ? args[fixtureAt + 1] : undefined;
  const requested = args
    .filter((_, i) => fixtureAt < 0 || (i !== fixtureAt && i !== fixtureAt + 1))
    .flatMap((a) => a.split(','))
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const ids = requested.length > 0 ? requested : PILOT_CYCLES;
  const reserveAsset = reserveStables(config)[0] ?? 'USDT';

  console.log('DISPLAY RELIABILITY — replayed, read-only, on the values recorded in the database');
  console.log(`cycles: ${ids.join(', ')}`);

  const cycles: StoredS4Cycle[] = [];
  const journal: StoredJournalRow[] = [];
  let failures = 0;
  const check = (label: string, cond: boolean): void => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
    if (!cond) failures += 1;
  };

  for (const id of ids) {
    const cycle = await loadCycle(supabase, id, reserveAsset);
    if (!cycle) {
      console.log(`\n──── cycle ${id}: not a decided S4 cycle, skipped ────`);
      continue;
    }
    cycles.push(cycle);
    console.log(`\n──── cycle ${id} · ${cycle.createdAt} ────`);

    // 1. THE NOTIFICATION. The post-trade book is the allocation and total it shows.
    const after = bookWith(cycle.book, cycle.intents, reserveAsset);
    const prepared = prepareS4Notification(reportOf(cycle), after, cycle.createdAt);
    if (prepared) {
      const completed = await completeS4Notification(prepared, async (asset, kind, closeMs) => {
        const rows = await readDecidingRows(supabase, asset, kind, closeMs);
        if (!rows) return null;
        const stored: StoredJournalRow[] = [{ ...rows.row, asset }, ...(rows.previousOut ? [{ ...rows.previousOut, asset }] : [])];
        journal.push(...stored);
        return decidingFromRows(stored, asset, kind, closeMs);
      });
      box('notification', formatS4Activity(completed));
    } else {
      console.log('  no movement: no notification.');
    }

    // 2. THE PHOTO.
    const before = buildEquitySnapshot(id, bookWith(cycle.book, [], reserveAsset));
    const photo = buildEquitySnapshot(id, after);
    const fees = feesOf(cycle.intents);
    console.log(`  photo stored (before this change) : ${usd(cycle.photo?.equity_usd ?? NaN)} $ — ${cycle.photo ? composition(cycle.photo) : 'none'}`);
    console.log(`  photo taken by the new code       : ${usd(photo.equity_usd)} $ — ${composition(photo)}`);
    console.log(`  next cycle's stored photo (#${cycle.nextPhoto?.decision_id ?? '—'})  : ${usd(cycle.nextPhoto?.equity_usd ?? NaN)} $ — ${cycle.nextPhoto ? composition(cycle.nextPhoto) : 'none'}`);
    console.log(`  fees booked by this cycle         : ${fees.toFixed(4)} $`);
    if (cycle.photo) {
      check('the stored photo is the book BEFORE the orders (equity, cash, every quantity)',
        cycle.photo.equity_usd === before.equity_usd && cycle.photo.cash_usd === before.cash_usd &&
        JSON.stringify(cycle.photo.positions.map((p) => [p.asset, p.qty]).sort()) === JSON.stringify(before.positions.map((p) => [p.asset, p.qty]).sort()));
    }
    check('the new photo is that book after the fills: its equity is lower by exactly the fees',
      Math.abs(before.equity_usd - fees - photo.equity_usd) < 0.006);
    if (cycle.nextPhoto) {
      check('and it holds what the next cycle found: same cash, same quantities',
        cycle.nextPhoto.cash_usd === photo.cash_usd &&
        JSON.stringify(cycle.nextPhoto.positions.map((p) => [p.asset, p.qty]).sort()) === JSON.stringify(photo.positions.map((p) => [p.asset, p.qty]).sort()));
    }
  }

  // 3. THE DAILY SUMMARY, as it would be sent now. `gatherDailySummary` only reads.
  const now = new Date();
  const summary = await gatherDailySummary(supabase, now, localNow(now, config.dailySummary.timezone).label);
  console.log(`\n──── daily summary, as of ${now.toISOString()} (${config.dailySummary.timezone}) ────`);
  if (summary) box('bilan du jour', formatDailySummary(summary));
  else console.log('  no current photo: the summary would not be sent.');

  if (fixturePath) {
    const file = path.resolve(fixturePath);
    mkdirSync(path.dirname(file), { recursive: true });
    const unique = [...new Map(journal.map((r) => [`${r.asset}|${r.close_at}|${r.event}`, r])).values()];
    writeFileSync(file, `${JSON.stringify({ source: 'npm run replay:display -- --fixture', readAt: now.toISOString(), cycles, journal: unique }, null, 2)}\n`);
    console.log(`\nfixture written: ${file}`);
  }
  if (failures > 0) throw new Error(`display replay: ${failures} check(s) failed.`);
  console.log('\nAll replay checks passed. Nothing was written to the database.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
