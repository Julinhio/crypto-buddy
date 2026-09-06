import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, tradableBaseAssets } from '../config/index.js';
import { dec } from '../money.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { parseRegimeJournal, regimePointFromJournal } from '../market/regimeJournal.js';
import { readContext, type ControllerReading } from '../calibration/exposure/controller.js';
import type { TransitionGate } from '../transition/gate.js';
import { assessBand, bandOf } from '../exposure/band.js';
import { correctToBand } from '../exposure/correct.js';
import { resolvePilotWindow, type PilotWindowResolution } from '../exposure/pilot.js';
import {
  cutIntoSegments,
  equalWeightUnderCaps,
  expectedComparisons,
  isRepresentableAtJournalPrecision,
  JOURNAL_QTY_DECIMALS,
  openBook,
  settledCutoff,
  valueBook,
  stepWitness,
  witnessRow,
  type ChainEntry,
  type GapPlacement,
  type PlacedGap,
  type WitnessBook,
  type WitnessRow,
} from '../exposure/witness.js';
import { canonicalJson, sha256Of, writeArtefact } from '../provenance/artefacts.js';
import { bookOf as portfolioOf, pricesOf, type StoredContext } from './storedCycle.js';

/**
 * THE WITNESSES, REPLAYED — brick 3 of the constrained-exposure pilot.
 *
 * Offline and read-only. It reads `decisions`, `transition_observations` and the sovereign
 * ledger in `executions`, writes nothing to the database, and places nothing anywhere. The choice
 * of an offline reconstruction over an online one was the second framing answer of this
 * chantier: the data needed to rebuild both witnesses is already journaled, and an online
 * writer would add a failure mode inside the trading cycle for something that is not a
 * decision. What this run must therefore prove, per §6, is exactly that — that every input is
 * durably there, and that the reconstruction is reproducible.
 *
 * ── THREE CHAINED BOOKS, AND ONLY TWO OF THEM ARE WITNESSES ────────────────────────────
 *
 *   E   reproduces the bot's REAL total exposure, equally weighted under the per-asset caps
 *       with the excess redistributed (arbitrated: the exposure is the priority, equal
 *       weighting comes second).
 *   P   stays at the CURRENT BAND'S FLOOR, same weighting rule. It publishes its theoretical
 *       target, its attainable exposure and its gap to the floor, so nobody compares a
 *       constrained bot to a witness assumed perfect.
 *   B̂   the CORRECTED BOT. Not a witness: it is the bot itself under the band correction, and
 *       it exists to answer C7 — what the redistribution would really send, cycle after cycle,
 *       instead of one step at a time from a book that had never been corrected.
 *
 * E and P bear their own execution plumbing and NOT the bot's freezes; B̂ bears both, because
 * the corrector's rule is that the code never creates an order on a frozen line.
 *
 * ── WHAT B̂ ASSUMES, SAID OUT LOUD ──────────────────────────────────────────────────────
 *
 * B̂ replays the model's HISTORICAL answers against a book the model never saw. It therefore
 * measures the MECHANICAL CONSEQUENCE OF THE CORRECTION UNDER FROZEN HISTORICAL DECISIONS.
 *
 * It is NOT a simulation of how the model would have reacted, and it is NOT a bound of any
 * kind on performance — neither high nor low. Anyone reading B̂ as "what the pilot will do" is
 * reading it wrong, and the artefact says so in its own contract block.
 *
 * ── AND WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────
 *
 * No return, no drawdown, no bot-versus-witness delta. §7 keeps intermediate readings
 * descriptive, and the pilot's clock starts when `application` is armed — not now. C8, "does
 * the model use or fight the imposed exposure", gets its reader built and its data kept, and
 * NO figure: the question asks what the model does when it sees a corrected position, and in
 * observation mode it never saw one.
 *
 * Run with `npm run replay:band-witnesses`. Exits non-zero if any criterion fails.
 */

const OUT_DIR = path.join(process.cwd(), 'out', 'exposure-band-witnesses');

interface DecisionRead {
  id: number;
  created_at: string;
  status: string;
  regime: unknown;
  market_context: unknown;
  target_allocation: unknown;
  applied_allocation: unknown;
  applied_divergence_cause: unknown;
}

interface GateRead {
  decision_id: number;
  asset: string;
  gate: string;
}

interface LedgerRead {
  decision_id: number;
  symbol: string;
  ledger_base_delta: string | number;
  ledger_quote_delta: string | number;
}

const KNOWN_GATES: ReadonlySet<string> = new Set<TransitionGate>([
  'stop_exit',
  'risk_off_reduction',
  'frozen',
  'actionable',
  'no_regime',
]);

const results: Array<{ id: string; passed: boolean }> = [];

