import { REGIME_VERSION } from '../../market/regime.js';
import type { ExperimentConfig } from './config.js';
import { experimentConfigSha256 } from './config.js';
import type { BundleManifest } from './bundle.js';
import { ARMS, BASELINE_TARGET_PERCENT, WITNESS_STEP_PERCENT, WITNESS_TARGETS } from './arms.js';
import {
  currentDepsLockSha,
  currentGitCommit,
  currentSourceTreeSha,
  gitIsDirty,
  type WrittenFile,
} from '../../provenance/artefacts.js';

/**
 * The canonical-JSON, digest and git-identity helpers this module used to DEFINE now live
 * in `provenance/artefacts.ts`, byte-identical, and are re-exported here so every existing
 * caller keeps the import it already had. They moved for one reason: the exposure OBSERVER
 * needs canonical JSON and digests while being provably free of any band, and this module
 * imports `ARMS` at module scope — so importing `sha256Of` from here would drag the three
 * historical bands into the observer's module graph and make "no band in the extraction
 * path" an assertion nobody could check.
 */
export {
  canonicalJson,
  sha256Of,
  currentGitCommit,
  currentSourceTreeSha,
  currentDepsLockSha,
  OUTPUT_DIR_PREFIX,
  gitIsDirty,
  isCommittedAtHead,
  writeArtefact,
  type WrittenFile,
} from '../../provenance/artefacts.js';

/**
 * THE THREE ARTEFACTS: raw trajectory, summary, manifest.
 *
 * THE MANIFEST DOES NOT HASH ITSELF. Same discipline as `crypto-lab`: it records the SHA-256
 * of every OTHER output, and is itself the thing you check those against. A file that
 * contained its own digest would either be lying or be impossible to produce, and the
 * temptation to "fix" it by hashing a placeholder is exactly how a provenance chain quietly
 * stops proving anything.
 *
 * Everything is written canonically — two-space JSON, trailing newline, keys in a fixed
 * order — so two runs of the same code on the same bundle produce BYTE-IDENTICAL files. That
 * is what makes determinism a check rather than a claim.
 */

export interface ManifestInput {
  kind: 'calibration' | 'validation';
  bundle: BundleManifest;
  cfg: ExperimentConfig;
  windows: Record<string, { fromMs: number; toMs: number }>;
  outputs: WrittenFile[];
  // NO timings here. See buildManifest.
  /** Anything the run wants on the record — e.g. the selection file's own digest. */
  extra?: Record<string, unknown>;
}

/**
 * Builds the manifest. Deliberately verbose: a year from now the only way to know whether
 * two result folders are comparable is whether these fields match.
 *
 * NO WALL-CLOCK TIMINGS LIVE HERE, and that is not an omission. A duration can never
 * reproduce, so a manifest carrying one could never be byte-identical across two runs — which
 * would quietly make the determinism proof unprovable on the very artefact whose job is to
 * certify the others. Timings are printed to stdout and published in the PR instead.
 */
export function buildManifest(input: ManifestInput): unknown {
  return {
    schema_version: 1,
    kind: input.kind,
    bundle_id: input.bundle.bundle_id,
    bundle_sha256: input.bundle.bundle_sha256,
    bundle_as_of_exclusive: input.bundle.as_of_exclusive,
    crypto_buddy_commit: currentGitCommit(),
    crypto_buddy_tree_dirty: gitIsDirty(),
    crypto_buddy_src_tree_sha: currentSourceTreeSha(),
    crypto_buddy_deps_lock_sha: currentDepsLockSha(),
    regime_version: REGIME_VERSION,
    experiment_config_sha256: experimentConfigSha256(input.cfg),
    experiment_config: {
      assets: [...input.cfg.assets],
      caps: Object.fromEntries(input.cfg.assets.map((a) => [a, input.cfg.caps[a]])),
      basket: Object.fromEntries(input.cfg.assets.map((a) => [a, input.cfg.basket[a]])),
      min_movement_percent: input.cfg.minMovementPercent,
      peak_stop_percent: input.cfg.peakStopPercent,
      cash_floor: 'none',
    },
    costs: {
      fee_percent_per_leg: input.cfg.feePercentPerLeg,
      slippage_percent_per_leg: input.cfg.slippagePercentPerLeg,
      execution: 'signal on the close of t, order filled at the open of t+1',
    },
    arms: Object.fromEntries(
      Object.entries(ARMS).map(([name, policy]) => [
        name,
        {
          defensive: [policy.defensive.lowPercent, policy.defensive.highPercent],
          neutral: [policy.neutral.lowPercent, policy.neutral.highPercent],
          constructive: [policy.constructive.lowPercent, policy.constructive.highPercent],
        },
      ]),
    ),
    controls: {
      deterministic_baseline_target_percent: BASELINE_TARGET_PERCENT,
      // Never "the current policy": the current policy runs through the model and is not
      // replayable. This is a constant-exposure control, and the name says so.
      deterministic_baseline_note:
        'constant-exposure control, NOT a re-enactment of the live policy (which runs through the model)',
      witness_grid: {
        from_percent: 0,
        to_percent: 100,
        step_percent: WITNESS_STEP_PERCENT,
        targets: WITNESS_TARGETS.length,
      },
    },
    windows: Object.fromEntries(
      Object.entries(input.windows).map(([name, w]) => [
        name,
        {
          from: new Date(w.fromMs).toISOString(),
          to_exclusive: new Date(w.toMs).toISOString(),
        },
      ]),
    ),
    ...(input.extra ?? {}),
    // LAST, and it does not include itself. See the header.
    outputs: [...input.outputs].sort((a, b) => (a.file < b.file ? -1 : 1)),
  };
}
