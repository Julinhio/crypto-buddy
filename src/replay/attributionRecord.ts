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
