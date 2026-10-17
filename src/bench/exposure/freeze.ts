import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Of } from '../../provenance/artefacts.js';
import type { ComponentName } from './components.js';

/**
 * THE FREEZE OF THE CANDIDATE — everything the internal verification is judged against, written
 * and committed BEFORE a single verification candle is computed on (protocol v1.3, amendment of
 * 17/10 after the SCORE variants).
 *
 *   the candidate    SCORE-C-linear, threshold 20, its normalisations learned on development —
 *                    stored at full precision, and USED from this file, never refitted;
 *   the comparators  TC44 (44.226403 %), and T100, R100/0, RPA, published descriptively;
 *   the block length one per possible comparison, Politis-White on the development series of
 *                    daily log-return differences, frozen;
 *   the bootstrap    10 000 draws, seed 20261101, one-sided 95 % lower bound;
 *   the rules        every qualification filter and the verdict rules, as numbers and as text.
 *
 * The opening of the verification on this freeze lives in `opening.ts` (an unforgeable
 * capability, Codex PR #50 P1). This module only writes, signs and loads the freeze.
 */

export const FREEZE_FILE = path.join('out', 'bench-exposure', 'development', 'freeze.json');

export interface BlockLengthEntry {
  comparison: string;
  candidate: string;
  comparator: string;
  /** Whether this comparison can be DECISIONAL under the protocol (admissible comparator). */
  decisionalPossible: boolean;
  why: string;
  developmentDays: number;
  blockLength: number;
  cutoffLag: number | null;
  bandwidth: number;
}

export interface CandidateFreeze {
  schema_version: 1;
  kind: 'bench-exposure-candidate-freeze';
  protocol: string;
  source_tree_sha: string | null;
  deps_lock_sha: string | null;
  bench_config_sha256: string;
  bundles: Array<{ bundle_id: string; bundle_sha256: string }>;
  development_summary_sha256: string;
  candidate: {
    name: 'SCORE-C-linear';
    components: ComponentName[];
    weights: 'equal (simple mean of z-scores)';
    transform: { kind: 'linear'; zAtZeroPercent: number; zAtHundredPercent: number };
    rebalance_threshold_points: number;
    risk_off_forces_zero: false;
    normalisations: Array<{ component: ComponentName; mean: number; sd: number; n: number }>;
    development_mean_exposure_percent: number;
  };
  comparators: {
    TC44: { target_percent: number; definition: string };
    descriptive: string[];
  };
  /** Closing equity of each policy on the development window, which the continuous run must reproduce. */
  development_reference: Record<string, { closing_equity: number; bars: number }>;
  block_lengths: BlockLengthEntry[];
  bootstrap: {
    draws: number;
    seed: number;
    one_sided_level: number;
    statistic: string;
    method: string;
    lower_bound: string;
  };
  qualification_rules: {
    candidate_max_drawdown_percent_on_calibration: number;
    candidate_top_decile_min_median_exposure_percent: number;
    candidate_top_decile_windows: ['calibration', 'verification'];
    tc44_admissibility: string;
    tc44_admissible_min_annualised_advantage_points_on_verification: number;
    tc44_confidence_interval: 'published, does not eliminate at this stage';
    tc44_not_admissible: string;
    on_failure: string;
    sealed_window: string;
    text: string[];
  };
  verdict_rules: string[];
  /** Digest of every field above, so a post-hoc edit no longer matches. */
  decisions_sha256: string;
}

export function freezeDigest(freeze: Omit<CandidateFreeze, 'decisions_sha256'>): string {
  const { ...rest } = freeze as CandidateFreeze;
  delete (rest as Partial<CandidateFreeze>).decisions_sha256;
  return sha256Of(canonicalJson(rest));
}

export class FreezeRefusedError extends Error {
  constructor(message: string) {
    super(`internal verification refused: ${message}`);
    this.name = 'FreezeRefusedError';
  }
}

export function loadFreeze(rootDir: string): CandidateFreeze {
  let freeze: CandidateFreeze;
  try {
    freeze = JSON.parse(readFileSync(path.resolve(rootDir, FREEZE_FILE), 'utf8')) as CandidateFreeze;
  } catch (err) {
    throw new FreezeRefusedError(`cannot read ${FREEZE_FILE} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (freeze.kind !== 'bench-exposure-candidate-freeze' || freeze.schema_version !== 1) {
    throw new FreezeRefusedError('not a candidate freeze');
  }
  const recomputed = freezeDigest(freeze);
  if (recomputed !== freeze.decisions_sha256) {
    throw new FreezeRefusedError(`the freeze was edited after it was signed (declared ${freeze.decisions_sha256}, recomputed ${recomputed})`);
  }
  return freeze;
}
