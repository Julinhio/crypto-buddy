const fs = require('fs');

// ── (B) l'identité du moteur doit couvrir les dépendances d'exécution ──────────────
let p = 'src/calibration/exposure/outputs.ts';
let s = fs.readFileSync(p, 'utf8');
const a1 = `/**
 * Was the SOURCE dirty when this ran`;
const b1 = `/**
 * THE RUNTIME DEPENDENCIES' identity — the blob hash of \`package-lock.json\` at HEAD.
 *
 * \`HEAD:src\` covers the code this repository writes. It does NOT cover the code this
 * repository RUNS: \`technicalindicators\` computes the regime timeline and \`decimal.js\`
 * computes every number in the replay, and their exact versions live in the lockfile, at the
 * repository root — outside \`src/\` entirely. Commit a dependency bump without touching
 * \`src/\` and the source identity is unchanged, \`gitIsDirty()\` is false, and the sealed window
 * would open under arithmetic that never calibrated anything.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the lockfile is the same one — i.e. what
 * SHOULD be installed. It cannot prove what IS installed: only \`npm ci\` makes those the same
 * thing. That residual gap is real and is stated rather than papered over; closing it would
 * mean hashing \`node_modules\`, which is a different chantier.
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
 * Was the SOURCE dirty when this ran`;
if (!s.includes(a1)) throw new Error('MISS outputs header');
s = s.replace(a1, b1);
s = s.replace(
  `    crypto_buddy_src_tree_sha: currentSourceTreeSha(),`,
  `    crypto_buddy_src_tree_sha: currentSourceTreeSha(),
    crypto_buddy_deps_lock_sha: currentDepsLockSha(),`,
);
// le dirty check doit aussi voir le lockfile : il est hors de src/ et hors de out/
s = s.replace(
  `      .filter((line) => !line.replace(/^\\S+\\s+/, '').startsWith(OUTPUT_DIR_PREFIX));`,
  `      .filter((line) => !line.replace(/^\\S+\\s+/, '').startsWith(OUTPUT_DIR_PREFIX));`,
);
fs.writeFileSync(p, s);
console.log('outputs ok');

// ── validate.ts : sceller sur les deux identités + refuser un témoin imparfait ─────
p = 'src/calibration/exposure/validate.ts';
s = fs.readFileSync(p, 'utf8');
s = s.replace(
  `  currentSourceTreeSha,
  gitIsDirty,
  isCommittedAtHead,`,
  `  currentDepsLockSha,
  currentSourceTreeSha,
  gitIsDirty,
  isCommittedAtHead,`,
);
s = s.replace(
  `  source_tree_sha: string | null;`,
  `  source_tree_sha: string | null;
  /**
   * THE RUNTIME DEPENDENCIES' identity — \`package-lock.json\` at HEAD.
   *
   * \`src\` is what we write; the lockfile is what we run. \`technicalindicators\` produces the
   * regime timeline and \`decimal.js\` produces the arithmetic, and neither lives under \`src/\`.
   * A dependency bump committed on its own leaves the source identity untouched, which would
   * let the sealed window open under different numerics.
   */
  deps_lock_sha: string | null;`,
);
s = s.replace(
  `        source_tree_sha: selection.source_tree_sha,`,
  `        source_tree_sha: selection.source_tree_sha,
        deps_lock_sha: selection.deps_lock_sha,`,
);
s = s.replace(
  `  env: { sourceTreeSha: string | null; dirty: boolean | null; committed: boolean | null } = {
    sourceTreeSha: currentSourceTreeSha(),
    dirty: gitIsDirty(),
    committed: file ? isCommittedAtHead(file) : null,
  },`,
  `  env: {
    sourceTreeSha: string | null;
    depsLockSha: string | null;
    dirty: boolean | null;
    committed: boolean | null;
  } = {
    sourceTreeSha: currentSourceTreeSha(),
    depsLockSha: currentDepsLockSha(),
    dirty: gitIsDirty(),
    committed: file ? isCommittedAtHead(file) : null,
  },`,
);
const a2 = `  if (gitIsDirty() !== false) {`;
const b2 = `  // The runtime half of the same identity. Checked separately from the source so a reader
  // sees WHICH one moved — "the engine changed" and "the arithmetic library changed" call for
  // different investigations.
  if (parsed.deps_lock_sha == null || env.depsLockSha == null) {
    throw new SealBrokenError(
      'the selection carries no runtime-dependency identity, or git cannot report the current ' +
        'one. The sealed window may only be opened under the dependencies that calibrated it.',
    );
  }
  if (parsed.deps_lock_sha !== env.depsLockSha) {
    throw new SealBrokenError(
      \`the selection was calibrated under package-lock \${parsed.deps_lock_sha}, this run carries \` +
        \`\${env.depsLockSha}. technicalindicators computes the regimes and decimal.js the \` +
        'arithmetic — a different lockfile is a different engine.',
    );
  }

  if (env.dirty !== false) {`;
