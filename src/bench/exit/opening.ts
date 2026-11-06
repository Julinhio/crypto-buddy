import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256Of } from '../../provenance/artefacts.js';

/**
 * THE SINGLE OPENING OF THE SEALED WINDOW — protocol `docs/PROTOCOLE-SORTIE-v0.4.md`, §16.
 *
 * The validation window `[2024-07-01, 2026-06-01)` opens ONCE, for ONE candidate frozen beforehand.
 * This module is the only thing that can say "opened", and it says it at most once per repository:
 *
 *   - THE TOKEN. As for the internal verification (`exposure/opening.ts`), an opening is genuine only
 *     if it sits in `ISSUED_SEALED`, a module-private WeakSet written by `openSealedWindow` alone, after
 *     every check has passed. The window gate (`assertMeasurable`) and the sealed tape check
 *     `isGenuineSealedOpening` — a look-alike, or an object rebuilt through `.constructor`, fails.
 *
 *   - THE CONDITIONS, read from git in `rootDir`: the v0.4 freeze verifies its own digest; it is
 *     committed at HEAD with this exact content; the working tree is clean outside the bench's
 *     artefacts; `src`, the lockfile, the v0.4 protocol and the sealed fingerprint are the ones the
 *     freeze signed; and HEAD is PUBLIC — contained in the remote branch — so the freeze's time is
 *     on record before the first sealed byte is read.
 *
 *   - ONCE. Before any sealed file is opened, the opening writes its record, `out/bench-exit/sealed/
 *     opening.json`, with an exclusive create. A record already on disk, or one that ever existed in
 *     any commit of the repository, refuses the opening: the window is burnt by the first attempt,
 *     whatever happens after it — a refusal of the data, a crash, a disappointing number. Nothing
 *     here can delete that record, and nothing reads the sealed files without the token.
 */

export const SEALED_OUT_DIR = path.join('out', 'bench-exit', 'sealed');
export const SEALED_OPENING_RECORD = path.join(SEALED_OUT_DIR, 'opening.json');
export const SEALED_FREEZE_FILE = path.join('out', 'bench-exit', 'sealed-freeze.json');
export const SEALED_PROTOCOL_FILE = path.join('docs', 'PROTOCOLE-SORTIE-v0.4.md');
export const SEALED_FINGERPRINT_FILE = path.join('data', 'calibration', 'crypto-buddy-exposure-v2-validation.fingerprint.json');
const ARTEFACT_DIR = path.join('out', 'bench-exit');

/** The fields of the v0.4 freeze this gate reads. The writer (`run.ts`) owns the rest. */
export interface SealedFreeze {
  schema_version: 1;
  kind: 'bench-exit-sealed-freeze';
  protocol: { file: string; git_blob_sha: string };
  source_tree_sha: string;
  deps_lock_sha: string;
  bench_config_sha256: string;
  sealed_fingerprint: { file: string; git_blob_sha: string; bundle_id: string; bundle_sha256: string; manifest_sha256: string };
  decisions_sha256: string;
}

/** The digest of everything but itself — the writer's fields beyond the ones typed here included. */
export function sealedFreezeDigest(body: object): string {
  return sha256Of(canonicalJson(body));
}

export function loadSealedFreeze(rootDir: string): SealedFreeze {
  const freeze = JSON.parse(readFileSync(path.resolve(rootDir, SEALED_FREEZE_FILE), 'utf8')) as SealedFreeze;
  if (freeze.kind !== 'bench-exit-sealed-freeze' || freeze.schema_version !== 1) throw new Error('sealed opening refused: not a v0.4 freeze');
  const { decisions_sha256: declared, ...body } = freeze;
  if (sealedFreezeDigest(body) !== declared) throw new Error('sealed opening refused: the freeze was edited after it was signed');
  return freeze;
}

export interface SealedOpening {
  readonly evidence: Readonly<{
    openedAt: string;
    freezeCommit: string;
    freezeDecisionsSha256: string;
    head: string;
    remoteBranch: string;
    remoteHead: string;
    sourceTreeSha: string;
    depsLockSha: string;
  }>;
}

class GenuineSealedOpening implements SealedOpening {
  readonly evidence: SealedOpening['evidence'];
  constructor(evidence: SealedOpening['evidence']) {
    this.evidence = Object.freeze({ ...evidence });
    Object.freeze(this);
  }
}

const ISSUED_SEALED = new WeakSet<object>();

/** The only test the gates apply. */
export function isGenuineSealedOpening(candidate: unknown): candidate is SealedOpening {
  return typeof candidate === 'object' && candidate !== null && ISSUED_SEALED.has(candidate);
}

/** The git facts an opening rests on. */
export interface SealedOpeningEnv {
  freezeCommitted: boolean | null;
  dirtyPaths: string[];
  sourceTreeSha: string | null;
  depsLockSha: string | null;
  protocolBlobSha: string | null;
  fingerprintBlobSha: string | null;
  freezeCommit: string | null;
  head: string | null;
  branch: string | null;
  remoteHead: string | null;
  headIsPublic: boolean;
  recordOnDisk: boolean;
  recordCommits: string[];
}

