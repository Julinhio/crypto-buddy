import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FREEZE_FILE, FreezeRefusedError, loadFreeze, type CandidateFreeze } from './freeze.js';

/**
 * THE OPENING OF THE INTERNAL VERIFICATION — an unforgeable capability (Codex, PR #50, P1).
 *
 * The first version exported a class with a public constructor, and \`assertMeasurable\` and the
 * tape accepted any \`instanceof\` it: any script could mint an opening with invented evidence
 * and read the verification without a committed freeze. Here:
 *
 *   - the class is module-private, and NOT what the gates check;
 *   - an opening is genuine only if it sits in \`ISSUED\`, a module-private WeakSet that only
 *     \`openVerification\` writes to, after every check has passed. Constructing an object of the
 *     same shape, of a class with the same name, or of THIS class through a genuine opening's
 *     \`.constructor\`, yields something \`isGenuineOpening\` rejects;
 *   - \`openVerification\` takes no environment: it reads the git facts itself, in \`rootDir\`. The
 *     injectable environment survives only in \`checkOpeningConditions\`, which is pure and
 *     returns nothing — it lets the tests prove each refusal, and it issues no opening.
 *
 * The conditions: the freeze verifies its own digest; it is committed at HEAD with this exact
 * content; the working tree is clean outside the verification artefacts; the source tree is the
 * one that wrote the freeze; and the dependency lock is the one the freeze recorded (Codex,
 * PR #50, P2 — a dependency bump committed without touching \`src\` used to pass).
 */

export interface VerificationOpening {
  readonly evidence: Readonly<{ freezeSha256: string; freezeCommit: string; sourceTreeSha: string; depsLockSha: string }>;
}

class GenuineOpening implements VerificationOpening {
  readonly evidence: VerificationOpening['evidence'];
  constructor(evidence: VerificationOpening['evidence']) {
    this.evidence = Object.freeze({ ...evidence });
    Object.freeze(this);
  }
}

const ISSUED = new WeakSet<object>();

/** The only test the gates apply. A structural look-alike, or a re-constructed object, fails. */
export function isGenuineOpening(candidate: unknown): candidate is VerificationOpening {
  return typeof candidate === 'object' && candidate !== null && ISSUED.has(candidate);
}

/** The git facts an opening rests on, as read in a repository. */
export interface OpeningEnv {
  committed: boolean | null;
  dirtyPaths: string[];
  sourceTreeSha: string | null;
  depsLockSha: string | null;
  freezeCommit: string | null;
}

/**
 * PURE: throws the first refusal, or returns. Issues nothing — this is the seam the tests use to
 * prove every refusal without ever holding an opening.
 */
export function checkOpeningConditions(freeze: CandidateFreeze, env: OpeningEnv): void {
  if (env.committed !== true) throw new FreezeRefusedError(`${FREEZE_FILE} is not committed at HEAD with this content`);
  if (env.dirtyPaths.length > 0) throw new FreezeRefusedError(`the working tree is not clean (${env.dirtyPaths.slice(0, 5).join('; ')})`);
  if (env.sourceTreeSha == null || env.sourceTreeSha !== freeze.source_tree_sha) {
    throw new FreezeRefusedError(`the source tree ${env.sourceTreeSha} is not the one that froze (${freeze.source_tree_sha})`);
  }
  if (freeze.deps_lock_sha == null) throw new FreezeRefusedError('the freeze records no dependency lock');
  if (env.depsLockSha == null || env.depsLockSha !== freeze.deps_lock_sha) {
    throw new FreezeRefusedError(`the dependency lock ${env.depsLockSha} is not the one the freeze recorded (${freeze.deps_lock_sha})`);
  }
  if (env.freezeCommit == null) throw new FreezeRefusedError('no commit carries the freeze');
}

function git(rootDir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Reads the git facts IN \`rootDir\` — never the process's working directory. Not exported. */
function readOpeningEnv(rootDir: string, artefactDir: string): OpeningEnv {
  const rel = FREEZE_FILE.split(path.sep).join('/');
  const atHead = git(rootDir, ['rev-parse', `HEAD:${rel}`]);
  const working = git(rootDir, ['hash-object', rel]);
  const status = git(rootDir, ['status', '--porcelain', '--untracked-files=all', '--', '.', `:!${artefactDir.split(path.sep).join('/')}`]);
  return {
    committed: atHead == null || working == null ? null : atHead === working,
    dirtyPaths: (status ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0),
    sourceTreeSha: git(rootDir, ['rev-parse', 'HEAD:src']),
    depsLockSha: git(rootDir, ['rev-parse', 'HEAD:package-lock.json']),
    freezeCommit: git(rootDir, ['log', '-1', '--format=%H', '--', rel]),
  };
}

/**
 * The ONLY way to obtain a genuine opening. Loads the freeze from \`rootDir\`, reads the git facts
 * there, applies every condition, and only then issues.
 */
export function openVerification(rootDir: string, artefactDir: string): VerificationOpening {
  const freeze = loadFreeze(rootDir);
  const env = readOpeningEnv(rootDir, artefactDir);
  checkOpeningConditions(freeze, env);
  const opening = new GenuineOpening({
    freezeSha256: freeze.decisions_sha256,
    freezeCommit: env.freezeCommit!,
    sourceTreeSha: env.sourceTreeSha!,
    depsLockSha: env.depsLockSha!,
  });
  ISSUED.add(opening);
  return opening;
}