if (!s.includes(a2)) throw new Error('MISS dirty');
s = s.replace(a2, b2);

// témoin imparfait : refus explicite
const a3 = `  for (const cfg of parsed.configurations) {
    if (!Number.isFinite(cfg.witnessTargetPercent)) {
      throw new SealBrokenError(\`configuration "\${cfg.name}" carries no frozen witness target\`);
    }
  }`;
const b3 = `  for (const cfg of parsed.configurations) {
    if (!Number.isFinite(cfg.witnessTargetPercent)) {
      throw new SealBrokenError(\`configuration "\${cfg.name}" carries no frozen witness target\`);
    }
    /*
     * AN IMPERFECT WITNESS CANNOT SUPPORT A PASS.
     *
     * The protocol is explicit: if no constant target lands inside the pre-registered
     * tolerance, the witness is declared imperfect and "ne peut soutenir aucune affirmation
     * d'excès de CAGR". The out-of-sample verdict is exactly such an affirmation — it compares
     * the configuration's net return to that witness's.
     *
     * Checking only that the target is a finite number let an unmatched witness through, and
     * validation would then have reported a pass against a control the protocol had already
     * disqualified. The arms are all sound today; a retained RSI or asymmetric variant is
     * re-searched at step 7 and has no such guarantee.
     */
    if (!Number.isFinite(cfg.witnessMismatchPoints)) {
      throw new SealBrokenError(
        \`configuration "\${cfg.name}" records no witness exposure mismatch — soundness cannot be judged\`,
      );
    }
    if (cfg.witnessMismatchPoints > WITNESS_EXPOSURE_TOLERANCE_POINTS) {
      throw new SealBrokenError(
        \`configuration "\${cfg.name}" was frozen against an IMPERFECT witness: realised exposure \` +
          \`mismatch \${cfg.witnessMismatchPoints.toFixed(3)}pt exceeds the pre-registered \` +
          \`\${WITNESS_EXPOSURE_TOLERANCE_POINTS}pt tolerance. The protocol forbids any \` +
          'excess-of-CAGR claim resting on it, and the out-of-sample verdict is such a claim.',
      );
    }
  }`;
if (!s.includes(a3)) throw new Error('MISS witness');
s = s.replace(a3, b3);
s = s.replace(
  `import { excessVsWitness, type Metrics } from './metrics.js';`,
  `import { excessVsWitness, WITNESS_EXPOSURE_TOLERANCE_POINTS, type Metrics } from './metrics.js';`,
);
fs.writeFileSync(p, s);
console.log('validate ok');

// ── calibrate.ts : écrire deps_lock_sha, refuser d'émettre un témoin imparfait ─────
p = 'src/calibration/exposure/calibrate.ts';
s = fs.readFileSync(p, 'utf8');
s = s.replace(
  `      source_tree_sha: currentSourceTreeSha(),`,
  `      source_tree_sha: currentSourceTreeSha(),
      deps_lock_sha: currentDepsLockSha(),`,
);
s = s.replace(
  `  currentSourceTreeSha,
  gitIsDirty,`,
  `  currentDepsLockSha,
  currentSourceTreeSha,
  gitIsDirty,`,
);
const a4 = `    const base = {
      schema_version: 1 as const,`;
const b4 = `    /*
     * A CONFIGURATION FROZEN AGAINST AN IMPERFECT WITNESS IS NOT VALIDABLE.
     *
     * Refused at EMISSION as well as at loading. The sealed window's check is the backstop;
     * this is the place where the fact is still fresh and the operator can act on it — being
     * told at validation time that a selection was never usable is being told too late.
     */
    const unsound = frozen.filter(
      (f) => f.configuration.witnessMismatchPoints > WITNESS_EXPOSURE_TOLERANCE_POINTS,
    );
    if (unsound.length > 0) {
      console.error(
        '\\nREFUSING to emit a selection: ' +
          unsound
            .map(
              (f) =>
                \`"\${f.configuration.name}" was frozen against an IMPERFECT witness \` +
                \`(mismatch \${f.configuration.witnessMismatchPoints.toFixed(3)}pt > \` +
                \`\${WITNESS_EXPOSURE_TOLERANCE_POINTS}pt)\`,
            )
            .join('; ') +
          '. The protocol forbids an excess-of-CAGR claim resting on such a witness.',
      );
      return 4;
    }

    const base = {
      schema_version: 1 as const,`;
if (!s.includes(a4)) throw new Error('MISS calibrate unsound');
s = s.replace(a4, b4);
s = s.replace(
  `import { excessVsWitness, type Metrics } from './metrics.js';`,
  `import { excessVsWitness, WITNESS_EXPOSURE_TOLERANCE_POINTS, type Metrics } from './metrics.js';`,
);
fs.writeFileSync(p, s);
console.log('calibrate ok');
