import { buildBars, buildIntrabar, type BarSynthesis, type IntrabarBar } from './bars.js';
import { buildCycles, defaultBuildOptions, type CycleObservation } from './cycles.js';
import { buildStopFacts, type StopFacts } from './stops.js';
import type { RawWindow } from './read.js';
import type { ObservationWindow } from './window.js';

/**
 * THE SNAPSHOT — what was observed, what it may be used for, and the checks that say so.
 *
 * The artefact carries its own methodological contract. A file that travels between two
 * chantiers without its terms attached is a file whose terms get remembered wrong, and the
 * single most expensive mistake available here is reading these numbers as a performance.
 * They are not one: nothing in this brick maintains a portfolio, chains a decision, or
 * carries a price the cutoff had not already produced.
 */

export const SCHEMA_VERSION = 1;

/** The terms, embedded in the artefact rather than left in a README nobody opens with it. */
export const CONTRACT = Object.freeze({
  unit: 'one row per real cycle; every cycle keeps the 4h bar it consumed',
  one_step:
    'strictly one step, re-anchored on the REAL book at every cycle. No proxy portfolio is ' +
    'maintained, no request is chained, no trajectory is built.',
  bands:
    'none. No exposure band enters the extraction path: the observer imports the context ' +
    'controller and never the arms. Historical bands may only serve to prove that the offline ' +
    'computation reproduces the existing pure functions.',
  aggregation:
    'any statistic about the MARKET context aggregates by 4h bar first — three to seven ' +
    'wake-ups share one bar and must not weight it. Per-cycle rows are kept so the book and ' +
    'the model can be read at constant market information.',
  future_data:
    'none. No price, no outcome and no instant after the cutoff. Horizons and censoring rules ' +
    'belong to the separate offline chantier.',
  not_measured: ['P&L', 'drawdown', 'return', 'any exposure target', 'any deployable band'],
});

export interface SnapshotCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SnapshotSummary {
  schema_version: number;
  kind: 'exposure-observation';
  contract: typeof CONTRACT;
  window: { from: string; to_exclusive: string };
  universe: {
    /** The assets the controller reads — the caps table, cross-checked against the pairs. */
    controller: string[];
    /** The reserve stables. Their weight is the complement of the exposure, never part of it. */
    reserves: string[];
    /**
     * Assets the regime journal carries that the controller does not allocate to — production
     * computes its regime over tradable AND reference pairs. See `context.ts`.
     */
    journal_only: string[];
  };
  population: {
    cycles: number;
    by_status: Record<string, number>;
    cycles_with_target: number;
    cycles_without_target: number;
    cycles_without_context: number;
    bars: number;
    bars_with_multiple_cycles: number;
    cycles_per_bar: Record<string, number>;
    transition_verdicts: number;
    cycles_without_verdicts: number;
    movements_booked: number;
    movements_rejected_or_failed: number;
    /**
     * What the journal shows of the transition gate ACTING. The layer's mode is an environment
     * variable no column records, so these are evidence, never a verdict about the mode.
     */
    gate_evidence: {
      cycles_with_applied_divergence_cause: number;
      cycles_with_atomic_refusal: number;
      legs_forbidden: number;
      legs_cancelled_atomic: number;
      orders_superseded: number;
    };
  };
  checks: SnapshotCheck[];
  bars: BarSynthesis[];
  intrabar: IntrabarBar[];
  stops: StopFacts;
}

export interface Snapshot {
  cycles: {
    schema_version: number;
    kind: 'exposure-observation-cycles';
    window: { from: string; to_exclusive: string };
    cycles: CycleObservation[];
  };
  summary: SnapshotSummary;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * THE KEYS WHOSE VALUE IS THE CUTOFF ITSELF.
 *
 * Every artefact declares the window it covers, and `to_exclusive` IS the cutoff — so a scan
 * that did not skip the declaration would flag the snapshot for containing its own boundary.
 * Skipped by KEY rather than by value: the point of the scan is to catch a field nobody
 * thought about, and comparing against "the cutoff string" would also excuse a real instant
 * that happened to land on it.
 */
const DECLARATION_KEYS: ReadonlySet<string> = new Set(['window']);

/**
 * Walks the whole payload for ISO instants and returns the ones at or after the cutoff.
 *
 * A scan rather than a review of the fields we happen to remember. "No data after the cutoff"
 * is the load-bearing promise of a snapshot meant to be re-read later, and a promise kept by
 * inspection is a promise until someone adds a field.
 */
export function instantsAtOrAfter(value: unknown, cutoffMs: number, found: string[] = []): string[] {
  if (typeof value === 'string') {
    if (ISO_INSTANT.test(value) && Date.parse(value) >= cutoffMs) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) instantsAtOrAfter(entry, cutoffMs, found);
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (DECLARATION_KEYS.has(key)) continue;
      instantsAtOrAfter(entry, cutoffMs, found);
    }
  }
  return found;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Builds both artefacts from one window, plus the checks that make the population auditable.
 *
 * A check that fails does NOT silently downgrade the snapshot: the caller exits non-zero on
 * it. An audit tool that writes a file whose own integrity test failed is an audit tool that
 * has taught its reader to ignore the test.
 */
