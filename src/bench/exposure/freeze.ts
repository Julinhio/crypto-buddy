import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, currentSourceTreeSha, isCommittedAtHead, sha256Of } from '../../provenance/artefacts.js';
import type { ComponentName, ComponentVector } from './components.js';
import { compositeScore, linearTarget, type Normalisation } from './score.js';
import { VerificationOpening } from './windows.js';

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
 * `openVerification` is the only way to obtain the `VerificationOpening` the tape and the engine
 * demand. It refuses unless this file verifies its own digest, is committed at HEAD with this
 * exact content, the working tree is clean outside the verification artefacts, and the source
 * tree is the one that wrote the freeze.
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

/** The candidate's score at each bar, from the FROZEN normalisations — never refitted. */
export function frozenCandidateScore(
  freeze: CandidateFreeze,
  components: Map<number, ComponentVector>,
): (t: number) => number | null {
  const terms = freeze.candidate.normalisations.map((n) => ({
    normalisation: { component: n.component, mean: n.mean, sd: n.sd, learnedOn: 'development', n: n.n } as Normalisation,
    weight: 1 / freeze.candidate.normalisations.length,
  }));
  return (t) => {
    const v = components.get(t);
    return v ? compositeScore(v, terms) : null;
  };
}

export function frozenCandidateTransform(freeze: CandidateFreeze): (score: number) => number {
  return linearTarget(freeze.candidate.transform.zAtZeroPercent, freeze.candidate.transform.zAtHundredPercent);
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

export interface OpeningEnv {
  committed: boolean | null;
  dirtyPaths: string[];
  sourceTreeSha: string | null;
  freezeCommit: string | null;
}

/** The git facts the opening rests on. Injectable so each refusal is provable in a test. */
export function realOpeningEnv(rootDir: string, artefactDir: string): OpeningEnv {
  const file = path.resolve(rootDir, FREEZE_FILE);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.', `:!${artefactDir.split(path.sep).join('/')}`], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  let freezeCommit: string | null = null;
  try {
    freezeCommit = execFileSync('git', ['log', '-1', '--format=%H', '--', FREEZE_FILE.split(path.sep).join('/')], { cwd: rootDir, encoding: 'utf8' }).trim() || null;
  } catch {
    freezeCommit = null;
  }
  return {
    committed: isCommittedAtHead(file),
    dirtyPaths: status.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0),
    sourceTreeSha: currentSourceTreeSha(),
    freezeCommit,
  };
}

export function openVerification(freeze: CandidateFreeze, env: OpeningEnv): VerificationOpening {
  if (env.committed !== true) throw new FreezeRefusedError(`${FREEZE_FILE} is not committed at HEAD with this content`);
  if (env.dirtyPaths.length > 0) throw new FreezeRefusedError(`the working tree is not clean (${env.dirtyPaths.slice(0, 5).join('; ')})`);
  if (env.sourceTreeSha == null || env.sourceTreeSha !== freeze.source_tree_sha) {
    throw new FreezeRefusedError(`the source tree ${env.sourceTreeSha} is not the one that froze (${freeze.source_tree_sha})`);
  }
  if (env.freezeCommit == null) throw new FreezeRefusedError('no commit carries the freeze');
  return new VerificationOpening({ freezeSha256: freeze.decisions_sha256, freezeCommit: env.freezeCommit, sourceTreeSha: env.sourceTreeSha });
}
