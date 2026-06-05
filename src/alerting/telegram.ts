/**
 * Telegram sender for internal alerts. BEST-EFFORT by contract: it NEVER throws and
 * NEVER blocks the beat. A missing config, an unreachable Telegram, a non-2xx, or a
 * timeout are all logged and swallowed — the bot does not depend on its alerts to
 * trade, so an alerting outage must not interrupt a heartbeat (the deliberate
 * opposite of the fail-loud posture reserved for the DB / exchange / LLM).
 *
 * The token + chat id are read from the environment at call time (like the Supabase
 * and Anthropic keys), so no secret lives in committed config.
 */

/** Hard cap so a hung Telegram can never stall the one-shot beat's clean exit. */
const TELEGRAM_TIMEOUT_MS = 5_000;

/**
 * Sends `text` to the configured chat. Returns true only on a confirmed 2xx — handy
 * for the test script — but callers in the beat ignore it: the debounce flag is
 * already persisted (intent-first), so a failed send is simply logged and dropped,
 * never retried (no spam).
 */
export async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn(
      '[warn] Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing) — alert not sent.',
    );
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Telegram returns a JSON body with a `description` on errors — surface a
      // bounded slice of it so a bad token / chat id is diagnosable from the logs.
      const body = await res.text().catch(() => '');
      console.warn(`[warn] Telegram sendMessage failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return false;
    }
    console.log('[alert] Telegram message sent.');
    return true;
  } catch (err) {
    console.warn(
      `[warn] Telegram send errored (best-effort, ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
