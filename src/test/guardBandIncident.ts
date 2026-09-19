import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KNOWN_MARK_KINDS } from '../persistence/decisionIntegrityMarks.js';
import { judge, type StoredContext } from '../replay/storedCycle.js';
import type { ValidatedDecision } from '../decision/schema.js';

/**
 * THE GUARD/BAND INCIDENT (18-19/09/2026) — the measurement-integrity half, proven on the
 * artefacts that carry it: migration 0039 and the cycle that writes the guard's state.
 *
 * The guard's new frontier is proven in `coherence.ts`; the reader of the marks in
 * `exposureWitness.ts` (proof 16). This file pins what a migration and a writer must say,
 * because nothing at runtime would catch a reset_bot that forgot the new table, or a row
 * written without the guard's state.
 */

let passed = 0;
const ok = (label: string, condition: boolean): void => {
  assert.ok(condition, label);
  console.log(`  ok: ${label}`);
  passed += 1;
};

const ROOT = process.cwd();
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

console.log('\nMigration 0039 — additive, guarded, and known to reset_bot:');
{
  const migration = read('supabase/migrations/0039_guard_state_and_integrity_marks.sql');

  // 1. The guard's state: a nullable column, no default, no backfill.
  ok('the column is added nullable, without a default', /add column if not exists coherence_guard_armed boolean;/.test(migration));
  ok('and no existing decisions row is rewritten — no UPDATE, no backfill', !/update\s+public\.decisions/i.test(migration));

  // 2. The marks table.
  ok('the marks table references decisions with ON DELETE CASCADE', /decision_id bigint not null references public\.decisions \(id\) on delete cascade/.test(migration));
  const kinds = /check \(kind in \(([^)]*)\)\)/.exec(migration)?.[1] ?? '';
  const kindList = [...kinds.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  ok('the two kinds are CHECK-constrained', kindList.length === 2 && kindList.includes('selection_par_le_garde') && kindList.includes('relance_orientee_par_le_garde'));
  ok('and they are exactly the kinds the reader knows — the two cannot drift apart', kindList.every((k) => KNOWN_MARK_KINDS.has(k)) && KNOWN_MARK_KINDS.size === kindList.length);
  ok('one mark per (decision, kind)', /unique \(decision_id, kind\)/.test(migration));
  ok('RLS is enabled, deny-all like every other table', /alter table public\.decision_integrity_marks enable row level security;/.test(migration));

  // 3. reset_bot: the rule the 0025 wrote and the 0031 restated — every table with a FK to
  //    decisions is in the TRUNCATE list AND in the grant.
  const previous = read('supabase/migrations/0031_reset_bot_exposure_band_corrections.sql');
  const listOf = (source: string, keyword: RegExp): string[] => {
    const block = keyword.exec(source)?.[1] ?? '';
    return [...block.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]!);
  };
  const truncateBefore = listOf(previous, /truncate table\s+([\s\S]*?);/);
  const truncateNow = listOf(migration, /truncate table\s+([\s\S]*?);/);
  const grantNow = listOf(migration, /grant truncate on table\s+([\s\S]*?)\s+to service_role;/);
  ok('the TRUNCATE list is the 0031 list plus the marks table, nothing dropped', truncateBefore.every((t) => truncateNow.includes(t)) && truncateNow.includes('decision_integrity_marks') && truncateNow.length === truncateBefore.length + 1);
  ok('and the grant lists exactly the same tables', truncateNow.length === grantNow.length && truncateNow.every((t) => grantNow.includes(t)));
  ok('the function comment names the new table', /decision_integrity_marks \(pg-safeupdate-safe/.test(migration));

  // 4. The four marks: hand-listed, and each GUARDED by the existence of a decided row.
  ok('the four incident cycles are the arbitrated ones', /\(values \(2115\), \(2124\), \(2125\), \(2126\)\) as v \(id\)/.test(migration));
  ok('and a mark is only inserted where a DECIDED row with that id exists', /where exists \(select 1 from public\.decisions d where d\.id = v\.id and d\.status = 'decided'\)/.test(migration));
  ok('the selection marks carry their durable reason and their source', /'selection_par_le_garde',\s*\n\s*'Incident garde\/bande des 18-19\/09\/2026/.test(migration) && /'PR #48 \(fix\/guard-band-hold\) — migration 0039, arbitrage du 19\/09\/2026'/.test(migration));

  // 5. The relaunch marks: derived from the guard's journal and nothing else, inside the
  //    pilot's window, first attempt parsed from the guard's own formatting.
  ok('the relaunch marks are derived from guard_recovered_on_retry events', /from public\.decision_guard_events e\s*\n\s*join public\.decisions d on d\.id = e\.decision_id and d\.status = 'decided'\s*\n\s*where e\.event_type = 'guard_recovered_on_retry'/.test(migration));
  ok('bounded by the pilot\'s activation cycle', /e\.decision_id >= \(select p\.activated_decision_id\s*\n\s*from public\.exposure_pilot p/.test(migration));
  ok('the first attempt is parsed from the "emitted [...]" the guard itself formats', /substring\(e\.detail from 'emitted \\\[\(\[\^\]\]\*\)\\\]'\)/.test(migration));
  ok('both inserts are idempotent', (migration.match(/on conflict \(decision_id, kind\) do nothing;/g) ?? []).length === 2);
}

console.log('\nThe cycle writes the guard\'s state on every row, and nothing writes the marks:');
{
  const decide = read('src/decision/decide.ts');
  ok('makeRow journals COHERENCE_GUARD as coherence_guard_armed on every status', /coherence_guard_armed: COHERENCE_GUARD,/.test(decide));
  const row = read('src/persistence/decisions.ts');
  ok('the DecisionRow contract carries the nullable column', /coherence_guard_armed: boolean \| null;/.test(row));

  // Only migrations write marks. The code reads them, and only from the measurement's
  // readers — never from the trading path.
  const srcFiles = [
    'src/persistence/decisionIntegrityMarks.ts',
    'src/replay/exposureBandWitnesses.ts',
    'src/exposure/adoption.ts',
    'src/decision/decide.ts',
    'src/beat.ts',
    'src/scheduler/heartbeat.ts',
  ].map((f) => [f, read(f)] as const);
  ok('no code path inserts, updates or deletes a mark', srcFiles.every(([, s]) => !/decision_integrity_marks[\s\S]{0,300}\.(insert|update|delete|upsert)\(/.test(s)));
  ok('the trading path does not import the marks module', !/decisionIntegrityMarks/.test(read('src/decision/decide.ts')) && !/decisionIntegrityMarks/.test(read('src/beat.ts')) && !/decisionIntegrityMarks/.test(read('src/scheduler/heartbeat.ts')));
}

console.log('\nThe replay harness judges on the clamped proposal production saw, never re-clamped:');
{
  // A book of 1000 with XRP held at 15%, and a journaled clamp of XRP 20 — a value TODAY's
  // cap (15) would trim. The journal is what production's clamp produced under the caps of
  // its day; the harness must hand it to the guard verbatim, and say where it came from.
  const context: StoredContext = {
    market: { tradable: [{ symbol: 'XRP/USDT', price: 1 }, { symbol: 'BTC/USDT', price: 100 }] },
    account: {
      portfolio: {
        reserveAsset: 'USDT',
        startingCapital: 1000,
        cash: 850,
        equity: 1000,
        deployedPercent: 15,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        positions: [{ asset: 'XRP', qty: 150, avgCost: 1, price: 1, priceStale: false, value: 150, unrealizedPnl: 0, weightPercent: 15 }],
      },
    },
    positions: [],
  };
  const decision: ValidatedDecision = {
    targetAllocation: { XRP: 20, BTC: 0, USDT: 80 },
    actionType: 'rebalance',
    whatChanged: 'x',
    confidence: 'medium',
    marketState: null,
    reasoning: 'x',
    positionNotes: [{ asset: 'XRP', thesis: 't', invalidation: 'i', replace: false }],
    notificationSummary: 'x',
    requestedDelayMinutes: 60,
    appliedDelayMinutes: 60,
  };
  const references = { intent: { XRP: 15, BTC: 0, USDT: 85 }, applied: { XRP: 15, BTC: 0, USDT: 85 }, shownApplied: null };
  const journaled = { XRP: 20, BTC: 0, USDT: 80 };
  const withJournal = judge(decision, context, references, undefined, 'split', journaled);
  ok('the journaled clamp is the guard target, verbatim, above today\'s cap', withJournal.guardTarget.XRP === 20 && withJournal.guardTargetSource === 'journal_clamped');
  ok('and the movements the guard judged are sized from it (a real XRP buy)', withJournal.guardMovements.some((m) => m.asset === 'XRP' && m.side === 'buy'));
  const withoutJournal = judge(decision, context, references, undefined, 'split', null);
  ok('without a journal, the clamp is recomputed under today\'s caps and named as such', withoutJournal.guardTarget.XRP === 15 && withoutJournal.guardTargetSource === 'clamp_recomputed');
  const storedDiverging = judge(decision, context, references, { XRP: 20, BTC: 0, USDT: 80 }, 'split', null);
  ok('a stored applied that is not the recomputed clamp is not trusted as the guard target, and the divergence is named', storedDiverging.guardTargetSource === 'clamp_recomputed_diverges' && storedDiverging.guardTarget.XRP === 15);
  ok('while it remains what the next cycle reads back as its applied reference', storedDiverging.appliedAllocation.XRP === 20);
}

console.log(`\n${passed} guard/band-incident checks passed.`);
