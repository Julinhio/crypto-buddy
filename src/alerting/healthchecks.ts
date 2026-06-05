/**
 * Healthchecks.io dead-man's-switch ping. BEST-EFFORT by contract: NEVER throws,
 * NEVER blocks the beat. The signal we publish is "the process is alive and the
 * cron is beating" — so the ping fires once at the END of every clean beat (see
 * beat.ts), whether or not a decision cycle actually ran.
 *
 * The detection of SILENCE (process down, cron broken, crash) is Healthchecks' job,
 * not ours: configured in their dashboard (period 5 min, grace 15–20 min, email).
 * Here we only emit the "I'm alive" ping; a thrown infra fault skips it (beat.ts
 * exits non-zero via .catch), which is exactly the silence Healthchecks catches.
 *
 * The ping URL is read from the environment at call time (set on Railway at deploy;
 * unset locally is fine → a logged no-op).
 */

/** Hard cap so a hung endpoint can never stall the one-shot beat's clean exit. */
const HEALTHCHECKS_TIMEOUT_MS = 5_000;

export async function pingHealthchecks(): Promise<void> {
  const url = process.env.HEALTHCHECKS_PING_URL;
  if (!url) {
    console.warn('[warn] Healthchecks not configured (HEALTHCHECKS_PING_URL missing) — ping skipped.');
    return;
  }

  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(HEALTHCHECKS_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[warn] Healthchecks ping non-OK: HTTP ${res.status} (best-effort, ignored).`);
      return;
    }
    console.log('[beat] Healthchecks ping sent.');
  } catch (err) {
    console.warn(
      `[warn] Healthchecks ping errored (best-effort, ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