export function buildSnapshot(raw: RawWindow, window: ObservationWindow, universe: readonly string[]): Snapshot {
  const options = defaultBuildOptions(universe);
  const cycles = buildCycles(raw, options);
  const bars = buildBars(cycles);
  const intrabar = buildIntrabar(cycles);
  const stops = buildStopFacts(cycles);

  const withTarget = cycles.filter((c) => c.model_decision.raw_target != null);
  const verdictCount = cycles.reduce((sum, c) => sum + c.transition.verdicts.length, 0);
  const movements = cycles.flatMap((c) => c.movements);

  const journalOnly = new Set<string>();
  for (const cycle of cycles) for (const asset of cycle.context?.journal_only_assets ?? []) journalOnly.add(asset);

  const legs = cycles.flatMap((c) => c.transition.verdicts.map((v) => v.leg));
  const orders = cycles.flatMap((c) => c.transition.verdicts.map((v) => v.order));

  const summaryBase: Omit<SnapshotSummary, 'checks'> = {
    schema_version: SCHEMA_VERSION,
    kind: 'exposure-observation',
    contract: CONTRACT,
    window: { from: window.from, to_exclusive: window.toExclusive },
    universe: {
      controller: [...universe],
      reserves: [...options.reserves],
      journal_only: [...journalOnly].sort(),
    },
    population: {
      cycles: cycles.length,
      by_status: countBy(cycles, (c) => c.status),
      cycles_with_target: withTarget.length,
      cycles_without_target: cycles.length - withTarget.length,
      cycles_without_context: cycles.filter((c) => c.context == null).length,
      bars: bars.filter((b) => b.bar_key != null).length,
      bars_with_multiple_cycles: bars.filter((b) => b.bar_key != null && b.cycles > 1).length,
      cycles_per_bar: countBy(bars.filter((b) => b.bar_key != null), (b) => String(b.cycles)),
      transition_verdicts: verdictCount,
      cycles_without_verdicts: cycles.filter((c) => c.transition.verdicts.length === 0).length,
      movements_booked: movements.filter((m) => m.booked).length,
      movements_rejected_or_failed: movements.filter((m) => !m.booked).length,
      gate_evidence: {
        cycles_with_applied_divergence_cause: cycles.filter(
          (c) => c.model_decision.applied_divergence_cause != null,
        ).length,
        cycles_with_atomic_refusal: cycles.filter((c) => c.transition.atomic_refusal === true).length,
        legs_forbidden: legs.filter((leg) => leg?.verdict === 'forbidden').length,
        legs_cancelled_atomic: legs.filter((leg) => leg?.verdict === 'cancelled_atomic').length,
        orders_superseded: orders.filter((order) => order?.verdict === 'superseded').length,
      },
    },
    bars,
    intrabar,
    stops,
  };

  const cyclesArtefact: Snapshot['cycles'] = {
    schema_version: SCHEMA_VERSION,
    kind: 'exposure-observation-cycles',
    window: { from: window.from, to_exclusive: window.toExclusive },
    cycles,
  };

  const checks = runChecks(raw, window, universe, cycles, bars, intrabar, stops, cyclesArtefact, summaryBase);

  return { cycles: cyclesArtefact, summary: { ...summaryBase, checks } };
}

function check(name: string, ok: boolean, detail: string): SnapshotCheck {
  return { name, ok, detail };
}

function ids(list: readonly { decision_id: number }[], limit = 10): string {
  const shown = list.slice(0, limit).map((c) => c.decision_id);
  return list.length > limit ? `${shown.join(', ')}, … (${list.length} total)` : shown.join(', ');
}

