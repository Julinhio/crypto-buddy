import type { SupabaseClient } from '@supabase/supabase-js';
import { runBoundedWrite } from './boundedWrite.js';
import { INCIDENT_WRITE_DEADLINE_MS } from '../config/index.js';

const TABLE = 'refused_intentions';

/**
 * WHAT BECAME OF THE INTENTIONS THE GATE REFUSED.
 *
 * This is the instrumentation that will say, in a few days, whether the gate was worth its
 * cost — and it is the only part of this PR that can say so. Blocking an order is a gain
 * only if the intention was bad. If the model re-proposes it identically the moment the
 * asset unfreezes, the gate merely delayed the same trade, and that has to be discovered
 * with numbers rather than with an impression.
 *
 * ONE ROW PER EPISODE AND PER ASSET, never per cycle. A freeze spans several wake-ups and
 * the model may re-propose at each one; counting cycles would inflate the denominator and
 * make a single disagreement look like ten. The row opens on the first refusal and closes
 * on the first cycle where the asset is actionable again.
 *
 * BEST-EFFORT BY CONTRACT, like every other observational writer here: it never throws,
 * it is bounded, and its failure costs the measurement and nothing else. It runs on the
 * cycle's tail, after the orders — the placement rule this codebase applies to every
 * observational write since the PR #26 review.
 */

/** One refused leg, as the gate dropped it. */
export interface RefusedLeg {
  asset: string;
  side: 'buy' | 'sell';
  notional: string | null;
  price: string | null;
  /** The model's target for THIS asset, in percent of equity. */
  targetPercent: number | null;
  /** The reference the book was actually pursuing, in percent of equity. */
  referencePercent: number | null;
  /** `forbidden` (its own asset was frozen) or `cancelled_atomic` (swept up). */
  legVerdict: string;
  gate: string;
}

/** What the model proposed on an asset at the cycle that reopened it. */
export interface Resolution {
  asset: string;
  /** Null when the model proposed no movement at all on this asset. */
  side: 'buy' | 'sell' | null;
  targetPercent: number | null;
  price: string | null;
}

export type RefusalOutcome = 'repeated' | 'abandoned' | 'inverted' | 'unresolved';

/**
 * THE CLASSIFICATION — pure, so the meaning of "repeated" is testable without a database.
 *
 * The three outcomes answer the question the gate is on trial for:
 *
 *   - `repeated`  the model wants the same thing in the same direction. The gate DELAYED a
 *                 trade rather than preventing one. This is the outcome that would argue
 *                 for turning the gate back off.
 *   - `inverted`  the model now wants the opposite. The refused leg was one half of a
 *                 round trip, and the gate removed it. This is the 11/08 signature.
 *   - `abandoned` the model no longer wants anything here. The intention was noise.
 *
 * `unresolved` is not a verdict, it is the absence of one: the episode is still open, or it
 * ended without the asset ever coming back. Kept apart so it can never be quietly counted
 * as a success for either side of the argument.
 */
export function classifyOutcome(refusedSide: 'buy' | 'sell', resolution: Resolution | null): RefusalOutcome {
  if (resolution == null) return 'unresolved';
  if (resolution.side == null) return 'abandoned';
  return resolution.side === refusedSide ? 'repeated' : 'inverted';
}

/** Percent move from `from` to `to`. Null when either price is missing or non-positive. */
export function priceMovePercent(from: string | null, to: string | null): number | null {
  const a = from == null ? NaN : Number(from);
  const b = to == null ? NaN : Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return ((b - a) / a) * 100;
}

/**
 * Opens an episode per refused asset, or bumps the frozen-cycle count on one already open.
 *
 * Read-then-write rather than an upsert: the uniqueness that matters is PARTIAL (one open
 * row per asset), and PostgREST cannot express `on conflict (asset) where resolved_at is
 * null`. The partial index still guards the invariant in the database — this is the happy
 * path, not the enforcement.
 */
