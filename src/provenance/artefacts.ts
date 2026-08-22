import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * PROVENANCE — canonical serialisation, digests, and the identity of the code that ran.
 *
 * Extracted verbatim from `calibration/exposure/outputs.ts`, which still re-exports every
 * name so its own callers are untouched. The move exists for one reason: the exposure
 * OBSERVER must be provably band-agnostic, and `outputs.ts` imports `ARMS` at module
 * scope — so importing a two-line `sha256Of` from it would drag the three historical bands
 * into the observer's module graph and make "no band in the extraction path" an assertion
 * nobody could check. Here the graph is empty of policy, and the check is a grep.
 *
 * Everything is written canonically — two-space JSON, trailing newline, keys in a fixed
 * order — so two runs of the same code on the same input produce BYTE-IDENTICAL files.
 * That is what makes determinism a check rather than a claim.
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
 * THE RUNTIME DEPENDENCIES' identity — the blob hash of `package-lock.json` at HEAD.
 *
 * `HEAD:src` covers the code this repository writes. It does NOT cover the code this
 * repository RUNS: `technicalindicators` computes the regime timeline and `decimal.js`
 * computes every number in the replay, and their exact versions live in the lockfile, at the
 * repository root — outside `src/` entirely. Commit a dependency bump without touching
 * `src/` and the source identity is unchanged, `gitIsDirty()` is false, and the sealed window
 * would open under arithmetic that never calibrated anything.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the lockfile is the same one — i.e. what
 * SHOULD be installed. It cannot prove what IS installed: only `npm ci` makes those the same
 * thing. That residual gap is real and is stated rather than papered over; closing it would
 * mean hashing `node_modules`, which is a different chantier.
 */
export function currentDepsLockSha(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD:package-lock.json'], {
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