function runChecks(
  raw: RawWindow,
  window: ObservationWindow,
  universe: readonly string[],
  cycles: readonly CycleObservation[],
  bars: readonly BarSynthesis[],
  intrabar: readonly IntrabarBar[],
  stops: StopFacts,
  cyclesArtefact: unknown,
  summaryBase: unknown,
): SnapshotCheck[] {
  const checks: SnapshotCheck[] = [];

  const unique = new Set(cycles.map((c) => c.decision_id));
  checks.push(
    check(
      'every_cycle_exactly_once',
      cycles.length === raw.decisions.length && unique.size === cycles.length,
      `${cycles.length} cycles extracted from ${raw.decisions.length} decision rows, ${unique.size} distinct ids`,
    ),
  );

  const outside = cycles.filter((c) => {
    const ms = Date.parse(c.created_at);
    return !(ms >= window.fromMs && ms < window.toMs);
  });
  checks.push(
    check(
      'window_is_half_open',
      outside.length === 0,
      outside.length === 0
        ? `every cycle sits in [${window.from}, ${window.toExclusive})`
        : `${outside.length} cycle(s) outside the window: ${ids(outside)}`,
    ),
  );

  const noBar = cycles.filter((c) => c.bar.key == null);
  checks.push(
    check(
      'every_cycle_keeps_its_bar',
      noBar.length === 0,
      noBar.length === 0 ? 'every cycle carries its 4h bar key' : `${noBar.length} cycle(s) with no bar: ${ids(noBar)}`,
    ),
  );

  const barDisagrees = cycles.filter((c) => c.bar.agrees_with_transition === false);
  checks.push(
    check(
      'bar_key_agrees_across_writers',
      barDisagrees.length === 0,
      barDisagrees.length === 0
        ? 'the regime journal and the transition verdicts name the same bar on every cycle that has both'
        : `${barDisagrees.length} cycle(s) where the two writers disagree: ${ids(barDisagrees)}`,
    ),
  );

  const decided = cycles.filter((c) => c.status === 'decided');
  const incomplete = decided.filter(
    (c) => c.model_decision.raw_target == null || c.model_decision.applied_target == null,
  );
  checks.push(
    check(
      'decided_cycles_carry_both_exposures',
      incomplete.length === 0,
      incomplete.length === 0
        ? `${decided.length} decided cycle(s), each with a raw and an applied target`
        : `${incomplete.length} decided cycle(s) missing one of the two: ${ids(incomplete)}`,
    ),
  );

  const failed = cycles.filter((c) => c.status !== 'decided');
  checks.push(
    check(
      'failed_cycles_are_preserved',
      failed.length === raw.decisions.filter((d) => d.status !== 'decided').length,
      `${failed.length} cycle(s) without a valid model response kept in the population ` +
        `(statuses: ${[...new Set(failed.map((c) => c.status))].sort().join(', ') || 'none'})`,
    ),
  );

  const malformed = cycles.filter((c) => c.context_unavailable?.reason === 'malformed_regime_journal');
  checks.push(
    check(
      'no_malformed_regime_journal',
      malformed.length === 0,
      malformed.length === 0
        ? 'every journaled regime rehydrated into the shape the controller reads'
        : `${malformed.length} cycle(s) with an unreadable regime: ${ids(malformed)}`,
    ),
  );

  const badVerdictCount = cycles.filter(
    (c) => c.transition.verdicts.length !== 0 && c.transition.verdicts.length !== universe.length,
  );
  checks.push(
    check(
      'transition_verdicts_are_complete_or_absent',
      badVerdictCount.length === 0,
      badVerdictCount.length === 0
        ? `every cycle carries 0 or ${universe.length} verdicts`
        : `${badVerdictCount.length} cycle(s) with a partial verdict set: ${ids(badVerdictCount)}`,
    ),
  );

  const inBars = bars.reduce((sum, bar) => sum + bar.cycles, 0);
  checks.push(
    check(
      'bars_partition_the_cycles',
      inBars === cycles.length,
      `${inBars} cycle(s) across ${bars.length} bar bucket(s) for ${cycles.length} cycle(s)`,
    ),
  );

  const barIds = new Map(bars.map((bar) => [bar.bar_key, new Set(bar.decision_ids)]));
  const intrabarBroken = intrabar.filter((entry) => {
    const set = barIds.get(entry.bar_key);
    return set == null || entry.cycles < 2 || entry.decision_ids.some((id) => !set.has(id));
  });
  checks.push(
    check(
      'intrabar_is_a_view_of_the_bars',
      intrabarBroken.length === 0,
      intrabarBroken.length === 0
        ? `${intrabar.length} bar(s) with more than one wake-up, each a strict subset of its bar`
        : `${intrabarBroken.length} intrabar entr(y/ies) do not match their bar`,
    ),
  );

  const episodeCycles = stops.episodes.reduce((sum, episode) => sum + episode.cycles, 0);
  checks.push(
    check(
      'stop_episodes_cover_every_fired_verdict',
      episodeCycles === stops.would_fire_verdicts,
      `${stops.episodes.length} episode(s) covering ${episodeCycles} fired verdict(s) of ` +
        `${stops.would_fire_verdicts} — counted as episodes, never as rows`,
    ),
  );

  const late = [
    ...instantsAtOrAfter(cyclesArtefact, window.toMs),
    ...instantsAtOrAfter(summaryBase, window.toMs),
  ];
  checks.push(
    check(
      'no_instant_at_or_after_the_cutoff',
      late.length === 0,
      late.length === 0
        ? 'the whole payload was scanned; nothing reaches past the cutoff'
        : `${late.length} instant(s) at or after the cutoff: ${[...new Set(late)].slice(0, 5).join(', ')}`,
    ),
  );

  return checks;
}
