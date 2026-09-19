import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getSupabaseClient } from '../persistence/supabase.js';
import type { ValidatedDecision } from '../decision/schema.js';
import type { CoherenceRule, CoherenceViolation } from '../decision/coherence.js';
import { writeArtefact } from '../provenance/artefacts.js';
import {
  decodeResponse,
  journaledClampOf,
  judge,
  universeOf,
  type JudgeResult,
  type ReplayReferences,
  type StoredCycle,
} from './storedCycle.js';
import { resolveEffectiveTarget, resolveIntentAllocation } from '../decision/effectiveTarget.js';

/**
 * THE GUARD/BAND INCIDENT, REPLAYED IN SITU — the acceptance proof of PR #48.
 *
 * Between cycles 2112 and 2131 (18-19/09/2026) the coherence guard refused fifteen of
 * nineteen cycles. The band had lifted the book from 33.75% to 45% of exposure at 2112, and
 * from then on a hold had no satisfiable answer: re-emitting the intention produced the
 * REVERSAL of the band's legs, which rule 4 read as lines moved without a thesis; re-emitting
 * the applied allocation was rule 1's "hold that moved the target". Two paths, both dead.
 *
 * This replay judges every response of the incident with the NEW guard, against the
 * references production actually had at that instant — the last `decided` row before the
 * cycle, exactly as `loadReferenceAllocations` reads them. IN SITU, not chained: a chained
 * replay would have to invent what the band re-corrected on cycles that never traded, and
 * the question is whether the guard's verdict was right, not what the pilot would have done.
 *
 * Both attempts of every failed cycle are judged. The SECOND is journaled verbatim
 * (`raw_response` holds the relaunch's answer). The FIRST is reconstructed from the guard's
 * own journal: a rule-1 rejection quotes the emitted allocation in its detail (`fmt()`, the
 * guard's formatting — not prose), and a first attempt rejected on rule 4 alone kept the
 * reference target by construction (rule 1 did not fire) and carried no notes (rule 4 did).
 * Both reconstructions are labelled as such on every line.
 *
 * Read-only: it reads `decisions`, `decision_guard_events` and the corrections journal, writes
 * nothing to the database, and places nothing. Run with `npm run replay:guard-band-incident`;
 * exits non-zero if a criterion fails.
 */

const INCIDENT = { firstId: 2112, lastId: 2131 } as const;
const OUT_DIR = path.join(process.cwd(), 'out', 'guard-band-incident');

