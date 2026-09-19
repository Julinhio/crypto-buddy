import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'decision_integrity_marks';

/**
 * THE INTEGRITY MARKS — what a reader of the pilot's measurement must know about a decision
 * before reading it as the model's free word (migration 0039).
 *
 * Read-only from the code's point of view: the marks are written by migrations, reviewed and
 * applied once, never by a cycle. The trading path does not import this module. The readers
 * are the measurement's — C8 (`buildEpisodes`) and the witnesses replay — and they consume
 * the STRUCTURE, never the reason's prose: the kind decides, the reason is quoted.
 *
 * Two kinds, both from the incident of 18-19/09/2026:
 *
 *   `selection_par_le_garde`         the cycle's proposal was conditioned to action by the
 *                                    coherence guard, which then refused every hold — it was
 *                                    decided because it moved, not because the model reacted;
 *   `relance_orientee_par_le_garde`  the journaled proposal is the SECOND attempt, produced
 *                                    under the guard's relaunch message. `firstAttemptTarget`
 *                                    is the first, un-steered answer when the refusal quoted
 *                                    it, so a reader can tell per line whether the relaunch
 *                                    moved the target.
 *
 * A kind this code does not know is a fact it cannot interpret: the reader names it and
 * refuses the official reading, exactly as it does for any absent layer. It never ignores it.
 */
export type IntegrityMarkKind = 'selection_par_le_garde' | 'relance_orientee_par_le_garde';

export const KNOWN_MARK_KINDS: ReadonlySet<string> = new Set<IntegrityMarkKind>([
  'selection_par_le_garde',
  'relance_orientee_par_le_garde',
]);

export interface IntegrityMark {
  decisionId: number;
  /** The stored kind, as text — a reader checks it against KNOWN_MARK_KINDS before acting. */
  kind: string;
  reason: string;
  source: string;
  /** The first attempt's allocation, for `relance_orientee_par_le_garde`; null when unknown. */
  firstAttemptTarget: Record<string, number> | null;
}

interface MarkRow {
  decision_id: number;
  kind: string;
  reason: string;
  source: string;
  first_attempt_target: unknown;
}

function allocationOf(raw: unknown): Record<string, number> | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [asset, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    out[asset] = n;
  }
  return out;
}

/**
 * Every mark on decisions up to `cutoffId`, keyed by decision. THROWS on a read error: a
 * replay that could not read the marks would read every marked cycle as the model's free
 * word, which is precisely what the table exists to prevent. No marks is a legitimate
 * answer; an unreadable table is not.
 */
export async function loadIntegrityMarks(
  supabase: SupabaseClient,
  cutoffId: number,
): Promise<Map<number, IntegrityMark[]>> {
  const PAGE = 1000;
  const byDecision = new Map<number, IntegrityMark[]>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('decision_id, kind, reason, source, first_attempt_target')
      .lte('decision_id', cutoffId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read ${TABLE} (${error.message}) — migration 0039 applied?`);
    const page = (data ?? []) as unknown as MarkRow[];
    for (const row of page) {
      const bucket = byDecision.get(row.decision_id) ?? [];
      bucket.push({
        decisionId: row.decision_id,
        kind: row.kind,
        reason: row.reason,
        source: row.source,
        firstAttemptTarget: allocationOf(row.first_attempt_target),
      });
      byDecision.set(row.decision_id, bucket);
    }
    if (page.length < PAGE) break;
  }
  return byDecision;
}
