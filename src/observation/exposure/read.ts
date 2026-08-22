import type { SupabaseClient } from '@supabase/supabase-js';
import type { ObservationWindow } from './window.js';

/**
 * THE ONLY PLACE THIS BRICK TOUCHES THE DATABASE, and it only ever reads.
 *
 * Every other module in `observation/exposure` is a pure function over the rows this file
 * returns. That is not tidiness: it is what makes "read-only on the live base" checkable
 * instead of promised. One file names the tables, it calls `.select()` and nothing else, and
 * a test greps the whole observer for `insert|update|upsert|delete|rpc` and fails on a hit.
 *
 * The client is the SERVICE ROLE one — there is no other: every table is RLS deny-all with
 * no policy, so an anon key reads nothing at all. The key that can read is therefore also a
 * key that could write, and the guarantee has to come from the code path rather than from
 * the credential. Hence the single door, and the grep.
 *
 * WHAT IS DELIBERATELY NOT SELECTED. `reasoning`, `raw_response`, `notification_summary`,
 * `what_changed` and the exchange payload blob never leave the database through here. They
 * are the model's prose and the venue's answers — none of it is an input to an exposure
 * statistic, and a snapshot carrying them would be a bulk export of everything the bot has
 * ever said, in a file whose whole purpose is to be passed around.
 */

/** PostgREST caps a response at 1000 rows; every read here pages until the source is dry. */
const PAGE = 1000;
/** A runaway-loop backstop. 500 pages = 500 000 rows, far above any window this tool sees. */
const MAX_PAGES = 500;

export interface DecisionRowRead {
  id: number;
  created_at: string;
  status: string;
  skip_reason: string | null;
  prompt_version: string | null;
  model: string | null;
  git_sha: string | null;
  action_type: string | null;
  confidence: string | null;
  clamped: boolean | null;
  clamp_reason: string | null;
  applied_divergence_cause: string | null;
  target_allocation: unknown;
  applied_allocation: unknown;
  intent_allocation: unknown;
  regime: unknown;
  market_context: unknown;
}

const DECISION_COLUMNS =
  'id, created_at, status, skip_reason, prompt_version, model, git_sha, action_type, confidence, ' +
  'clamped, clamp_reason, applied_divergence_cause, target_allocation, applied_allocation, ' +
  'intent_allocation, regime, market_context';

export interface ObservationRowRead {
  id: number;
  decision_id: number;
  /**
   * When the verdict was WRITTEN, which is not when its bar closed and not when its cycle
   * started. Selected because a cycle is not atomic: a decision row can land just before the
   * cutoff and its verdicts just after it, and without this column that leak is invisible.
   */
  created_at: string;
  asset: string;
  bar_at: string | null;
  actionable: boolean;
  confirmed_regime: string | null;
  raw_regime: string | null;
  run_length: number;
  label_run: number;
  risk_off: boolean;
  stop_armed: boolean;
  stop_would_fire: boolean;
  stop_threshold_percent: number | null;
  peak_price: number | string | null;
  price: number | string | null;
  drawdown_from_peak_percent: number | null;
  stop_abstained_reason: string | null;
  gate: string;
  gate_reason: string;
  order_side: string | null;
  order_notional: number | string | null;
  order_verdict: string | null;
  order_reason: string | null;
  leg_side: string | null;
  leg_notional: number | string | null;
  leg_verdict: string | null;
  leg_reason: string | null;
  atomic_refusal: boolean | null;
  atomic_trigger_asset: string | null;
}

const OBSERVATION_COLUMNS =
  'id, decision_id, created_at, asset, bar_at, actionable, confirmed_regime, raw_regime, run_length, label_run, ' +
  'risk_off, stop_armed, stop_would_fire, stop_threshold_percent, peak_price, price, ' +
  'drawdown_from_peak_percent, stop_abstained_reason, gate, gate_reason, order_side, order_notional, ' +
  'order_verdict, order_reason, leg_side, leg_notional, leg_verdict, leg_reason, atomic_refusal, ' +
  'atomic_trigger_asset';

export interface ExecutionRowRead {
  id: number;
  decision_id: number;
  created_at: string;
  symbol: string;
  side: string;
  event_type: string;
  validation_status: string | null;
  validation_reason: string | null;
  requested_qty: number | string | null;
  executed_qty: number | string | null;
  valuation_price: number | string | null;
  fee: number | string | null;
  ledger_base_delta: number | string | null;
  ledger_quote_delta: number | string | null;
  execution_outcome: string | null;
  exchange_avg_price: number | string | null;
  intent_execution_id: number | null;
}

