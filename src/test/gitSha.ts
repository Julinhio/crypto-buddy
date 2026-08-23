import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { getGitSha, resolveGitShaFromEnv } from '../decision/gitSha.js';

/**
 * Invariants of the DECISION PROVENANCE — run with `npm test` (tsx). No framework.
 *
 * The failure being closed: 1434 of 1434 decisions carry a NULL `git_sha`. The bot runs
 * on Railway, Railway exports `RAILWAY_GIT_COMMIT_SHA` for a deployment it took from
 * GitHub, and that variable was not in the list the resolver scanned. The container has
 * no usable git checkout at runtime, so the local fallback threw and every row degraded
 * to NULL — cleanly, silently, and uselessly.
 *
 * What has to be proven is therefore not just "Railway is read now". It is that the
 * three sources that already worked still resolve exactly as they did, that the length
 * contract is unchanged, and that the absence of any provenance still degrades to NULL
 * rather than to a lie.
 */

let passed = 0;

/** The commit Railway actually deployed on 22/08 — the one the 16 live cycles ran on. */
const DEPLOYED = '40bc752c1f871d59ddd2f9e7f33138919b900441';

const SHA_VARS = ['GIT_SHA', 'GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA'] as const;

/**
 * Run `fn` with the process environment forced to `overrides` for every provenance
 * variable (plus GIT_DIR), then put the environment back EXACTLY as it was.
 *
 * A key that was absent is restored by `delete`, never by assignment: `process.env.X =
 * undefined` stores the four-letter string "undefined", which reads as a present value
 * and would leak a bogus SHA into the next case. That is asserted below, not assumed.
 */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const keys = [...SHA_VARS, 'GIT_DIR'];
  const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
  try {
    for (const k of keys) {
      const v = overrides[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

{
  // THE FIX, stated once: the variable Railway fills is recognised, and the SHA it
  // carries survives WHOLE. A 40-character commit is the identifier the deployment is
  // known by; a value clipped to a short SHA here would still not let a live cycle be
  // rattached to its binary without guessing.
  const resolved = resolveGitShaFromEnv({ RAILWAY_GIT_COMMIT_SHA: DEPLOYED });
  assert.equal(resolved, DEPLOYED, 'RAILWAY_GIT_COMMIT_SHA is recognised as a provenance source');
  assert.equal(resolved?.length, 40, 'and the full 40-character SHA is kept, not shortened');
  assert.equal(
    resolveGitShaFromEnv({ RAILWAY_GIT_COMMIT_SHA: ` ${DEPLOYED}\n` }),
    DEPLOYED,
    'surrounding whitespace is a transport artefact, not part of the SHA',
  );
  console.log('  ok: Railway provenance is recognised and the full 40-character SHA is preserved');
  passed += 1;
}

{
  // NO REGRESSION on the three sources that already worked, each on its own AND in the
  // precedence they already had. Railway was appended to the end of the list precisely
  // so that no existing deployment can start resolving to a different variable than it
  // did yesterday.
  assert.equal(resolveGitShaFromEnv({ GIT_SHA: DEPLOYED }), DEPLOYED, 'GIT_SHA still resolves');
  assert.equal(resolveGitShaFromEnv({ GITHUB_SHA: DEPLOYED }), DEPLOYED, 'GITHUB_SHA still resolves');
  assert.equal(
    resolveGitShaFromEnv({ VERCEL_GIT_COMMIT_SHA: DEPLOYED }),
    DEPLOYED,
    'VERCEL_GIT_COMMIT_SHA still resolves',
  );

  const all = {
    GIT_SHA: 'a'.repeat(40),
    GITHUB_SHA: 'b'.repeat(40),
    VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40),
    RAILWAY_GIT_COMMIT_SHA: 'd'.repeat(40),
  };
  assert.equal(
    resolveGitShaFromEnv(all),
    'a'.repeat(40),
    'GIT_SHA, the manual override, still wins over every platform',
  );
  assert.equal(
    resolveGitShaFromEnv({ ...all, GIT_SHA: undefined }),
    'b'.repeat(40),
    'then GITHUB_SHA — unchanged relative order',
  );
  assert.equal(
    resolveGitShaFromEnv({ ...all, GIT_SHA: undefined, GITHUB_SHA: undefined }),
    'c'.repeat(40),
    'then VERCEL_GIT_COMMIT_SHA — Railway was appended, not inserted',
  );
  assert.equal(
    resolveGitShaFromEnv({ RAILWAY_GIT_COMMIT_SHA: 'd'.repeat(40) }),
    'd'.repeat(40),
    'and Railway resolves when it is the only one, which is the production case',
  );
  console.log('  ok: the three pre-existing sources resolve unchanged, and keep their precedence');
  passed += 1;
}

{
  // A BLANK VARIABLE IS ABSENCE, NOT A VALUE, and it must not mask the candidate behind
  // it. The old `??` chain stopped at the first *defined* variable, so a platform that
  // declares `GIT_SHA` without filling it would have swallowed a perfectly good
  // `RAILWAY_GIT_COMMIT_SHA` and sent the row back to NULL — the exact bug, one layer up.
  assert.equal(
    resolveGitShaFromEnv({ GIT_SHA: '', RAILWAY_GIT_COMMIT_SHA: DEPLOYED }),
    DEPLOYED,
    'an empty GIT_SHA does not mask the Railway SHA behind it',
  );
  assert.equal(
    resolveGitShaFromEnv({ GIT_SHA: '   ', GITHUB_SHA: '\n', RAILWAY_GIT_COMMIT_SHA: DEPLOYED }),
    DEPLOYED,
    'nor does a whitespace-only one, at any position in the chain',
  );
  assert.equal(resolveGitShaFromEnv({}), null, 'nothing set resolves to null');
  assert.equal(
    resolveGitShaFromEnv({ GIT_SHA: '', GITHUB_SHA: '  ' }),
    null,
    'and blanks alone resolve to null',
  );
  console.log('  ok: a blank variable is treated as absent and never masks a later source');
  passed += 1;
}

{
  // THE LENGTH CONTRACT IS UNCHANGED: clip at 40, and leave anything shorter alone. This
  // is deliberately not tightened into a hex/length validation — refusing a shape the
  // function accepted yesterday would be a contract change smuggled into a bug fix.
  assert.equal(
    resolveGitShaFromEnv({ RAILWAY_GIT_COMMIT_SHA: `${DEPLOYED}-dirty-suffix` }),
    DEPLOYED,
    'an over-long value is clipped to 40 characters, as before',
  );
  assert.equal(
    resolveGitShaFromEnv({ GIT_SHA: '40bc752' }),
    '40bc752',
    'a short SHA is passed through untouched',
  );
  console.log('  ok: the 40-character clip and the passthrough of shorter values are unchanged');
  passed += 1;
}

{
  // END TO END, through the real process environment: what Railway sets is what a
  // decision would journal, and it WINS over the local checkout. On Railway there is no
  // checkout to lose to, but the order is what makes the deployed SHA authoritative
  // anywhere the two disagree — a container built from a stale layer, most obviously.
  const fromRailway = withEnv({ RAILWAY_GIT_COMMIT_SHA: DEPLOYED }, () => getGitSha());
  assert.equal(fromRailway, DEPLOYED, 'getGitSha reads the Railway variable off the real environment');
  assert.equal(fromRailway?.length, 40, 'still whole at the call site the decision row uses');

  // And the environment really was put back — the isolation the rest of these cases
  // depend on. The harness restores by `delete`, so nothing is left holding "undefined".
  assert.notEqual(
    process.env.RAILWAY_GIT_COMMIT_SHA,
    'undefined',
    'an absent variable is restored by deleting it, never by assigning undefined',
  );
  assert.notEqual(
    process.env.RAILWAY_GIT_COMMIT_SHA,
    DEPLOYED,
    'and the override does not survive the case that set it',
  );
  console.log('  ok: getGitSha resolves the Railway SHA from the process environment, and restores it');
  passed += 1;
}

{
  // THE LOCAL FALLBACK STILL RUNS when no variable carries a commit. Ground truth is
  // taken independently rather than asserted as a shape, so this stays a real comparison
  // whether or not the runner happens to sit in a checkout.
  const groundTruth = ((): string | null => {
    try {
      return (
        execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim() || null
      );
    } catch {
      return null;
    }
  })();

  const fallback = withEnv({}, () => getGitSha());
  assert.equal(
    fallback,
    groundTruth,
    'with no variable set, the local git checkout answers, exactly as before',
  );
  console.log(`  ok: the local git fallback is untouched (resolved to ${fallback ?? 'null — no checkout here'})`);
  passed += 1;
}

{
  // NO PROVENANCE AT ALL degrades to NULL, quietly and without throwing. This is the
  // branch production has been taking for 1434 rows: it is not being removed, it is
  // being demoted to what it should have been all along — the last resort. A pointed
  // GIT_DIR is how the checkout is taken away without leaving the repository.
  const nowhere = withEnv({ GIT_DIR: 'crypto-buddy-no-such-git-dir' }, () => getGitSha());
  assert.equal(nowhere, null, 'no environment SHA and no usable checkout resolves to null');

  // A cycle must never be refused over its own provenance: a decision with an unknown
  // commit is worth strictly more than no decision.
  assert.doesNotThrow(
    () => withEnv({ GIT_DIR: 'crypto-buddy-no-such-git-dir' }, () => getGitSha()),
    'an unresolvable provenance is a null, never an exception thrown into the cycle',
  );
  console.log('  ok: with no provenance anywhere, the value degrades to null instead of throwing');
  passed += 1;
}

console.log(`\n${passed} decision-provenance checks passed.`);