interface Criterion {
  id: string;
  passed: boolean;
}
const results: Criterion[] = [];
function record(id: string, title: string, passed: boolean, detail: string[]): void {
  results.push({ id, passed });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

interface DecisionRead extends StoredCycle {
  status: string;
  action_type: string | null;
  notification_summary: string | null;
}

interface GuardEventRead {
  decision_id: number;
  event_type: string;
  attempt: number;
  rules: CoherenceRule[];
  detail: string | null;
}

type Supabase = NonNullable<ReturnType<typeof getSupabaseClient>>;

async function loadDecisionsInRange(supabase: Supabase, fromId: number, toId: number): Promise<DecisionRead[]> {
  const { data, error } = await supabase
    .from('decisions')
    .select(
      'id, created_at, status, action_type, notification_summary, raw_response, market_context, ' +
        'target_allocation, intent_allocation, applied_allocation, applied_divergence_cause, ' +
        'exposure_band_corrections(asset, clamped_weight_percent)',
    )
    .gte('id', fromId)
    .lte('id', toId)
    .order('id', { ascending: true });
  if (error) throw new Error(`incident replay: could not read decisions (${error.message}).`);
  return (data ?? []) as unknown as DecisionRead[];
}

async function loadDecisionsById(supabase: Supabase, ids: number[]): Promise<DecisionRead[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('decisions')
    .select(
      'id, created_at, status, action_type, notification_summary, raw_response, market_context, ' +
        'target_allocation, intent_allocation, applied_allocation, applied_divergence_cause, ' +
        'exposure_band_corrections(asset, clamped_weight_percent)',
    )
    .in('id', ids)
    .order('id', { ascending: true });
  if (error) throw new Error(`incident replay: could not read decisions by id (${error.message}).`);
  return (data ?? []) as unknown as DecisionRead[];
}

async function loadStatuses(supabase: Supabase, fromId: number, toId: number): Promise<Array<{ id: number; status: string }>> {
  const PAGE = 1000;
  const rows: Array<{ id: number; status: string }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('decisions')
      .select('id, status')
      .gte('id', fromId)
      .lte('id', toId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`incident replay: could not read statuses (${error.message}).`);
    const page = (data ?? []) as Array<{ id: number; status: string }>;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function loadGuardEvents(supabase: Supabase, fromId: number, toId: number): Promise<GuardEventRead[]> {
  const { data, error } = await supabase
    .from('decision_guard_events')
    .select('decision_id, event_type, attempt, rules, detail')
    .gte('decision_id', fromId)
    .lte('decision_id', toId)
    .order('id', { ascending: true });
  if (error) throw new Error(`incident replay: could not read decision_guard_events (${error.message}).`);
  return (data ?? []) as unknown as GuardEventRead[];
}

async function loadPilotActivation(supabase: Supabase): Promise<number | null> {
  const { data, error } = await supabase.from('exposure_pilot').select('activated_decision_id').limit(1);
  if (error) throw new Error(`incident replay: could not read exposure_pilot (${error.message}).`);
  const row = ((data ?? []) as Array<{ activated_decision_id: number | null }>)[0];
  return row?.activated_decision_id ?? null;
}

/**
 * The references production read for a cycle: the intention and the applied allocation of
 * the last DECIDED row before it, and — the applied target the model was SHOWN — the
 * effective target of the last SIGNIFICANT row before it (one that booked an executed
 * intent, exactly `loadLastSignificantDecision`'s definition). Between 1925 and 1951 the
 * two applied targets differ, and the model copied the shown one.
 */
function referencesBefore(
  decisions: readonly DecisionRead[],
  significant: ReadonlySet<number>,
  id: number,
): { referenceId: number; shownId: number | null; references: ReplayReferences } | null {
  const decided = [...decisions].filter((d) => d.id < id && d.status === 'decided').sort((a, b) => b.id - a.id);
  const previous = decided[0];
  if (previous == null) return null;
  const shown = decided.find((d) => significant.has(d.id)) ?? null;
  const columnsOf = (row: DecisionRead) => ({
    target_allocation: row.target_allocation,
    applied_allocation: row.applied_allocation,
    intent_allocation: row.intent_allocation,
    applied_divergence_cause: row.applied_divergence_cause,
  });
  const reserve = previous.market_context.account.portfolio.reserveAsset;
  return {
    referenceId: previous.id,
    shownId: shown?.id ?? null,
    references: {
      intent: resolveIntentAllocation(columnsOf(previous), reserve).allocation,
      applied: resolveEffectiveTarget(columnsOf(previous)).allocation,
      shownApplied: shown == null ? null : resolveEffectiveTarget(columnsOf(shown)).allocation,
    },
  };
}

/** The decisions that booked an executed intent — production's definition of a significant decision. */
async function loadSignificantIds(supabase: Supabase, fromId: number, toId: number): Promise<Set<number>> {
  const { data, error } = await supabase
    .from('executions')
    .select('decision_id')
    .eq('event_type', 'intent')
    .eq('validation_status', 'executed')
    .gte('decision_id', fromId)
    .lte('decision_id', toId);
  if (error) throw new Error(`incident replay: could not read the ledger's decision ids (${error.message}).`);
  return new Set(((data ?? []) as Array<{ decision_id: number | null }>).map((r) => r.decision_id).filter((id): id is number => id != null));
}

/** The allocation a rule-1 rejection quoted as emitted — the guard's own `fmt()` output. */
function emittedAllocationOf(detail: string | null): Record<string, number> | null {
  const match = /emitted \[([^\]]*)\]/.exec(detail ?? '');
  if (match == null) return null;
  const allocation: Record<string, number> = {};
  for (const part of match[1]!.split(', ')) {
    const [asset, value] = part.trim().split(' ');
    if (asset == null || value == null) return null;
    const n = Number(value.replace('%', ''));
    if (!Number.isFinite(n)) return null;
    allocation[asset] = n;
  }
  return allocation;
}

/** A first attempt rebuilt from the journal, as the guard would have been handed it. */
function reconstructedDecision(target: Record<string, number>, actionType: ValidatedDecision['actionType'], notes: ValidatedDecision['positionNotes'] = []): ValidatedDecision {
  return {
    targetAllocation: target,
    actionType,
    whatChanged: '(reconstruit depuis le journal du garde)',
    confidence: 'medium',
    marketState: null,
    reasoning: '(reconstruit depuis le journal du garde)',
    positionNotes: notes,
    notificationSummary: '(reconstruit)',
    requestedDelayMinutes: 60,
    appliedDelayMinutes: 60,
  };
}

const fmt = (allocation: Record<string, number> | null): string =>
  allocation == null ? '—' : Object.entries(allocation).map(([a, v]) => `${a} ${Number(v.toFixed(4))}`).join(' ');
const rulesOf = (violations: CoherenceViolation[]): string => (violations.length === 0 ? 'ACCEPTÉ' : violations.map((v) => v.rule).join(', '));
const EPS = 0.01;
const differsOn = (target: Record<string, number>, reference: Record<string, number> | null): string[] =>
  reference == null
    ? []
    : Object.entries(target)
        .filter(([asset, value]) => reference[asset] != null && Math.abs(value - reference[asset]!) > EPS)
        .map(([asset]) => asset);

interface AttemptRow {
  attempt: 1 | 2;
  source: 'raw_response' | 'reconstruit_regle_1' | 'reconstruit_regle_4';
  actionType: string;
  target: Record<string, number>;
  notes: string[];
  keepsIntent: boolean;
  keepsApplied: boolean;
  guardMovements: string[];
  guardTargetSource: string;
  verdict: string;
  detail: string[];
}

interface CycleRow {
  id: number;
  status: string;
  referenceId: number | null;
  /** The last significant decision before the cycle — the memory row the model was shown. */
  shownId: number | null;
  intentReference: Record<string, number> | null;
  appliedReference: Record<string, number> | null;
  shownAppliedReference: Record<string, number> | null;
  journaled: { firstAttemptRules: string[] | null; outcome: string };
  attempts: AttemptRow[];
}

function judgeAttempt(
  cycle: DecisionRead,
  decision: ValidatedDecision,
  references: ReplayReferences,
  attempt: 1 | 2,
  source: AttemptRow['source'],
): AttemptRow {
  const verdict: JudgeResult = judge(
    decision,
    cycle.market_context,
    references,
    // The persisted applied allocation belongs to the RECORDED response only. A reconstructed
    // first attempt was never persisted; a failed cycle's row has none anyway.
    source === 'raw_response' && cycle.status === 'decided' ? cycle.applied_allocation : undefined,
    'split',
    // Same rule for the journaled clamp: it is the clamp of the recorded response.
    source === 'raw_response' ? journaledClampOf(cycle) : null,
  );
  return {
    attempt,
    source,
    actionType: decision.actionType,
    target: decision.targetAllocation,
    notes: decision.positionNotes.map((n) => n.asset),
    keepsIntent: references.intent != null && differsOn(decision.targetAllocation, references.intent).length === 0,
    keepsApplied:
      (references.applied != null && differsOn(decision.targetAllocation, references.applied).length === 0) ||
      (references.shownApplied != null && differsOn(decision.targetAllocation, references.shownApplied).length === 0),
    guardMovements: verdict.guardMovements.map((m) => `${m.asset} ${m.side}`),
    guardTargetSource: verdict.guardTargetSource,
    verdict: rulesOf(verdict.violations),
    detail: verdict.violations.map((v) => `[${v.rule}] ${v.detail}`),
  };
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('incident replay: Supabase is not configured.');

  // The incident, plus the decided cycle that is 2112's reference.
  const window = await loadDecisionsInRange(supabase, INCIDENT.firstId - 5, INCIDENT.lastId);
  const events = await loadGuardEvents(supabase, INCIDENT.firstId, INCIDENT.lastId);
  const significantInWindow = await loadSignificantIds(supabase, INCIDENT.firstId - 5, INCIDENT.lastId);
  const incident = window.filter((d) => d.id >= INCIDENT.firstId && d.id <= INCIDENT.lastId);

  console.log('='.repeat(96));
  console.log('L’INCIDENT GARDE/BANDE, REJOUÉ IN SITU — le nouveau garde sur les réponses réelles de 2112 à 2131');
  console.log(
    `${incident.length} cycles · ${incident.filter((d) => d.status === 'decided').length} décidés · ` +
      `${incident.filter((d) => d.status === 'guard_failed').length} guard_failed · ` +
      `${incident.filter((d) => d.status === 'error').length} error · chaque réponse jugée contre les références que ` +
      'production avait à cet instant (la dernière ligne décidée avant le cycle).',
  );
  console.log('='.repeat(96));

  const rows: CycleRow[] = [];
  for (const cycle of incident) {
    const ref = referencesBefore(window, significantInWindow, cycle.id);
    if (ref == null) throw new Error(`incident replay: no decided row before ${cycle.id}`);
    const own = events.filter((e) => e.decision_id === cycle.id);
    const first = own.find((e) => e.event_type === 'guard_rejected_first_attempt') ?? null;
    const outcome =
      own.find((e) => e.event_type.startsWith('guard_failed'))?.event_type ??
      own.find((e) => e.event_type === 'guard_recovered_on_retry')?.event_type ??
      (cycle.status === 'decided' ? 'accepté en première tentative' : cycle.status);
    const row: CycleRow = {
      id: cycle.id,
      status: cycle.status,
      referenceId: ref.referenceId,
      shownId: ref.shownId,
      intentReference: ref.references.intent,
      appliedReference: ref.references.applied,
      shownAppliedReference: ref.references.shownApplied ?? null,
      journaled: { firstAttemptRules: first?.rules ?? null, outcome },
      attempts: [],
    };
    const assets = universeOf(cycle.market_context);

    // THE FIRST ATTEMPT, when the guard refused one — reconstructed from its journal.
    if (first != null) {
      const quoted = emittedAllocationOf(first.detail);
      if (quoted != null) {
        row.attempts.push(judgeAttempt(cycle, reconstructedDecision(quoted, 'hold'), ref.references, 1, 'reconstruit_regle_1'));
      } else if (first.rules.length === 1 && first.rules[0] === 'moved_line_without_note' && ref.references.intent != null) {
        // Rule 1 did not fire, so the target was the reference intention; rule 4 fired, so
        // the moving lines carried no note. Under the old guard that is a hold with no notes.
        row.attempts.push(judgeAttempt(cycle, reconstructedDecision({ ...ref.references.intent }, 'hold'), ref.references, 1, 'reconstruit_regle_4'));
      }
    }

    // THE RECORDED RESPONSE — the second attempt on a failed cycle, the only one otherwise.
    // An `error` row holds the serialized LLM failure in this column, not a response.
    if ((cycle.status === 'decided' || cycle.status === 'guard_failed') && cycle.raw_response != null && cycle.raw_response.trim() !== '') {
      const decoded = decodeResponse(cycle.raw_response, assets);
      if (!decoded.ok) throw new Error(`incident replay: #${cycle.id} raw_response does not decode — ${decoded.reason}`);
      row.attempts.push(judgeAttempt(cycle, decoded.decision, ref.references, first != null ? 2 : 1, 'raw_response'));
    }
    rows.push(row);
  }

  // ── The table, cycle by cycle ─────────────────────────────────────────────────────
  console.log('');
  for (const row of rows) {
    console.log(
      `#${row.id} ${row.status.padEnd(12)} référence #${row.referenceId} · intention [${fmt(row.intentReference)}] · appliquée [${fmt(row.appliedReference)}]` +
        (row.shownId != null && row.shownId !== row.referenceId ? ` · montrée (#${row.shownId}) [${fmt(row.shownAppliedReference)}]` : ''),
    );
    console.log(`      journalisé : ${row.journaled.outcome}${row.journaled.firstAttemptRules ? ` (1re tentative : ${row.journaled.firstAttemptRules.join(', ')})` : ''}`);
    if (row.attempts.length === 0) console.log('      aucune réponse à juger (appel au modèle en échec)');
    for (const a of row.attempts) {
      console.log(
        `      tentative ${a.attempt} (${a.source}) · ${a.actionType} [${fmt(a.target)}] · notes [${a.notes.join(', ') || '—'}] · ` +
          `garde intention ${a.keepsIntent ? 'oui' : 'non'} / appliquée ${a.keepsApplied ? 'oui' : 'non'} · ` +
          `mouvements de la chaîne [${a.guardMovements.join(', ') || '—'}] (${a.guardTargetSource})`,
      );
      console.log(`         → nouveau garde : ${a.verdict}`);
      for (const d of a.detail) console.log(`           ${d}`);
    }
  }

  // ── I1 — every failed cycle's recorded answer (path a) passes ─────────────────────
  {
    const failed = rows.filter((r) => r.status === 'guard_failed');
    const recorded = failed.map((r) => ({ id: r.id, attempt: r.attempts.find((a) => a.source === 'raw_response') ?? null }));
    const accepted = recorded.filter((r) => r.attempt?.verdict === 'ACCEPTÉ');
    const ok = recorded.length === 11 && accepted.length === recorded.length && recorded.every((r) => r.attempt != null && r.attempt.keepsIntent && r.attempt.actionType === 'hold');
    record('I1', 'les 11 cycles guard_failed : la réponse journalisée (chemin a) passe le nouveau garde', ok, [
      `${accepted.length}/${recorded.length} acceptées : ${accepted.map((r) => `#${r.id}`).join(', ')}`,
      'Chacune est un hold qui ré-émet l’intention de référence sans note. Sous l’ancien garde, les ventes de',
      'renversement des jambes de bande étaient lues comme des lignes bougées sans thèse (moved_line_without_note).',
      'Sous le nouveau, aucune ligne n’a été révisée par le modèle : ces mouvements sont ceux de la chaîne.',
      ...recorded.filter((r) => r.attempt?.verdict !== 'ACCEPTÉ').map((r) => `  REFUSÉ #${r.id} : ${r.attempt?.verdict ?? 'pas de réponse'}`),
    ]);
  }

  // ── I2 — the first attempts (path b, and the direct path a) ──────────────────────
  {
    const firsts = rows.flatMap((r) => r.attempts.filter((a) => a.attempt === 1 && a.source !== 'raw_response').map((a) => ({ id: r.id, a })));
    const exactCopies = firsts.filter((f) => f.a.keepsApplied || f.a.keepsIntent);
    const rounded = firsts.filter((f) => !f.a.keepsApplied && !f.a.keepsIntent);
    const okExact = exactCopies.every((f) => f.a.verdict === 'ACCEPTÉ');
    const okRounded = rounded.every((f) => f.a.verdict === 'hold_moved_target');
    const noRule4 = firsts.every((f) => !f.a.verdict.includes('moved_line_without_note'));
    record('I2', 'les premières tentatives : une copie exacte de l’allocation appliquée passe, une copie arrondie ne coûte que la règle 1', okExact && okRounded && noRule4 && firsts.length === 11, [
      `${firsts.length} premières tentatives reconstruites (${firsts.filter((f) => f.a.source === 'reconstruit_regle_1').length} citées par la règle 1, ` +
        `${firsts.filter((f) => f.a.source === 'reconstruit_regle_4').length} déduites d’un refus règle 4 seule).`,
      `copies exactes d’une référence (${exactCopies.length}) : ${exactCopies.map((f) => `#${f.id} ${f.a.verdict}`).join(' · ')}`,
      `copies arrondies (${rounded.length}) : ${rounded.map((f) => `#${f.id} ${f.a.verdict}`).join(' · ') || '—'}`,
      'Une copie arrondie à l’entier (« BTC 11 » pour 10,95) ne correspond à aucune référence à 0,01 près : la',
      'règle 1 tire, seule ; la relance cite les deux références et la seconde réponse (chemin a) passe (I1).',
      `règle 4 sur une première tentative : ${noRule4 ? 'jamais' : 'OUI — défaut'}`,
    ]);
  }

  // ── I3 — the decided cycles stay decided ──────────────────────────────────────────
  {
    const decided = rows.filter((r) => r.status === 'decided');
    const verdicts = decided.map((r) => ({ id: r.id, a: r.attempts.find((a) => a.source === 'raw_response')! }));
    const ok = decided.length === 5 && verdicts.every((v) => v.a.verdict === 'ACCEPTÉ');
    record('I3', 'les 5 cycles décidés de l’incident restent acceptés', ok, [
      ...verdicts.map((v) => `#${v.id} ${v.a.actionType} · notes [${v.a.notes.join(', ') || '—'}] · mouvements [${v.a.guardMovements.join(', ') || '—'}] → ${v.a.verdict}`),
      'Jugés sur la proposition BORNÉE journalisée (clamped_weight_percent), jamais sur applied_allocation, qui',
      'est depuis l’activation l’allocation déjà corrigée par la bande — voir storedCycle.ts.',
    ]);
  }

  // ── I4 — the negative controls: what the guard is still for ───────────────────────
  {
    const c2113 = window.find((d) => d.id === 2113)!;
    const ref2113 = referencesBefore(window, significantInWindow, 2113)!;
    const intent = ref2113.references.intent!;
    const reserve = c2113.market_context.account.portfolio.reserveAsset;
    // (a) a real revision disguised as a hold: BNB 10 → 5, the five points parked in cash.
    const disguised = judgeAttempt(c2113, reconstructedDecision({ ...intent, BNB: 5, [reserve]: intent[reserve]! + 5 }, 'hold'), ref2113.references, 1, 'reconstruit_regle_1');
    // (b) the same revision, honestly labelled, but with no thesis on the line it trades.
    const silent = judgeAttempt(c2113, reconstructedDecision({ ...intent, BNB: 5, [reserve]: intent[reserve]! + 5 }, 'de_risk'), ref2113.references, 1, 'reconstruit_regle_1');
    // (c) cycle 2124's real answer (ETH 14.5 → 12, which trades ETH) with its ETH note removed.
    const c2124 = window.find((d) => d.id === 2124)!;
    const ref2124 = referencesBefore(window, significantInWindow, 2124)!;
    const decoded2124 = decodeResponse(c2124.raw_response, universeOf(c2124.market_context));
    if (!decoded2124.ok) throw new Error('incident replay: #2124 does not decode');
    const hadEthNote = decoded2124.decision.positionNotes.some((n) => n.asset === 'ETH');
    const stripped = judgeAttempt(c2124, { ...decoded2124.decision, positionNotes: decoded2124.decision.positionNotes.filter((n) => n.asset !== 'ETH') }, ref2124.references, 2, 'raw_response');
    const ok =
      disguised.verdict.includes('hold_moved_target') &&
      silent.verdict === 'moved_line_without_note' &&
      hadEthNote &&
      stripped.verdict.includes('moved_line_without_note') &&
      stripped.detail.some((d) => /ETH 14\.5% → 12%/.test(d));
    record('I4', 'les contrôles négatifs : un vrai changement maquillé en hold, et une révision qui trade sans sa thèse, restent refusés', ok, [
      `(a) #2113, hold avec BNB ${intent.BNB} → 5 (ne correspond à aucune référence) → ${disguised.verdict}`,
      `(b) #2113, de_risk BNB ${intent.BNB} → 5 sans note, la ligne trade → ${silent.verdict} sur [${silent.detail.map((d) => d.slice(0, 60)).join(' | ')}…]`,
      `(c) #2124 réel (ETH 14,5 → 12, la ligne trade) avec sa note ETH retirée → ${stripped.verdict}`,
      `    la note ETH existait bien dans la réponse journalisée : ${hadEthNote ? 'oui' : 'NON'}`,
    ]);
  }

  // ── I5 — the relaunches the whole pilot paid for a hold that changed nothing ──────
  {
    const activation = await loadPilotActivation(supabase);
    const fromId = activation ?? INCIDENT.firstId;
    const allEvents = await loadGuardEvents(supabase, fromId, INCIDENT.lastId);
    const firstRejections = allEvents.filter((e) => e.event_type === 'guard_rejected_first_attempt' && e.decision_id < INCIDENT.firstId);
    const statuses = await loadStatuses(supabase, fromId - 50, INCIDENT.lastId);
    const significantAll = await loadSignificantIds(supabase, fromId - 50, INCIDENT.lastId);
    const decidedIds = statuses.filter((s) => s.status === 'decided').map((s) => s.id);
    const previousDecided = (id: number): number | null => decidedIds.filter((d) => d < id).sort((a, b) => b - a)[0] ?? null;
    const previousSignificant = (id: number): number | null => decidedIds.filter((d) => d < id && significantAll.has(d)).sort((a, b) => b - a)[0] ?? null;
    const needed = new Set<number>();
    for (const e of firstRejections) {
      needed.add(e.decision_id);
      const prev = previousDecided(e.decision_id);
      if (prev != null) needed.add(prev);
      const shown = previousSignificant(e.decision_id);
      if (shown != null) needed.add(shown);
    }
    const loaded = await loadDecisionsById(supabase, [...needed]);
    const outcomes: Array<{ id: number; rules: string[]; verdict: string; source: string }> = [];
    for (const e of firstRejections) {
      const cycle = loaded.find((d) => d.id === e.decision_id);
      const ref = cycle == null ? null : referencesBefore(loaded, significantAll, cycle.id);
      if (cycle == null || ref == null) continue;
      const quoted = emittedAllocationOf(e.detail);
      // A rule-1 rejection quotes the emitted target. A rejection on rule 4 ALONE did not —
      // but rule 1 not firing means the target was the reference intention, and rule 4
      // firing means the moving line carried no note: a hold with no notes, reconstructed
      // exactly as in the incident table above (2027 and 2028, the 14/09 drift deaths).
      const target =
        quoted ??
        (e.rules.length === 1 && e.rules[0] === 'moved_line_without_note' && ref.references.intent != null
          ? { ...ref.references.intent }
          : null);
      if (target == null) {
        outcomes.push({ id: e.decision_id, rules: e.rules, verdict: 'non reconstruit (la règle 1 n’a pas cité la cible)', source: '—' });
        continue;
      }
      const a = judgeAttempt(cycle, reconstructedDecision(target, 'hold'), ref.references, 1, quoted ? 'reconstruit_regle_1' : 'reconstruit_regle_4');
      const copiesShown = ref.references.shownApplied != null && differsOn(target, ref.references.shownApplied).length === 0;
      const copiesRetained = ref.references.applied != null && differsOn(target, ref.references.applied).length === 0;
      outcomes.push({
        id: e.decision_id,
        rules: e.rules,
        verdict: a.verdict,
        source: quoted == null
          ? `hold sur l’intention, sans note — la ligne bougeait par dérive du livre (${cycle.status})`
          : copiesShown && copiesRetained
            ? 'copie exacte de l’appliquée (retenue = montrée)'
            : copiesShown
              ? `copie exacte de l’appliquée MONTRÉE (#${ref.shownId})`
              : copiesRetained
                ? 'copie exacte de l’appliquée retenue'
                : a.keepsIntent
                  ? 'copie de l’intention'
                  : 'copie arrondie',
      });
    }
    const accepted = outcomes.filter((o) => o.verdict === 'ACCEPTÉ');
    // A rounded copy still costs its relaunch: rule 1 fires, and rule 2 with it when the
    // book sits on the applied target (nothing reachable) — as it did under the old guard.
    const rounded = outcomes.filter((o) => o.verdict.includes('hold_moved_target') && !o.verdict.includes('moved_line_without_note') && !o.verdict.includes('note_on_unmoved_line'));
    const other = outcomes.filter((o) => o.verdict !== 'ACCEPTÉ' && !rounded.includes(o));
    const ok = outcomes.length === firstRejections.length && other.length === 0 && accepted.length > 0;
    record('I5', 'depuis l’activation du pilote et avant l’incident, les relances payées pour un hold qui ne changeait rien', ok, [
      `${firstRejections.length} rejets en première tentative entre #${fromId} et #${INCIDENT.firstId - 1} (chacun suivi d’une relance).`,
      `sous le nouveau garde : ${accepted.length} acceptés en première tentative (relances évitées) · ${rounded.length} copies arrondies (règle 1, relance conservée) · ${other.length} autres`,
      ...outcomes.map((o) => `  #${o.id} [${o.rules.join(', ')}] → ${o.verdict} (${o.source})`),
    ]);
  }

  // ── The artefact ─────────────────────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const written = writeArtefact(OUT_DIR, 'incident.json', {
    window: INCIDENT,
    method: 'in situ — chaque réponse jugée contre la dernière ligne décidée avant elle ; première tentative reconstruite depuis decision_guard_events',
    cycles: rows,
    criteria: results,
  });
  console.log('');
  console.log(`Artefact : ${written.file}  ${written.sha256}  ${written.bytes} octets`);

  const failed = results.filter((r) => !r.passed);
  console.log('');
  console.log('='.repeat(96));
  console.log(failed.length === 0 ? 'ALL CRITERIA PASSED.' : `${failed.length} CRITERION/CRITERIA FAILED: ${failed.map((f) => f.id).join(', ')}`);
  console.log('='.repeat(96));
  if (failed.length > 0) process.exitCode = 1;
}

await main();