const EXECUTION_COLUMNS =
  'id, decision_id, created_at, symbol, side, event_type, validation_status, validation_reason, ' +
  'requested_qty, executed_qty, valuation_price, fee, ledger_base_delta, ledger_quote_delta, ' +
  'execution_outcome, exchange_avg_price, intent_execution_id';

export interface RawWindow {
  decisions: DecisionRowRead[];
  observations: ObservationRowRead[];
  executions: ExecutionRowRead[];
}

export class ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadError';
  }
}

interface PagedResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Pages one SELECT to exhaustion, ordered by `id` so the sequence is identical on every run.
 *
 * Paging over an ORDERED, APPEND-ONLY table is stable here because the window is closed at a
 * SETTLED cutoff: no row can be inserted into the middle of it between two pages.
 */
async function selectAll<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<PagedResult>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE;
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new ReadError(`${label}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  throw new ReadError(`${label}: more than ${MAX_PAGES * PAGE} rows — refusing to page further`);
}

/**
 * Reads one window: its decisions, and the transition verdicts and executions attached to
 * them.
 *
 * The two child tables are fetched on a `decision_id` RANGE and then intersected with the
 * decision id SET. The range keeps the query small; the intersection keeps it correct — it
 * costs nothing and removes the assumption that identity order and `created_at` order can
 * never disagree. They are two different clocks, and one of them is a sequence that
 * deliberately survives a `reset_bot` truncate.
 */
export async function readWindow(
  client: SupabaseClient | null,
  window: ObservationWindow,
): Promise<RawWindow> {
  if (!client) {
    throw new ReadError(
      'Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — the ' +
        'observer reads the live journal and has no offline mode.',
    );
  }

  const decisions = await selectAll<DecisionRowRead>('decisions', (from, to) =>
    client
      .from('decisions')
      .select(DECISION_COLUMNS)
      .gte('created_at', window.from)
      .lt('created_at', window.toExclusive)
      .order('id', { ascending: true })
      .range(from, to),
  );

  if (decisions.length === 0) {
    return { decisions, observations: [], executions: [] };
  }

  const ids = new Set(decisions.map((d) => d.id));
  let minId = Infinity;
  let maxId = -Infinity;
  for (const id of ids) {
    if (id < minId) minId = id;
    if (id > maxId) maxId = id;
  }

  const observations = await selectAll<ObservationRowRead>('transition_observations', (from, to) =>
    client
      .from('transition_observations')
      .select(OBSERVATION_COLUMNS)
      .gte('decision_id', minId)
      .lte('decision_id', maxId)
      .order('id', { ascending: true })
      .range(from, to),
  );

  const executions = await selectAll<ExecutionRowRead>('executions', (from, to) =>
    client
      .from('executions')
      .select(EXECUTION_COLUMNS)
      .gte('decision_id', minId)
      .lte('decision_id', maxId)
      .order('id', { ascending: true })
      .range(from, to),
  );

  // ── THE TORN READ ────────────────────────────────────────────────────────────────────
  //
  // The decisions and their two child tables are THREE separate requests. `reset_bot`
  // TRUNCATEs all three in ONE transaction, so a reset landing between them leaves this
  // process holding decisions whose verdicts and movements have already been erased — and
  // nothing downstream would notice: `transition_verdicts_are_complete_or_absent` accepts
  // zero verdicts by design (rows predating migration 0022 have none), and most cycles book
  // nothing anyway. The result would be a torn snapshot with a clean digest, which is worse
  // than no snapshot at all.
  //
  // The window is closed at a SETTLED cutoff, so no legitimate row can enter or leave it
  // while this runs. Re-reading the identity list is therefore a complete check rather than a
  // heuristic: any difference at all means the journal moved under the read, and the only
  // honest answer is to refuse. Identity sequences deliberately survive a truncate, so a
  // reset followed by fresh cycles cannot reproduce the same ids either.
  const after = await selectAll<{ id: number }>('decisions (re-read)', (from, to) =>
    client
      .from('decisions')
      .select('id')
      .gte('created_at', window.from)
      .lt('created_at', window.toExclusive)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const before = decisions.map((row) => row.id).join(',');
  if (after.map((row) => row.id).join(',') !== before) {
    throw new ReadError(
      `the journal changed while it was being read: the window held ${decisions.length} decision(s) ` +
        `at the first pass and ${after.length} at the re-read. A reset_bot (or a manual write) landed ` +
        'mid-extraction, so the child tables may no longer describe the decisions in hand. Refusing ' +
        'to seal a torn snapshot — re-run once the journal is quiet.',
    );
  }

  return {
    decisions,
    observations: observations.filter((row) => ids.has(row.decision_id)),
    executions: executions.filter((row) => ids.has(row.decision_id)),
  };
}
