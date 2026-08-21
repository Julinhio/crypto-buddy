import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { REGIME_VERSION } from '../../market/regime.js';
import type { ExperimentConfig } from './config.js';
import { experimentConfigSha256 } from './config.js';
import type { BundleManifest } from './bundle.js';
import { ARMS, BASELINE_TARGET_PERCENT, WITNESS_STEP_PERCENT, WITNESS_TARGETS } from './arms.js';

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

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The commit this run was produced from.
 *
 * Read from git, and NULL when git cannot answer — never a placeholder. A manifest that
 * claimed a commit it had not verified would be worse than one that admits it does not know:
 * the whole point of the field is to let someone re-run exactly this code.
 */
export function currentGitCommit(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Whether the tree was dirty — a manifest pointing at a commit that is not what ran. */
export function gitIsDirty(): boolean | null {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

export interface WrittenFile {
  file: string;
  sha256: string;
  bytes: number;
}

/** Writes one canonical JSON artefact and returns what the manifest needs to record. */
export function writeArtefact(dir: string, name: string, value: unknown): WrittenFile {
  mkdirSync(dir, { recursive: true });
  const text = canonicalJson(value);
  writeFileSync(path.join(dir, name), text, 'utf8');
  return { file: name, sha256: sha256Of(text), bytes: Buffer.byteLength(text, 'utf8') };
}

export interface ManifestInput {
  kind: 'calibration' | 'validation';
  bundle: BundleManifest;
  cfg: ExperimentConfig;
  windows: Record<string, { fromMs: number; toMs: number }>;
  outputs: WrittenFile[];
  /** Timings, published rather than estimated. */
  timings: Record<string, number>;
  /** Anything the run wants on the record — e.g. the selection file's own digest. */
  extra?: Record<string, unknown>;
}

/**
 * Builds the manifest. Deliberately verbose: a year from now the only way to know whether
 * two result folders are comparable is whether these fields match.
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
    timings_ms: input.timings,
    ...(input.extra ?? {}),
    // LAST, and it does not include itself. See the header.
    outputs: [...input.outputs].sort((a, b) => (a.file < b.file ? -1 : 1)),
  };
}
