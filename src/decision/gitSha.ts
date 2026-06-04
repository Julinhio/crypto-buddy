import { execSync } from 'node:child_process';

/**
 * The commit that produced a decision, for traceability.
 *
 * Environment first (CI sets one of these), then a local `git rev-parse`, then
 * null — degrading cleanly when neither is available (e.g. a built artifact
 * with no git checkout and no CI vars).
 */
export function getGitSha(): string | null {
  const fromEnv =
    process.env.GIT_SHA ?? process.env.GITHUB_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().slice(0, 40);

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
