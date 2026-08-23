import { execSync } from 'node:child_process';

/**
 * Environment variables that can carry the commit a decision was produced by, in
 * precedence order. `GIT_SHA` is the manual override and stays ahead of everything;
 * the rest are set by a platform for a deployment it triggered itself.
 *
 * `RAILWAY_GIT_COMMIT_SHA` is the one that matters in production: the bot runs on
 * Railway, which exports it for any deployment wired to GitHub. It was missing from
 * this list, and the container has no usable git checkout at runtime, so the env
 * lookup found nothing and the local fallback threw — which is why all 1434 decisions
 * journaled before this fix carry a NULL `git_sha`. It is appended rather than
 * inserted so the relative order of the three pre-existing sources is untouched.
 */
const SHA_ENV_VARS = [
  'GIT_SHA',
  'GITHUB_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
] as const;

/**
 * The commit as told by the environment, or null if no variable carries one.
 *
 * A BLANK variable is absence, not a value — an empty string is how a platform
 * represents a variable it declares but does not fill — so the scan continues to the
 * next candidate instead of stopping there. The previous `??` chain stopped at the
 * first *defined* variable, meaning an empty `GIT_SHA` would have masked a perfectly
 * good `RAILWAY_GIT_COMMIT_SHA` sitting right behind it.
 *
 * The value is trimmed (surrounding whitespace is a transport artefact) and clipped
 * to 40 characters — the existing length contract, which a full 40-char SHA passes
 * through whole. Nothing is validated beyond that: rejecting a shape this function
 * used to accept would be a contract change, not a fix.
 *
 * `env` is a parameter so the resolution can be proven without mutating the process.
 */
export function resolveGitShaFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const name of SHA_ENV_VARS) {
    const value = env[name];
    if (value && value.trim()) return value.trim().slice(0, 40);
  }
  return null;
}

/**
 * The commit that produced a decision, for traceability.
 *
 * Environment first (a platform or CI sets one of the variables above), then a local
 * `git rev-parse`, then null — degrading cleanly when neither is available (e.g. a
 * built artifact with no git checkout and no platform vars).
 */
export function getGitSha(): string | null {
  const fromEnv = resolveGitShaFromEnv();
  if (fromEnv) return fromEnv;

  try {
    const sha = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha || null;
  } catch {
    return null;
  }
}