export async function openRefusedEpisodes(
  supabase: SupabaseClient | null,
  decisionId: number | null,
  legs: RefusedLeg[],
  deadlineMs: number = INCIDENT_WRITE_DEADLINE_MS,
): Promise<void> {
  if (!supabase || legs.length === 0) return;
  try {
    const assets = [...new Set(legs.map((l) => l.asset))];
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, asset, frozen_cycles')
      .in('asset', assets)
      .is('resolved_at', null)
      .abortSignal(AbortSignal.timeout(deadlineMs));
    if (error) throw new Error(error.message);
    const open = new Map(
      ((data ?? []) as { id: number; asset: string; frozen_cycles: number }[]).map((r) => [r.asset, r]),
    );

    // Already open → this is another frozen wake-up on the same episode, not a new one.
    for (const [asset, row] of open) {
      if (!assets.includes(asset)) continue;
      await runBoundedWrite(
        (signal) =>
          supabase
            .from(TABLE)
            .update({ frozen_cycles: row.frozen_cycles + 1 })
            .eq('id', row.id)
            .abortSignal(signal),
        deadlineMs,
      );
    }

    // Deduplicated by asset: a cycle can drop a buy AND a sell on the same line only
    // through conflicting legs, and the episode is about the asset, not the leg.
    const fresh = legs.filter((l) => !open.has(l.asset));
    const seen = new Set<string>();
    const rows = fresh
      .filter((l) => (seen.has(l.asset) ? false : (seen.add(l.asset), true)))
      .map((l) => ({
        asset: l.asset,
        refused_decision_id: decisionId,
        refused_side: l.side,
        refused_notional: l.notional,
        refused_price: l.price,
        refused_target_percent: l.targetPercent,
        reference_target_percent: l.referencePercent,
        refused_leg_verdict: l.legVerdict,
        gate_at_refusal: l.gate,
      }));
    if (rows.length > 0) {
      await runBoundedWrite(
        (signal) => supabase.from(TABLE).insert(rows).abortSignal(signal),
        deadlineMs,
      );
    }
  } catch (err) {
    console.warn(
      `[warn] could not open the refused-intention episode(s) (${err instanceof Error ? err.message : String(err)}) — ` +
        'the cycle is unaffected; only the measurement is lost.',
    );
  }
}

/**
 * Closes every open episode whose asset is actionable again, classifying and measuring it.
 *
 * Called on EVERY cycle, not only refused ones — the whole point is to catch the moment the
 * gate reopens, and that moment is by definition a cycle the gate did not refuse.
 */
export async function resolveRefusedEpisodes(
  supabase: SupabaseClient | null,
  decisionId: number | null,
  /** Assets actionable THIS cycle. Only these can close an episode. */
  actionableAssets: Set<string>,
  /** What the model proposed on each of them this cycle (absent = proposed nothing). */
  resolutions: Map<string, Resolution>,
  deadlineMs: number = INCIDENT_WRITE_DEADLINE_MS,
): Promise<void> {
  if (!supabase || actionableAssets.size === 0) return;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, asset, refused_at, refused_side, refused_price, refused_target_percent')
      .in('asset', [...actionableAssets])
      .is('resolved_at', null)
      .abortSignal(AbortSignal.timeout(deadlineMs));
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as {
      id: number;
      asset: string;
      refused_at: string;
      refused_side: 'buy' | 'sell';
      refused_price: string | null;
      refused_target_percent: number | null;
    }[];

    for (const row of rows) {
      const resolution = resolutions.get(row.asset) ?? {
        asset: row.asset,
        side: null,
        targetPercent: null,
        price: null,
      };
      const outcome = classifyOutcome(row.refused_side, resolution);
      const refusedAtMs = Date.parse(row.refused_at);
      const nowMs = Date.now();
      await runBoundedWrite(
        (signal) =>
          supabase
            .from(TABLE)
            .update({
              resolved_at: new Date(nowMs).toISOString(),
              resolved_decision_id: decisionId,
              resolved_side: resolution.side,
              resolved_target_percent: resolution.targetPercent,
              resolved_price: resolution.price,
              outcome,
              delay_minutes: Number.isFinite(refusedAtMs) ? (nowMs - refusedAtMs) / 60_000 : null,
              price_move_percent: priceMovePercent(row.refused_price, resolution.price),
              target_gap_percent:
                row.refused_target_percent != null && resolution.targetPercent != null
                  ? resolution.targetPercent - row.refused_target_percent
                  : null,
            })
            .eq('id', row.id)
            .abortSignal(signal),
        deadlineMs,
      );
      console.log(
        `[transition] episode closed on ${row.asset}: ${outcome} ` +
          `(refused ${row.refused_side}, now ${resolution.side ?? 'nothing'}).`,
      );
    }
  } catch (err) {
    console.warn(
      `[warn] could not resolve the refused-intention episode(s) (${err instanceof Error ? err.message : String(err)}) — ` +
        'the cycle is unaffected; only the measurement is lost.',
    );
  }
}
