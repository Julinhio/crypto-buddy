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

/**
 * THE IDENTITY OF THE CODE, not of the commit.
 *
 * `git rev-parse HEAD:src` is the tree hash of `src/`. It changes the moment the engine
 * changes, and it does NOT change when a commit only adds artefacts — which is exactly the
 * distinction a sealed window needs: the selection is produced at one commit and committed at
 * the next, and only the second one exists when the window is opened.
 *
 * Comparing raw commit SHAs would therefore refuse every legitimate run; comparing nothing
 * would let the out-of-sample window be opened with engine code that never calibrated
 * anything. This is the middle, and it is the honest one.
 */
export function currentSourceTreeSha(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD:src'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Was the SOURCE dirty when this ran — i.e. is the recorded commit really the code that
 * produced these numbers?
 *
 * Deliberately blind to the output directory. A run WRITES its artefacts before stamping the
 * manifest, so a whole-tree check reports "dirty" on every single run, for a reason that has
 * nothing to do with the code. That flag would then mean nothing, and a genuinely
 * uncommitted source change — the one case it exists to catch — would hide inside the noise.
 */
export const OUTPUT_DIR_PREFIX = 'out/';

export function gitIsDirty(): boolean | null {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const sourceChanges = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // Porcelain lines read "XY path"; the path starts after the status columns.
      .filter((line) => !line.replace(/^\S+\s+/, '').startsWith(OUTPUT_DIR_PREFIX));
    return sourceChanges.length > 0;
  } catch {
    return null;
  }
}

/**
 * Is this file COMMITTED, with exactly this content, at HEAD?
 *
 * Compares the working file's blob hash to the one git has at HEAD. A digest the file
 * computes about itself proves it was not edited AFTER being frozen; it proves nothing
 * about it ever having BEEN frozen — regenerate the file and the digest regenerates with
 * it. Only git can answer the temporal question.
 *
 * Null when git cannot answer, which callers must treat as a refusal rather than a pass.
 */
export function isCommittedAtHead(file: string): boolean | null {
  try {
    const relative = path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
    const committed = execFileSync('git', ['rev-parse', `HEAD:${relative}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const working = execFileSync('git', ['hash-object', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return committed.length > 0 && committed === working;
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
