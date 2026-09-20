/**
 * WHAT THE JOURNALS PUT ON RECORD FOR THE ATTRIBUTION REPLAY — the pure part of
 * `activityAttribution.ts`, kept apart so it can be proven without a database.
 *
 * ── THE TRANSITION MODE, and how long the pilot's identity vouches for it ─────────────
 *
 * Production reads `TRANSITION_MODE` from the environment on every wake-up, and journals it
 * nowhere per cycle. The ONE durable record of it is the exposure pilot's identity, which
 * freezes the mode at activation (migration 0037) and folds it into the contract fingerprint
 * — so a later change of mode INVALIDATES the pilot. It does not stop the bot: trading goes
 * on under the new environment mode while the pilot sits invalidated, and the frozen value
 * says nothing about those cycles.
 *
 * So the frozen mode is on record for a cycle ONLY when that cycle's own band observation
 * proves the pilot was still active under its contract at that instant: the row exists,
 * its mode is `application`, and `pilot_hold` is null (the correction was allowed — identity
 * read, contract matched, pilot neither stopped nor interrupted). Every other case — a cycle
 * before activation, a missing observation (which is NOT a null hold: it is the absence of
 * the fact), a hold naming a divergence, an interruption, a stop or an inactive mode — leaves
 * the mode unknown.
 *
 * And an unknown mode with a `stop_exit` verdict on the cycle is not resolved by a guess in
 * either direction: under `enforce` the code generated a full exit, under `observe` the same
 * verdict generated nothing, and attributing the booked movement on the wrong assumption
 * would print a protective exit production never sent (or hide one it did). The replay
 * DECLINES such a cycle instead.
 */

import { journaledClampedAllocation } from '../exposure/counterfactual.js';

export interface PilotRecord {
  activatedDecisionId: number | null;
  transitionMode: 'observe' | 'enforce' | null;
}

/** The slice of the cycle's `exposure_band_observations` row that vouches for the pilot. */
export interface ObservationRecord {
  mode: string;
  pilot_hold: string | null;
}

/**
 * The transition mode on record for a cycle, or null when nothing on record establishes it.
 * See the header: the pilot's frozen mode, vouched for by THIS cycle's observation.
 */
export function transitionModeOnRecord(
  pilot: PilotRecord,
  cycleId: number,
  observation: ObservationRecord | null,
): 'observe' | 'enforce' | null {
  if (pilot.activatedDecisionId == null || pilot.transitionMode == null) return null;
  if (cycleId < pilot.activatedDecisionId) return null;
  if (observation == null) return null; // an absent observation is not a null hold
  if (observation.mode !== 'application') return null;
  if (observation.pilot_hold != null) return null;
  return pilot.transitionMode;
}

/**
 * Whether a journal covers the cycle's universe — one row per expected asset.
 *
 * Production writes the transition journal for every tradable asset on every decided cycle,
 * and the band's per-line journal for every universe line whenever a correction ran. Both
 * writes are best-effort: a batch that timed out leaves the cycle with an empty or partial
 * journal, and a replay that read that as "no stop fired" or "the band moved nothing" would
 * reconstruct an intervention-free cycle out of a missing fact. So a journal the replay needs
 * is checked for COVERAGE — every expected asset present — and a cycle whose evidence is absent
 * or incomplete is declined, never defaulted.
 */
export function journalCoverage(
  expectedAssets: readonly string[],
  rows: ReadonlyArray<{ asset: string }>,
): { complete: boolean; missing: string[] } {
  const present = new Set(rows.map((r) => r.asset));
  const missing = expectedAssets.filter((asset) => !present.has(asset));
  return { complete: missing.length === 0, missing };
}

/**
 * THE HISTORICAL CLAMP — the risk-bounded target the guard saw that cycle, read from the
 * band's per-line journal (`clamped_weight_percent`, one row per universe asset since brick 2
 * of the pilot) and from nowhere else.
 *
 * Never recomputed. `clampAllocation` binds to the RUNNING configuration, and the caps are
 * mutable: a plan rebuilt under a later policy is a different plan from the one that ran, and
 * an attribution derived from it would present a guess as the exact notification. A cycle
 * whose journal does not carry the clamp for every universe line — a cycle before the journal
 * existed, or one whose batch was lost — is declined as not reconstructible.
 */
export function historicalClamp(
  rows: ReadonlyArray<{ asset: string; clamped_weight_percent: string | number }>,
  universeAssets: readonly string[],
  reserveAsset: string,
): { clamped: Record<string, number> } | { declined: string } {
  const coverage = journalCoverage(universeAssets, rows);
  if (!coverage.complete) {
    return {
      declined:
        `the historical clamp is not journaled for ${coverage.missing.join(', ')} — the model's plan cannot be rebuilt ` +
        'without re-clamping under today\'s caps, which are not the caps of that day; not reconstructible',
    };
  }
  const clamped = journaledClampedAllocation(
    rows.map((row) => ({ asset: row.asset, clampedWeightPercent: Number(row.clamped_weight_percent) })),
    universeAssets,
    reserveAsset,
  );
  if (clamped == null) {
    return { declined: 'the journaled clamp carries a value that is not a number — not reconstructible' };
  }
  return { clamped };
}

export interface StopVerdictRecord {
  asset: string;
}

/**
 * Whether the replay may reconstruct this cycle's stop exits, and from which verdicts.
 *
 *   - no `stop_exit` verdict: nothing to reconstruct, whatever the mode;
 *   - mode on record `enforce`: the verdicts are the code's exits;
 *   - mode on record `observe`: the verdicts were observational, no exit was generated;
 *   - mode unknown with a verdict present: DECLINED, with the reason to print.
 */
export function stopReconstruction(
  modeOnRecord: 'observe' | 'enforce' | null,
  stopVerdicts: readonly StopVerdictRecord[],
): { declined: string } | { exits: readonly StopVerdictRecord[] } {
  if (stopVerdicts.length === 0) return { exits: [] };
  if (modeOnRecord == null) {
    return {
      declined:
        `a stop_exit verdict on ${stopVerdicts.map((t) => t.asset).join(', ')} but the transition mode of this cycle ` +
        'is not on record (before the pilot\'s activation, no band observation, or a pilot hold that cycle) — ' +
        'stop attribution declined rather than guessed',
    };
  }
  return { exits: modeOnRecord === 'enforce' ? stopVerdicts : [] };
}