function record(id: string, title: string, passed: boolean, detail: string[]): void {
  results.push({ id, passed });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function allocationOf(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const [asset, weight] of Object.entries(raw)) {
    if (typeof weight === 'number' && Number.isFinite(weight)) out[asset] = weight;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * THE BOT'S REAL EXPOSURE AFTER THE CYCLE — E's target, and the one number E may not guess.
 *
 * REBUILT, not read. `equity_snapshots` looked like the answer and is not: the scheduler
 * builds it from `DecideResult.portfolio`, documented as "the virtual book the AI saw" — the
 * book BEFORE the cycle's orders. Proven on the corpus: cycle 1807 sold its entire ETH line
 * and the snapshot still carries that line at its pre-trade quantity. Targeting E on it made
 * E follow the book the bot was SHOWN while every comment and every criterion said post-cycle.
 *
 * So the post-trade book is derived the way production derives it: the pre-trade book plus
 * that cycle's SOVEREIGN ledger entries — `event_type='intent'` and
 * `validation_status='executed'`, exactly `loadLedger`'s filter. Quantities move by
 * `ledger_base_delta`, cash by the fee-inclusive `ledger_quote_delta`, and the whole thing is
 * valued at the SAME prices the cycle carried.
 *
 * Both inputs are known AT instant N. Nothing from a later cycle enters E's target.
 */
function postTradeBookOf(
  context: StoredContext,
  entries: readonly LedgerRead[],
): { exposurePercent: number; equity: number; qty: Map<string, number> } | null {
  const portfolio = context.account?.portfolio;
  if (portfolio == null || !Number.isFinite(portfolio.equity)) return null;
  const reserve = portfolio.reserveAsset;
  const priceOf = pricesOf(context);

  const qty = new Map<string, number>();
  for (const position of portfolio.positions ?? []) {
    if (!Number.isFinite(position.qty)) return null;
    // THE INVARIANT, CHECKED. Seeding from a rounded book and moving it by exact deltas is
    // only equivalent to production's derivation while both sit on the journal's precision
    // grid. They do today; the day they stop, this run must fail loudly rather than publish a
    // silent approximation.
    if (!isRepresentableAtJournalPrecision(position.qty)) {
      throw new Error(
        `band witnesses: the pre-cycle book carries ${position.asset} at ${position.qty}, which does ` +
          `not fit the journal's ${JOURNAL_QTY_DECIMALS} decimals. The reconstruction "rounded book ` +
          '+ exact ledger" is no longer exact, and continuing would bias every exposure it feeds.',
      );
    }
    qty.set(position.asset, (qty.get(position.asset) ?? 0) + position.qty);
  }
  let cash = portfolio.cash;
  if (!Number.isFinite(cash)) return null;

  for (const entry of entries) {
    const asset = entry.symbol.split('/')[0];
    if (asset == null || asset === '') return null;
    const base = Number(entry.ledger_base_delta);
    const quote = Number(entry.ledger_quote_delta);
    if (!Number.isFinite(base) || !Number.isFinite(quote)) return null;
    if (!isRepresentableAtJournalPrecision(base)) {
      throw new Error(
        `band witnesses: the sovereign ledger books ${asset} by ${base}, which does not fit the ` +
          `journal's ${JOURNAL_QTY_DECIMALS} decimals. See the invariant above.`,
      );
    }
    qty.set(asset, (qty.get(asset) ?? 0) + base);
    cash += quote;
  }

  let deployed = 0;
  for (const [asset, held] of qty) {
    if (asset === reserve || held === 0) continue;
    const price = priceOf(asset);
    if (price == null) return null;
    deployed += held * price.toNumber();
  }
  const equity = cash + deployed;
  if (!(equity > 0)) return null;
  return {
    exposurePercent: Math.round((deployed / equity) * 100 * 1e6) / 1e6,
    equity,
    qty,
  };
}

async function loadDecisions(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  cutoffId: number,
): Promise<DecisionRead[]> {
  const PAGE = 500;
  const rows: DecisionRead[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('decisions')
      .select(
        'id, created_at, status, regime, market_context, target_allocation, applied_allocation, ' +
          'applied_divergence_cause',
      )
      .eq('prompt_version', 'v5')
      .eq('status', 'decided')
      // THE SETTLED BOUND, on every query without exception. A row above it may belong to a
      // cycle still being written, and one query seeing it while another does not is exactly
      // how a torn read gets in.
      .lte('id', cutoffId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`band witnesses: could not read decisions (${error.message}).`);
    const page = (data ?? []) as unknown as DecisionRead[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function loadGates(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
): Promise<Map<number, Map<string, TransitionGate>>> {
  const PAGE = 1000;
  const byDecision = new Map<number, Map<string, TransitionGate>>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('transition_observations')
      .select('decision_id, asset, gate')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`band witnesses: could not read transition_observations (${error.message}).`);
    const page = (data ?? []) as unknown as GateRead[];
    for (const row of page) {
      if (!KNOWN_GATES.has(row.gate)) {
        throw new Error(
          `band witnesses: transition_observations carries gate "${row.gate}" on decision ` +
            `${row.decision_id} (${row.asset}) — not one of the ladder's five labels.`,
        );
      }
      const bucket = byDecision.get(row.decision_id) ?? new Map<string, TransitionGate>();
      bucket.set(row.asset, row.gate as TransitionGate);
      byDecision.set(row.decision_id, bucket);
    }
    if (page.length < PAGE) break;
  }
  return byDecision;
}

/**
 * The sovereign ledger, per cycle. The filter is `loadLedger`'s, verbatim: only booked
 * intents move the book — a testnet trace row carries a zero delta and a refused intent books
 * nothing, and counting either would move a book the bot never moved.
 */
async function loadLedgerByDecision(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  cutoffId: number,
): Promise<Map<number, LedgerRead[]>> {
  const PAGE = 1000;
  const byDecision = new Map<number, LedgerRead[]>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('executions')
      .select('decision_id, symbol, ledger_base_delta, ledger_quote_delta')
      .eq('event_type', 'intent')
      .eq('validation_status', 'executed')
      .lte('decision_id', cutoffId)
      // Insertion order via the monotonic id, exactly as production replays it.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`band witnesses: could not read executions (${error.message}).`);
    const page = (data ?? []) as unknown as LedgerRead[];
    for (const row of page) {
      if (row.decision_id == null) continue;
      const bucket = byDecision.get(row.decision_id) ?? [];
      bucket.push(row);
      byDecision.set(row.decision_id, bucket);
    }
    if (page.length < PAGE) break;
  }
  return byDecision;
}

/**
 * THE OFFICIAL WINDOW — the pilot's, when there is a pilot AND the pilot can be trusted.
 *
 * §3.8 and §3.9 make three instants official — the activation, the 40% photograph, the 50%
 * stop — and §7 adds the closure of the measurement window. A witness result is a PILOT result
 * only when it is bounded by those and opened on the equity really recorded at the activation.
 *
 * The RULE lives in `resolvePilotWindow`, pure and shared, because it is a contract and not a
 * query: an identity whose activation cycle was never resolved, or whose opening equity cannot
 * be read, REFUSES to be official rather than quietly replaying the whole history under the
 * pilot's name. This function only fetches the row.
 */
interface PilotRow {
  status: string;
  activated_at: string | null;
  activated_decision_id: number | null;
  opening_equity_usd: string | number | null;
  alert_drawdown_at: string | null;
  stopped_at: string | null;
  window_closed_at: string | null;
  alert_drawdown_decision_id: number | null;
  stopped_decision_id: number | null;
  window_closed_decision_id: number | null;
}

async function loadPilotWindow(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  requested: string | null,
): Promise<PilotWindowResolution> {
  const { data, error } = await supabase
    .from('exposure_pilot')
    .select(
      'status, activated_at, activated_decision_id, opening_equity_usd, ' +
        'alert_drawdown_at, stopped_at, window_closed_at, ' +
        'alert_drawdown_decision_id, stopped_decision_id, window_closed_decision_id',
    )
    .limit(1);
  if (error) throw new Error(`band witnesses: could not read exposure_pilot (${error.message}).`);
  const row = ((data ?? []) as unknown as PilotRow[])[0];
  if (row == null) return resolvePilotWindow(null, requested);
  const opening = row.opening_equity_usd == null ? null : Number(row.opening_equity_usd);
  return resolvePilotWindow(
    {
      status: row.status,
      activatedAt: row.activated_at,
      activatedDecisionId: row.activated_decision_id,
      openingEquityQuote: opening,
      alertAt: row.alert_drawdown_at,
      stoppedAt: row.stopped_at,
      closedAt: row.window_closed_at,
      alertDecisionId: row.alert_drawdown_decision_id,
      stoppedDecisionId: row.stopped_decision_id,
      closedDecisionId: row.window_closed_decision_id,
    },
    requested,
  );
}

// ── The chain ─// ── The chain ─────────────────────────────────────────────────────────────────────────

/** Why a cycle could not be reconstructed. Every skipped cycle carries one — none is silent. */
type CycleGap = 'no_context' | 'no_gates' | 'no_book' | 'no_target' | 'no_prices' | 'post_gate_only';

/**
 * One uninterrupted stretch of reconstructible cycles, with its own freshly opened books.
 * The cutting rule itself lives in `witness.ts` — pure, shared, and proven on fixtures that
 * have holes, because this corpus happens not to.
 */
type Segment = {
  id: number;
  cycles: Cycle[];
  opening: 'debut_reconstructible' | 'reancrage_apres_trou';
  brokenBy: { id: number; cause: string } | null;
};

interface ChainRow {
  /** Which chain this row belongs to. No figure is ever computed across two of them. */
  segment_id: number;
  decision_id: number;
  created_at: string;
  state: string;
  band_low_percent: number;
  band_high_percent: number;
  bot_exposure_percent: number;
  E: WitnessRow & { equity: number; fees: number; sent: number; suppressed: number };
  P: WitnessRow & { equity: number; fees: number; sent: number; suppressed: number };
  /** B̂ — the corrected bot. Not a witness; see the header. */
  B: {
    equity: number;
    fees: number;
    target_exposure_percent: number;
    corrected_exposure_percent: number;
    realised_exposure_percent: number;
    unrealisable_points: number;
    label: string;
    sent: number;
    suppressed: number;
    /** What the redistribution actually sends, by provenance — this is C7. */
    sent_by_origin: Record<string, number>;
    suppressed_by_reason: Record<string, number>;
    frozen_lines: number;
    /**
     * Legs on a frozen line that the CORRECTION created or resized. Must be zero: the code
     * never creates an order on a line the transition layer froze, whatever `TRANSITION_MODE`
     * says. W4 fails on a single one.
     */
    correction_legs_on_frozen: number;
    /**
     * Legs on a frozen line the MODEL itself asked for, which the correction left untouched.
     * Not a violation and not zero: arbitrated in brick 2, the freeze binds the movements the
     * band creates and only those — it does not arm the gate and does not touch the model's
     * raw vector. With the gate in `observe` the model may trade a frozen line, and the bot
     * really does send these.
     */
    model_legs_on_frozen: number;
    /** Points by which the BOOK sits outside the band after the cycle. Zero when inside. */
    band_gap_points: number;
  };
}

interface ChainResult {
  rows: ChainRow[];
  gaps: Record<string, number[]>;
  window: { fromId: number | null; toId: number | null; cycles: number };
}

interface Cycle {
  decision: DecisionRead;
  reading: ControllerReading;
  gates: Map<string, TransitionGate>;
  /** The bot's exposure AFTER this cycle's bookings — E's target. */
  botExposurePercent: number;
  /** The bot's equity after those bookings, which is what a re-anchored book opens on. */
  botEquityAfter: number;
  /** The post-trade quantities, kept so W2 can check them against an independent source. */
  botQtyAfter: Map<string, number>;
  clamped: Record<string, number>;
  raw: Record<string, number> | null;
  context: StoredContext;
}

/**
 * Runs the three books through the window, IN ORDER.
 *
 * Deterministic by construction: no clock, no randomness, no I/O. Called twice by W1 and the
 * two results compared byte for byte — a chain that could not reproduce itself would make
 * every figure below unfalsifiable.
 */
function runChain(
  segment: Segment,
  universe: string[],
  reserveAsset: string,
  openingEquityOverride: number | null,
): ChainRow[] {
  const cycles = segment.cycles;
  // THE RE-ANCHOR. Each segment opens its own books, in cash, on the bot's equity at its first
  // cycle. Nothing is carried over a cut: a book that resumed with the quantities it held
  // before an unreconstructible interval would be asserting it had held them through an
  // interval nobody can reconstruct.
  // THE PILOT'S OWN OPENING when the window is official: the equity really recorded at the
  // activation instant, not the one this replay would recompute for that cycle. Only the first
  // segment takes it — a segment that re-anchors after a hole opens on what the bot held there,
  // and pretending otherwise would carry a number across a frontier nothing may cross.
  const openingEquity = segment.id === 1 && openingEquityOverride != null ? openingEquityOverride : cycles[0]!.botEquityAfter;
  const capOf = (asset: string): number =>
    config.execution.caps.perAsset[asset] ?? config.execution.caps.defaultPerAsset;
  const fee = config.execution.feePercent;
  const floorPercent = config.execution.minMovementPercent;

  let bookE: WitnessBook = openBook(reserveAsset, dec(openingEquity));
  let bookP: WitnessBook = openBook(reserveAsset, dec(openingEquity));
  let bookB: WitnessBook = openBook(reserveAsset, dec(openingEquity));
  const rows: ChainRow[] = [];

  for (const cycle of cycles) {
    const priceOf = pricesOf(cycle.context);
    const band = bandOf(config.exposureBand, cycle.reading.state);

    // ── E — the bot's own exposure, equally weighted under the caps ──────────────────
    const planE = equalWeightUnderCaps(cycle.botExposurePercent, universe, capOf, reserveAsset);
    const stepE = stepWitness({
      book: bookE,
      allocation: planE.allocation,
      priceOf,
      feePercent: fee,
      minMovementPercent: floorPercent,
      logTag: ':E',
    });

    // ── P — the floor of the band this cycle is actually in ──────────────────────────
    const planP = equalWeightUnderCaps(band.lowPercent, universe, capOf, reserveAsset);
    const stepP = stepWitness({
      book: bookP,
      allocation: planP.allocation,
      priceOf,
      feePercent: fee,
      minMovementPercent: floorPercent,
      logTag: ':P',
    });

    // ── B̂ — the corrected bot, judged against ITS OWN book ──────────────────────────
    //
    // The correction has to be sized on the book B̂ really holds, not on the bot's: that is the
    // whole difference between a chained counterfactual and the one-step re-anchoring brick 2
    // could only do. So the assessment's exposure, equity and movement floor all come from
    // here.
    const valuedB = valueBook(bookB, priceOf);
    // A held line with no price stops every book on this cycle; the caller has already
    // filtered those out, so these are narrowings rather than branches.
    if ('gap' in stepE || 'gap' in stepP || !valuedB.ok) continue;

    const equityB = valuedB.equity;
    const exposureB = valuedB.exposurePercent;
    const assessment = assessBand({
      policyVersion: config.exposureBand.version,
      policy: config.exposureBand,
      state: cycle.reading.state,
      targetAllocation: cycle.clamped,
      rawAllocation: cycle.raw,
      bookExposurePercent: exposureB,
      reserveAsset,
      gateByAsset: cycle.gates,
      capOf,
      maxDeployablePercent: 100 - config.execution.caps.minCashPercent,
      equityQuote: equityB,
      movementFloorQuote: (equityB * floorPercent) / 100,
      stoppedWeightSurvives: true,
    });
    const correction = correctToBand({
      assessment,
      clampedAllocation: cycle.clamped,
      rawAllocation: cycle.raw,
      reserveAsset,
      portfolio: valuedB.portfolio,
      priceOf,
      feePercent: fee,
      minMovementPercent: floorPercent,
    });
    const stepB = stepWitness({
      book: bookB,
      allocation: correction.correctedAllocation,
      priceOf,
      feePercent: fee,
      minMovementPercent: floorPercent,
      logTag: ':B',
    });
    if ('gap' in stepB) continue;

    // C7 — what the redistribution SENDS, by provenance. The origin is what makes the answer
    // readable later: a leg the model asked for and a leg the band invented are not the same
    // position, and only the journal can tell them apart.
    // THE FREEZE CONTRACT, checked rather than asserted. The corrector may never create an
    // order on a line the transition layer declared frozen — whatever `TRANSITION_MODE` says —
    // and a criterion that only claimed it in prose would prove nothing.
    const frozen = new Set(
      correction.lines.filter((line) => !line.mayIncrease && !line.mayDecrease).map((line) => line.asset),
    );
    const movedByBand = new Map(correction.lines.map((line) => [line.asset, line.correctionPoints !== 0]));
    const originOf = new Map(correction.lines.map((line) => [line.asset, line.origin]));
    const sentByOrigin: Record<string, number> = {};
    for (const movement of stepB.movements) {
      const origin = originOf.get(movement.asset) ?? 'modele';
      sentByOrigin[origin] = (sentByOrigin[origin] ?? 0) + 1;
    }
    const suppressedByReason: Record<string, number> = {};
    for (const leg of stepB.suppressed) {
      suppressedByReason[leg.reason] = (suppressedByReason[leg.reason] ?? 0) + 1;
    }

    rows.push({
      segment_id: segment.id,
      decision_id: cycle.decision.id,
      created_at: cycle.decision.created_at,
      state: cycle.reading.state,
      band_low_percent: band.lowPercent,
      band_high_percent: band.highPercent,
      bot_exposure_percent: cycle.botExposurePercent,
      E: {
        ...witnessRow(planE, stepE),
        equity: stepE.equityAfter,
        fees: stepE.feesQuote,
        sent: stepE.movements.length,
        suppressed: stepE.suppressed.length,
      },
      P: {
        ...witnessRow(planP, stepP),
        equity: stepP.equityAfter,
        fees: stepP.feesQuote,
        sent: stepP.movements.length,
        suppressed: stepP.suppressed.length,
      },
      B: {
        equity: stepB.equityAfter,
        fees: stepB.feesQuote,
        target_exposure_percent: assessment.targetExposurePercent,
        corrected_exposure_percent: correction.correctedExposurePercent,
        realised_exposure_percent: stepB.exposureAfterPercent,
        unrealisable_points: correction.unrealisablePoints,
        label: correction.label,
        sent: stepB.movements.length,
        suppressed: stepB.suppressed.length,
        sent_by_origin: sentByOrigin,
        suppressed_by_reason: suppressedByReason,
        frozen_lines: frozen.size,
      correction_legs_on_frozen: stepB.movements.filter(
        (m) => frozen.has(m.asset) && (movedByBand.get(m.asset) ?? false),
      ).length,
      model_legs_on_frozen: stepB.movements.filter(
        (m) => frozen.has(m.asset) && !(movedByBand.get(m.asset) ?? false),
      ).length,
      band_gap_points: outsideBandPoints(stepB.exposureAfterPercent, band),
      },
    });

    bookE = stepE.book;
    bookP = stepP.book;
    bookB = stepB.book;
  }

  return rows;
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('band witnesses: Supabase is not configured.');

  const universe = tradableBaseAssets(config);
  // ── THE SETTLED POINT, TAKEN FIRST AND IMPOSED ON EVERYTHING ELSE ────────────────
  //
  // The three reads used to fire together, and a cycle finishing mid-run could be seen by one
  // and missed by another: production writes the decision row, THEN places the orders, THEN
  // books the ledger, THEN journals the transition verdicts. A decisions query that caught the
  // row while the ledger query ran a moment too early would hand this replay a cycle that
  // "booked nothing" — reviving, silently and for one cycle, the exact defect the previous
  // revision fixed.
  //
  // So the gates are read FIRST, the cutoff is the last cycle they cover COMPLETELY, and every
  // other query is bounded by that same number. The gate layer is the one written last, so its
  // full coverage proves the decision, the orders and the ledger of that cycle are already
  // there. Measured on the corpus: gates land 0.33 s after the decision row on average (2.96 s
  // at worst) and never before the ledger.
  const gatesByDecision = await loadGates(supabase);
  const cutoffId = settledCutoff(gatesByDecision, universe);
  if (cutoffId == null) {
    throw new Error(
      'band witnesses: no cycle carries a complete set of transition verdicts, so no point in ' +
        'the journal is provably settled. Refusing to replay rather than reading a torn journal.',
    );
  }
  // THE PILOT'S OWN WINDOW, when a pilot exists. `--at=alerte_40|arret_50|cloture` picks which
  // persisted instant closes it; without the flag it takes the closure, then the stop, then the
  // settled point.
  // ABSENT AND EMPTY ARE DIFFERENT. No flag means "choose the instant that exists"; `--at=`
  // means someone asked for one and named nothing, which is a refusal like any other bad value.
  const instantFlag = process.argv.find((arg) => arg.startsWith('--at='));
  const requestedInstant = instantFlag == null ? null : instantFlag.slice('--at='.length);
  const resolved = await loadPilotWindow(supabase, requestedInstant);
  // AN OFFICIAL BOUND BEYOND THE SETTLED POINT IS A REFUSAL, not a truncation.
  //
  // `Math.min` used to clip the window to the settled cutoff while the banner went on printing
  // the requested pointer as the closing cycle — publishing a PARTIAL replay as though it had
  // been valued at the alert, the stop or the closure. The honest answer is to wait until that
  // exact cycle is provably complete.
  const pilotWindow: PilotWindowResolution =
    resolved.official && resolved.toDecisionId != null && resolved.toDecisionId > cutoffId
      ? {
          official: false,
          reason:
            `l'instant "${resolved.instant}" tombe au cycle ${resolved.toDecisionId}, au-dela du point ` +
            `d'arret prouve complet (${cutoffId}) — le rejeu refuse plutot que de tronquer`,
        }
      : resolved;
  const upperBound =
    pilotWindow.official && pilotWindow.toDecisionId != null ? pilotWindow.toDecisionId : cutoffId;

  const [decisions, ledgerByDecision] = await Promise.all([
    loadDecisions(supabase, upperBound),
    loadLedgerByDecision(supabase, upperBound),
  ]);

  console.log('='.repeat(96));
  console.log("LES DEUX TÉMOINS — rejeu hors ligne, lecture seule, aucun ordre produit");
  console.log(
    `Politique ${config.exposureBand.version} · frais ${config.execution.feePercent}% · ` +
      `seuil ${config.execution.minMovementPercent}% · plafonds ` +
      Object.entries(config.execution.caps.perAsset)
        .map(([a, c]) => `${a} ${c}`)
        .join(' / '),
  );
  console.log('='.repeat(96));
  if (pilotWindow.official) {
    console.log(
      `FENÊTRE OFFICIELLE DU PILOTE · activé le ${pilotWindow.activatedAt} · statut ${pilotWindow.status} · ` +
        `ouverture au cycle ${pilotWindow.fromDecisionId} sur ${pilotWindow.openingEquityQuote.toFixed(2)} $ · ` +
        `fermeture ${pilotWindow.toDecisionId == null ? 'au point d\'arrêt courant' : `au cycle ${pilotWindow.toDecisionId}`} ` +
        `(instant : ${pilotWindow.instant})`,
    );
    console.log('Rien d\'antérieur à l\'ouverture ni de postérieur à la fermeture n\'entre dans ce résultat.');
  } else {
    console.log(`PAS DE RÉSULTAT OFFICIEL — ${pilotWindow.reason}.`);
    console.log('Ce rejeu est un BANC D\'ESSAI de la machinerie.');
    console.log('Il ne produit AUCUN résultat officiel du pilote : sa fenêtre est celle de l\'historique');
    console.log('disponible, pas celle d\'une expérience, et son ouverture est un paramètre et non un');
    console.log('instant. Le pilote commence au passage en `application`, et pas avant.');
  }
  console.log('='.repeat(96));

  // ── Build the window, and CUT it wherever an input is missing ────────────────────
  //
  // Every decided cycle is classified: reconstructible, or a gap with a named cause AND a
  // named placement. A gap before the first reconstructible cycle costs nothing. A gap inside
  // the window cuts the chain — the segment closes there and a new one re-anchors at the next
  // complete cycle. Skipping over it and carrying on, which is what this replay did before,
  // COMPRESSES TIME: the books would jump an interval in which they might have rebalanced, and
  // every later row would carry quantities, cash and fees that never existed.
  const gaps: PlacedGap[] = [];
  const classified: Array<ChainEntry<Cycle>> = [];

  for (const decision of decisions) {
    // NOTHING BEFORE THE OPENING. A cycle older than the activation is not a gap in the pilot's
    // window — it is outside it, and counting it as either reconstructed or missing would be a
    // statement about an experiment that had not started.
    if (pilotWindow.official && decision.id < pilotWindow.fromDecisionId) {
      continue;
    }
    const fail = (cause: CycleGap): void => {
      classified.push({ ok: false, id: decision.id, cause });
    };
    if (decision.applied_divergence_cause != null) {
      fail('post_gate_only');
      continue;
    }
    let reading: ControllerReading | null = null;
    try {
      const journal = parseRegimeJournal(decision.regime);
      const point = journal == null ? null : regimePointFromJournal(journal);
      reading = point == null ? null : readContext(point, universe);
    } catch {
      reading = null;
    }
    if (reading == null) {
      fail('no_context');
      continue;
    }
    const gates = gatesByDecision.get(decision.id);
    if (gates == null || gates.size === 0) {
      fail('no_gates');
      continue;
    }
    const clamped = allocationOf(decision.applied_allocation);
    if (clamped == null) {
      fail('no_target');
      continue;
    }
    const context = decision.market_context as StoredContext;
    const priceOf = pricesOf(context);
    if (universe.some((asset) => priceOf(asset) == null)) {
      fail('no_prices');
      continue;
    }
    const after = postTradeBookOf(context, ledgerByDecision.get(decision.id) ?? []);
    if (after == null) {
      fail('no_book');
      continue;
    }
    classified.push({
      ok: true,
      id: decision.id,
      item: {
        decision,
        reading,
        gates,
        botExposurePercent: after.exposurePercent,
        botEquityAfter: after.equity,
        botQtyAfter: after.qty,
        clamped,
        raw: allocationOf(decision.target_allocation),
        context,
      },
    });
  }

  // THE CUT, delegated to the shared rule rather than restated here.
  const cut = cutIntoSegments<Cycle>(classified);
  const segments: Segment[] = cut.segments.map((segment) => ({
    id: segment.id,
    cycles: segment.items,
    opening: segment.opening,
    brokenBy: segment.brokenBy,
  }));
  gaps.push(...cut.gaps);

  if (segments.length === 0) throw new Error('band witnesses: no cycle carries every required input.');

  // The books open with the bot's own equity at the first cycle of EACH segment. The pilot's
  // real opening instant belongs to brick 4 — these are parameters of the dry run.
  const reserveAsset = portfolioOf(segments[0]!.cycles[0]!.context).reserveAsset;
  const runAll = (): ChainRow[] =>
    segments.flatMap((segment) => runChain(segment, universe, reserveAsset, pilotWindow.official ? pilotWindow.openingEquityQuote : null));
  const rows = runAll();

  console.log('');
  console.log(
    `Fenêtre : ${rows.length} cycles reconstruits en ${segments.length} segment(s), ids ` +
      `${rows[0]?.decision_id} → ${rows[rows.length - 1]?.decision_id} · point d’arrêt figé ${cutoffId}.`,
  );
  for (const segment of segments) {
    console.log(
      `  segment ${segment.id} · ${segment.cycles.length} cycle(s) · ids ${segment.cycles[0]!.decision.id} → ` +
        `${segment.cycles[segment.cycles.length - 1]!.decision.id} · ouverture ` +
        `${segment.cycles[0]!.botEquityAfter.toFixed(2)} · ${segment.opening}` +
        (segment.brokenBy == null
          ? ''
          : ` (rupture au cycle ${segment.brokenBy.id}, cause ${segment.brokenBy.cause})`),
    );
  }

  // ── W0 — every cycle is reconstructed, or named AND placed ───────────────────────────────
  {
    const byPlacement = (placement: GapPlacement): PlacedGap[] => gaps.filter((g) => g.placement === placement);
    const before = byPlacement('anterieur_au_debut');
    const internal = byPlacement('interne');
    const terminal = byPlacement('terminal');
    // OUTSIDE THE WINDOW IS NOT A GAP. When a pilot exists, cycles older than its activation
    // were never in scope, so they belong in neither the reconstructed count nor the missing one.
    const inScope = decisions.filter(
      (d) =>
        !pilotWindow.official || d.id >= pilotWindow.fromDecisionId,
    ).length;
    const accounted = rows.length + gaps.length;
    const causes = (list: PlacedGap[]): string =>
      Object.entries(
        list.reduce<Record<string, number>>((acc, g) => {
          acc[g.cause] = (acc[g.cause] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .map(([cause, n]) => `${cause}  ${n}`)
        .join(' · ') || 'aucun';
    record('W0', 'chaque cycle est reconstruit, ou nommé ET situé', accounted === inScope, [
      `${inScope} cycles v5 décidés dans la fenêtre · ${rows.length} reconstruits en ${segments.length} segment(s) · ` +
        `${gaps.length} écartés, chacun avec une cause ET une place.`,
      ' ',
      `  antérieurs au début reconstructible : ${before.length} — ${causes(before)}`,
      '    Ils ne coûtent rien : la chaîne n’a pas commencé, il n’y a pas de livre à porter.',
      `  trous INTERNES (rupture + réancrage) : ${internal.length} — ${causes(internal)}`,
      internal.length === 0
        ? '    Aucun sur cette fenêtre. Le mécanisme existe et est prouvé sur fixture.'
        : `    Cycles ${internal.map((g) => g.id).join(', ')} — chacun ferme un segment ;` +
          ' aucune equity, aucun mouvement, aucun écart ne traverse la frontière.',
      `  trous TERMINAUX : ${terminal.length} — ${causes(terminal)}`,
      '    Ils ne coupent rien : aucune chaîne ne reprend après eux.',
      ' ',
      'Les entrées lues : prix du cycle, livre pré-cycle, registre souverain du même cycle,',
      'journal de régime, verdicts de porte, cible bornée. Toutes déjà écrites par le cycle',
      'vivant — aucune écriture n’a été ajoutée au chemin de trading pour les témoins.',
    ]);
  }

  // ── W1 — the reconstruction reproduces itself, byte for byte ──────────────────────
  {
    const again = runAll();
    const first = sha256Of(canonicalJson(rows));
    const second = sha256Of(canonicalJson(again));
    record('W1', 'le rejeu est reproductible — même entrées, mêmes livres', first === second, [
      `empreinte du premier passage : ${first}`,
      `empreinte du second           : ${second}`,
      'La méthode hors ligne a été choisie parce qu’elle est reconstructible ; une chaîne qui',
      'ne se reproduit pas rendrait chacun de ses chiffres infalsifiable.',
    ]);
  }

  // ── W2 — the post-trade book, checked against an INDEPENDENT source, with coverage ─
  //
  // The first W2 was circular: it compared E's target to the value that target was built from,
  // so it would have passed just as happily on the pre-trade book it was in fact reading. The
  // independent term is the NEXT cycle's own `market_context`: a different row, written by a
  // different code path at a different moment, showing the quantities the bot actually held at
  // its next wake-up. Quantities, not values — a price moves between two wake-ups, a holding
  // does not. Used ONLY as a check; E's target still reads nothing but instant-N data.
  //
  // AND THE COVERAGE IS PART OF THE VERDICT. "No drift" is not a proof if nothing was compared:
  // a terminal cycle has no successor, a singleton segment has no pair at all, and a corpus of
  // singletons would have passed with zero comparisons and a 0% agreement rate on display. So
  // the expected count is computed from the SHAPE of the segments and the observed count must
  // equal it exactly — and a corpus expecting nothing cannot pass.
  {
    const expected = expectedComparisons(segments.map((segment) => segment.cycles.length), universe.length);
    const singletons = segments.filter((segment) => segment.cycles.length === 1);
    const terminals = segments.map((segment) => segment.cycles[segment.cycles.length - 1]!.decision.id);
    let compared = 0;
    let agreed = 0;
    const drifts: Array<{ id: number; asset: string; derived: number; shown: number }> = [];
    let worstRelative = 0;
    for (const segment of segments) {
      for (let i = 0; i + 1 < segment.cycles.length; i += 1) {
        const cycle = segment.cycles[i]!;
        const next = segment.cycles[i + 1]!;
        const shown = new Map<string, number>();
        for (const position of next.context.account.portfolio.positions ?? []) {
          shown.set(position.asset, (shown.get(position.asset) ?? 0) + position.qty);
        }
        for (const asset of universe) {
          const derived = cycle.botQtyAfter.get(asset) ?? 0;
          const seen = shown.get(asset) ?? 0;
          compared += 1;
          // Relative, because a quantity of BTC and a quantity of XRP are orders of magnitude
          // apart and one absolute tolerance cannot serve both.
          const scale = Math.max(Math.abs(derived), Math.abs(seen), 1e-12);
          const relative = Math.abs(derived - seen) / scale;
          if (relative > worstRelative) worstRelative = relative;
          if (relative <= 1e-6) agreed += 1;
          else drifts.push({ id: cycle.decision.id, asset, derived, shown: seen });
        }
      }
    }
    const covered = expected > 0 && compared === expected;
    const rate = compared === 0 ? 0 : (agreed / compared) * 100;

    // THE CASH BOUND, published rather than assumed. The seed book carries its cash rounded to
    // the cent, so each reconstruction can be off by at most half a cent — on the EQUITY, never
    // on the quantities, which W2 has just checked against an independent source.
    const smallestEquity = Math.min(...segments.flatMap((seg) => seg.cycles.map((c) => c.botEquityAfter)));
    const cashBoundPoints = (0.005 / smallestEquity) * 100;

    record('W2', 'le livre post-cycle reconstruit est celui que le bot a tenu, et la couverture est complète', covered && drifts.length === 0, [
      'Terme de comparaison INDÉPENDANT : le contexte du cycle SUIVANT — une autre ligne, écrite',
      'par un autre chemin, montrant ce que le bot tenait à son réveil suivant. Comparées sur les',
      'QUANTITÉS : un prix bouge entre deux réveils, une quantité détenue non.',
      `${compared} comparaison(s) attendues ${expected} — ${covered ? 'couverture exacte' : 'COUVERTURE INCOMPLÈTE'}`,
      `${agreed} d’accord (${rate.toFixed(3)} %) · écart relatif maximum ${worstRelative.toExponential(2)}`,
      drifts.length === 0
        ? 'Aucune divergence : « livre pré-cycle + registre du cycle » EST le livre post-cycle.'
        : `${drifts.length} divergence(s), dont : ` +
          drifts
            .slice(0, 5)
            .map((d) => `#${d.id} ${d.asset} reconstruit ${d.derived} vs montré ${d.shown}`)
            .join(' · '),
      ' ',
      'COUVERTURE. « Aucune dérive » ne prouve rien si rien n’a été comparé : le nombre attendu',
      'est calculé depuis la STRUCTURE des segments — quatre actifs par cycle ayant un successeur',
      'dans son segment — et l’observé doit lui être exactement égal.',
      `  cycles terminaux, non contrôlables par W2 : ${terminals.join(', ')} (un par segment)`,
      singletons.length === 0
        ? '  segments singletons : aucun'
        : `  segments singletons, marqués NON EXERCÉS : ${singletons.map((seg) => seg.id).join(', ')}`,
      'Un corpus n’attendant aucune comparaison ne peut pas faire passer ce critère.',
      ' ',
      `ARRONDI DU CASH, borné et publié à part : le livre de départ porte son cash au centime,`,
      `donc au plus 0,005 $ d’écart par reconstruction — sur l’ÉQUITÉ, jamais sur les quantités.`,
      `Effet maximal sur l’exposition, à la plus petite équité de la fenêtre (${smallestEquity.toFixed(2)} $) : ` +
        `${cashBoundPoints.toFixed(6)} point — quatre ordres de grandeur sous le seuil de mouvement de 2 %.`,
    ]);
  }

  // ── W2b — what E then realises, which is the plumbing and not the definition ─────
  {
    const targetErrors = rows.map((r) => Math.abs(r.E.targetExposurePercent - r.bot_exposure_percent));
    const realisedErrors = rows
      .map((r) => Math.abs(r.E.realisedExposurePercent - r.bot_exposure_percent))
      .sort((x, y) => x - y);
    const clippedCycles = rows.filter((r) => r.E.clipped.length > 0);
    record('W2b', 'E vise l’exposition post-cycle du bot, et la plomberie l’en écarte', Math.max(...targetErrors) <= 1e-6, [
      `E vise la valeur reconstruite au point près (écart maximal ${Math.max(...targetErrors).toFixed(9)}).`,
      `Ce qu’il RÉALISE en diffère : médiane ${median(realisedErrors)?.toFixed(2)} pt · ` +
        `p90 ${realisedErrors[Math.floor(realisedErrors.length * 0.9)]?.toFixed(2)} pt · ` +
        `maximum ${realisedErrors[realisedErrors.length - 1]?.toFixed(2)} pt.`,
      'STRUCTUREL, et à connaître avant de lire quoi que ce soit : une variation d’exposition de',
      'X points se répartit en quatre jambes de X/4, donc rien ne bouge tant que X n’atteint pas',
      '8 points. C’est le résidu accepté que le moteur de mouvements documente (actifs × seuil),',
      'et il est le même pour le bot. « Bot moins E à exposition identique » est donc vrai à',
      'quelques points près, pas exactement — E publie ses trois nombres pour que ce soit lisible.',
      `Plafonds atteints sur ${clippedCycles.length} cycle(s)` +
        (clippedCycles.length === 0
          ? ' — la redistribution n’a jamais eu à jouer sur cette fenêtre.'
          : ` · points redistribués en moyenne ${mean(clippedCycles.map((r) => r.E.redistributedPoints))?.toFixed(2)}` +
            ` · lignes écrêtées ${[...new Set(clippedCycles.flatMap((r) => r.E.clipped))].join(', ')}`),
      `Points implaçables sur toute la fenêtre : ${rows.reduce((sum, r) => sum + r.E.unplaceablePoints, 0).toFixed(2)}.`,
    ]);
  }

  // ── W3 — P publishes the three numbers §3.7 requires of it ────────────────────────
  {
    const complete = rows.every(
      (r) =>
        Number.isFinite(r.P.targetExposurePercent) &&
        Number.isFinite(r.P.attainableExposurePercent) &&
        Number.isFinite(r.P.gapPoints),
    );
    const byState = new Map<string, { cycles: number; gaps: number[] }>();
    for (const row of rows) {
      const bucket = byState.get(row.state) ?? { cycles: 0, gaps: [] };
      bucket.cycles += 1;
      bucket.gaps.push(row.P.gapPoints);
      byState.set(row.state, bucket);
    }
    record('W3', 'le témoin P publie sa cible, son atteignable et son écart au plancher', complete, [
      'Sans ces trois nombres nous comparerions un bot contraint à un témoin supposé parfait.',
      ...[...byState.entries()].map(
        ([state, b]) =>
          `  ${state.padEnd(13)} ${String(b.cycles).padStart(4)} cycle(s) · plancher visé ` +
          `${rows.find((r) => r.state === state)!.P.targetExposurePercent.toFixed(2)}` +
          ` · écart réalisé moyen ${mean(b.gaps)?.toFixed(2)} point`,
      ),
      `P n’atteint pas exactement son plancher sur ${rows.filter((r) => Math.abs(r.P.gapPoints) > 0.01).length} cycle(s)` +
        ' — le seuil de mouvement et les frais, les mêmes que ceux du bot.',
    ]);
  }

  // ── W4 — the witnesses bear the plumbing, never the bot's freezes ─────────────────
  {
    const frozenCycles = rows.filter((r) => r.B.frozen_lines > 0);
    const violations = rows.filter((r) => r.B.correction_legs_on_frozen > 0);
    const modelLegs = rows.reduce((sum, r) => sum + r.B.model_legs_on_frozen, 0);
    record('W4', 'les gels : portés par B̂ parce qu’il EST le bot, jamais par les témoins', violations.length === 0, [
      'Arbitré : un gel, un stop ou une transition décrit une position DU BOT. Un témoin ne l’a',
      'pas prise. Les lui appliquer rendrait le comparateur dépendant de la trajectoire qu’il',
      'existe pour évaluer — et, aujourd’hui, plus contraint que le bot lui-même, dont la porte',
      'est en `observe` et ne bloque aucun ordre réel.',
      `B̂, qui EST le bot corrigé, en hérite : ${frozenCycles.length} cycle(s) sur ${rows.length} portent au moins`,
      `une ligne gelée, et la CORRECTION y a créé ${rows.reduce((s2, r) => s2 + r.B.correction_legs_on_frozen, 0)} ordre(s).`,
      'Vérifié jambe par jambe, pas affirmé : chaque mouvement envoyé est confronté aux verdicts',
      'de porte du cycle ET à la correction de sa ligne, et ce critère échoue sur un seul.',
      '',
      `En revanche ${modelLegs} jambe(s) touchent une ligne gelée parce que LE MODÈLE les a demandées et`,
      'que la correction ne les a pas touchées. Ce n’est pas une violation : la contrainte de gel',
      'porte sur les mouvements que la bande crée, et sur eux seuls — elle n’arme pas la porte et',
      'ne touche pas au vecteur brut du modèle. Le bot réel envoie déjà ces jambes.',
      'La séparation reste valable si la porte passe un jour en `enforce` : elle dit de quel',
      'livre un gel parle, pas dans quel mode il est lu.',
    ]);
  }

  // ── W5 — C7, reconstructed in the chained machinery ───────────────────────────────
  {
    const sent = rows.reduce((sum, r) => sum + r.B.sent, 0);
    const movingCycles = rows.filter((r) => r.B.sent > 0).length;
    const byOrigin: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    for (const row of rows) {
      for (const [origin, count] of Object.entries(row.B.sent_by_origin)) {
        byOrigin[origin] = (byOrigin[origin] ?? 0) + count;
      }
      for (const [reason, count] of Object.entries(row.B.suppressed_by_reason)) {
        byReason[reason] = (byReason[reason] ?? 0) + count;
      }
    }
    const outsideTarget = rows.filter((r) => r.B.label !== 'aucune_correction').length;
    const botGaps = rows.map((r) => outsideBandPoints(r.bot_exposure_percent, {
      lowPercent: r.band_low_percent,
      highPercent: r.band_high_percent,
    }));
    const bGaps = rows.map((r) => r.B.band_gap_points);
    const unrealisable = rows.map((r) => r.B.unrealisable_points).filter((p) => p > 0);
    const fmt = (bins: Record<string, number>): string =>
      Object.entries(bins).map(([k, n]) => `${k} ${n}`).join(' · ');
    record('W5', 'C7 — ce que la répartition envoie réellement, en chaîne', true, [
      'HYPOTHÈSE AFFICHÉE : B̂ rejoue les réponses HISTORIQUES du modèle contre un livre que le',
      'modèle n’a jamais vu. Il mesure la conséquence MÉCANIQUE de la correction sous décisions',
      'historiques figées. Ce n’est ni une simulation de la réaction future du modèle, ni une',
      'borne — ni haute ni basse — de performance.',
      '',
      `La cible du modèle sort de la bande sur ${outsideTarget} cycle(s) sur ${rows.length}. Mais une fois le`,
      `livre déjà corrigé, seuls ${movingCycles} cycle(s) ont quelque chose à envoyer — ${sent} jambe(s) au total.`,
      'C’est la mesure que la brique 1 annonçait sans pouvoir la produire : sa fréquence était',
      'une BORNE HAUTE ré-ancrée, parce que le livre y retombait sous le plancher à chaque',
      'réveil. En chaîne, le livre garde ses propres corrections.',
      '',
      `  jambes par origine : ${Object.entries(byOrigin).map(([o, n]) => `${o} ${n}`).join(' · ') || 'aucune'}`,
      `  supprimées         : ${Object.entries(byReason).map(([o, n]) => `${o} ${n}`).join(' · ') || 'aucune'}`,
      '',
      'ÉCART À LA BANDE du livre après le cycle — le même barème pour les deux :',
      `  bot réel : ${fmt(bandBins(botGaps))}`,
      `  B̂       : ${fmt(bandBins(bGaps))}`,
      'Les cycles « moins de 0,1 pt » sont la traînée de frais publiée par la brique 2, pas un',
      'échec de la bande : un budget d’achat divisé par (1 + frais) arrive un cheveu trop court.',
      `Points hors d’atteinte quand il y en a : ${unrealisable.length} cycle(s), médiane ` +
        `${median(unrealisable)?.toFixed(2)} pt, maximum ${Math.max(...unrealisable).toFixed(2)} pt, ` +
        `dont ${unrealisable.filter((p) => p > 1).length} au-dessus du point.`,
    ]);
  }

  // ── W6 — C8 gets its reader and NO verdict ────────────────────────────────────────
  {
    const created = rows.reduce(
      (sum, r) => sum + (r.B.sent_by_origin['allocation_de_secours'] ?? 0) + (r.B.sent_by_origin['correction_de_bande'] ?? 0),
      0,
    );
    record('W6', 'C8 — le lecteur existe, le verdict n’est pas rendu', true, [
      'La question est : le modèle UTILISE-t-il l’exposition imposée, ou la combat-il ? Elle',
      'porte sur ce que le modèle fait quand il VOIT une position que le correcteur a créée.',
      'En mode observation il n’en a jamais vu une seule. Aucun contrefactuel chaîné ne répare',
      'cela : il ferait répondre les mots réels du modèle à une question qu’on ne lui a jamais',
      'posée. Un chiffre affaibli publié ici serait lu comme la réponse.',
      `Les données sont conservées : ${created} jambe(s) créée(s) par la correction dans cette`,
      'fenêtre, chacune avec son origine, son `correction_moves_holding` et son poids réalisé.',
      'Le lecteur (`readAdoption`) distingue adoption, indifférence et lutte — trois lectures,',
      'parce qu’un modèle qui redemande sa propre préférence n’est pas un modèle qui lutte.',
      'C8 commence le jour où `application` expose réellement le modèle aux positions corrigées.',
    ]);
  }

  // ── The artefact ─────────────────────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const written = writeArtefact(OUT_DIR, 'witnesses.json', {
    policy: config.exposureBand,
    caps: config.execution.caps,
    execution: { feePercent: config.execution.feePercent, minMovementPercent: config.execution.minMovementPercent },
    window: {
      settled_cutoff_id: cutoffId,
      official: pilotWindow.official,
      official_instant: pilotWindow.official ? pilotWindow.instant : null,
      not_official_because: pilotWindow.official ? null : pilotWindow.reason,
      cycles: rows.length,
      from_id: rows[0]?.decision_id ?? null,
      to_id: rows[rows.length - 1]?.decision_id ?? null,
      // ONE ENTRY PER SEGMENT, never a single window. A run that resumed after a cut is not
      // one continuous history, and an artefact that flattened it into one would invite
      // exactly the reading the cut exists to forbid.
      segments: segments.map((segment) => ({
        id: segment.id,
        cycles: segment.cycles.length,
        from_id: segment.cycles[0]!.decision.id,
        to_id: segment.cycles[segment.cycles.length - 1]!.decision.id,
        opening_equity: segment.cycles[0]!.botEquityAfter,
        opening: segment.opening,
        broken_by: segment.brokenBy,
      })),
      gaps: gaps.map((gap) => ({ decision_id: gap.id, cause: gap.cause, placement: gap.placement })),
    },
    contract: {
      not_measured: [
        'aucun rendement, aucun drawdown, aucun écart bot-témoin : la fenêtre du pilote commence au passage en `application`',
        'B̂ mesure la conséquence mécanique de la correction sous décisions historiques figées — pas la réaction du modèle, pas une borne de performance',
        'C8 ne reçoit aucun verdict pendant l’observation',
      ],
      witnesses_bear: ['frais', 'seuil de mouvement', 'poussière', 'prix absent', 'budget insuffisant'],
      witnesses_do_not_bear: ['gels', 'stops', 'transitions du livre du bot'],
    },
    rows,
  });
  console.log('');
  console.log(`Artefact : ${written.file}  ${written.sha256}  ${written.bytes} octets`);

  const failed = results.filter((r) => !r.passed);
  console.log('');
  console.log('='.repeat(96));
  console.log(
    failed.length === 0
      ? `Tous les ${results.length} critères passent.`
      : `${failed.length} critère(s) en échec : ${failed.map((r) => r.id).join(', ')}`,
  );
  console.log('='.repeat(96));
  if (failed.length > 0) process.exitCode = 1;
}

/**
 * How far OUTSIDE the band a book sits, in points. Zero when it is inside.
 *
 * Reported in bins rather than as a boolean, because a book at 44.97 against a floor of 45 is
 * not "outside the band" in any sense a reader means by it: that is the fee drag brick 2
 * measured and published — a buy budget divided by (1 + fee) lands a hair short. A tolerance
 * of a hundredth of a point would have counted 143 such cycles as failures of the band.
 */
function outsideBandPoints(exposurePercent: number, band: { lowPercent: number; highPercent: number }): number {
  if (exposurePercent < band.lowPercent) return Math.round((band.lowPercent - exposurePercent) * 1e6) / 1e6;
  if (exposurePercent > band.highPercent) return Math.round((exposurePercent - band.highPercent) * 1e6) / 1e6;
  return 0;
}

/** The same bins for every book, so two books can be read side by side. */
function bandBins(gaps: number[]): Record<string, number> {
  const bins: Record<string, number> = {
    'dans la bande': 0,
    'moins de 0,1 pt': 0,
    '0,1 a 1 pt': 0,
    '1 a 5 pt': 0,
    'plus de 5 pt': 0,
  };
  const bump = (key: string): void => {
    bins[key] = (bins[key] ?? 0) + 1;
  };
  for (const gap of gaps) {
    if (gap <= 0) bump('dans la bande');
    else if (gap <= 0.1) bump('moins de 0,1 pt');
    else if (gap <= 1) bump('0,1 a 1 pt');
    else if (gap <= 5) bump('1 a 5 pt');
    else bump('plus de 5 pt');
  }
  return bins;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