/** PURE: throws the first refusal, or returns. Issues nothing. */
export function checkSealedOpeningConditions(freeze: SealedFreeze, env: SealedOpeningEnv): void {
  const refuse = (why: string): never => {
    throw new Error(`sealed opening refused: ${why}`);
  };
  if (env.recordOnDisk) refuse(`${SEALED_OPENING_RECORD} exists — the window was already opened once`);
  if (env.recordCommits.length > 0) refuse(`${SEALED_OPENING_RECORD} exists in the history (${env.recordCommits[0]}) — the window was already opened once`);
  if (env.freezeCommitted !== true) refuse(`${SEALED_FREEZE_FILE} is not committed at HEAD with this content`);
  if (env.dirtyPaths.length > 0) refuse(`the working tree is not clean (${env.dirtyPaths.slice(0, 5).join('; ')})`);
  if (env.sourceTreeSha == null || env.sourceTreeSha !== freeze.source_tree_sha) refuse(`src/ ${env.sourceTreeSha} is not the tree the freeze signed (${freeze.source_tree_sha})`);
  if (env.depsLockSha == null || env.depsLockSha !== freeze.deps_lock_sha) refuse(`package-lock.json ${env.depsLockSha} is not the one the freeze signed (${freeze.deps_lock_sha})`);
  if (env.protocolBlobSha == null || env.protocolBlobSha !== freeze.protocol.git_blob_sha) refuse('the protocol differs from the one the freeze signed');
  if (env.fingerprintBlobSha == null || env.fingerprintBlobSha !== freeze.sealed_fingerprint.git_blob_sha) refuse('the sealed fingerprint differs from the one the freeze signed');
  if (env.freezeCommit == null || env.head == null) refuse('no commit carries the freeze');
  if (env.branch == null || env.remoteHead == null) refuse('the branch has no remote head — push the freeze before opening');
  if (!env.headIsPublic) refuse(`HEAD ${env.head} is not contained in origin/${env.branch} (${env.remoteHead}) — push the freeze before opening`);
}

function git(rootDir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const posix = (p: string): string => p.split(path.sep).join('/');

function readSealedOpeningEnv(rootDir: string): SealedOpeningEnv {
  const freezeRel = posix(SEALED_FREEZE_FILE);
  const atHead = git(rootDir, ['rev-parse', `HEAD:${freezeRel}`]);
  const working = git(rootDir, ['hash-object', freezeRel]);
  const status = git(rootDir, ['status', '--porcelain', '--untracked-files=all', '--', '.', `:!${posix(ARTEFACT_DIR)}`]);
  const head = git(rootDir, ['rev-parse', 'HEAD']);
  const branch = git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remoteLine = branch && branch !== 'HEAD' ? git(rootDir, ['ls-remote', 'origin', `refs/heads/${branch}`]) : null;
  const remoteHead = remoteLine ? remoteLine.split(/\s+/)[0] ?? null : null;
  let headIsPublic = false;
  if (head && remoteHead) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', head, remoteHead], { cwd: rootDir, stdio: 'ignore' });
      headIsPublic = true;
    } catch {
      headIsPublic = false;
    }
  }
  const history = git(rootDir, ['log', '--all', '--format=%H', '--', posix(SEALED_OPENING_RECORD)]);
  return {
    freezeCommitted: atHead == null || working == null ? null : atHead === working,
    dirtyPaths: (status ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0),
    sourceTreeSha: git(rootDir, ['rev-parse', 'HEAD:src']),
    depsLockSha: git(rootDir, ['rev-parse', 'HEAD:package-lock.json']),
    protocolBlobSha: git(rootDir, ['rev-parse', `HEAD:${posix(SEALED_PROTOCOL_FILE)}`]),
    fingerprintBlobSha: git(rootDir, ['rev-parse', `HEAD:${posix(SEALED_FINGERPRINT_FILE)}`]),
    freezeCommit: git(rootDir, ['log', '-1', '--format=%H', '--', freezeRel]),
    head,
    branch: branch && branch !== 'HEAD' ? branch : null,
    remoteHead,
    headIsPublic,
    recordOnDisk: existsSync(path.resolve(rootDir, SEALED_OPENING_RECORD)),
    recordCommits: (history ?? '').split(/\r?\n/).filter((l) => l.length > 0),
  };
}

/**
 * THE ONLY WAY TO OBTAIN A GENUINE SEALED OPENING. Applies every condition, then writes the record
 * (exclusive create: a concurrent or repeated attempt fails on the file system as well), then issues.
 * From the moment this returns, the window counts as opened.
 */
export function openSealedWindow(rootDir: string): SealedOpening {
  const freeze = loadSealedFreeze(rootDir);
  const env = readSealedOpeningEnv(rootDir);
  checkSealedOpeningConditions(freeze, env);
  const evidence: SealedOpening['evidence'] = {
    openedAt: new Date().toISOString(),
    freezeCommit: env.freezeCommit!,
    freezeDecisionsSha256: freeze.decisions_sha256,
    head: env.head!,
    remoteBranch: `origin/${env.branch!}`,
    remoteHead: env.remoteHead!,
    sourceTreeSha: env.sourceTreeSha!,
    depsLockSha: env.depsLockSha!,
  };
  const record = path.resolve(rootDir, SEALED_OPENING_RECORD);
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(
    record,
    `${JSON.stringify({ schema_version: 1, kind: 'bench-exit-sealed-opening', note: 'The sealed window [2024-07-01, 2026-06-01) was opened once, here. This record is written before any sealed file is read and is never removed.', ...evidence }, null, 2)}\n`,
    { flag: 'wx' },
  );
  const opening = new GenuineSealedOpening(evidence);
  ISSUED_SEALED.add(opening);
  return opening;
}
