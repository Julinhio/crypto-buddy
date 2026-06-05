/**
 * Alert payloads and their human-facing Telegram text — kept PURE (no env, no
 * network, no clock of their own) so the wording is unit-testable. The heartbeat
 * builds the payload (it has the counter value, the DB timestamp, and the last
 * error); beat.ts formats and sends it best-effort.
 */

/** Which health counter crossed its threshold. */
export type AlertTrigger = 'overheating' | 'degraded';

export interface AlertPayload {
  trigger: AlertTrigger;
  /** The counter value at the crossing (floor_delay_streak / consecutive_failures). */
  value: number;
  /** ISO timestamp of the beat (DB now()), so the message is self-dating. */
  timestamp: string;
  /** Degraded only: the last cycle's error detail, if available. */
  lastError?: string | null;
}

/** Keep a stack/error from blowing past Telegram's limit and burying the message. */
const MAX_ERROR_CHARS = 500;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}… [truncated]`;
}

/**
 * Composes the alert text: which trigger, the counter value, a timestamp, and — for
 * the degraded case — the last error if we have one. Concise and human on purpose.
 */
export function formatAlert(payload: AlertPayload): string {
  if (payload.trigger === 'overheating') {
    return (
      `🔥 crypto-buddy — EMBALLEMENT\n` +
      `L'IA réclame le délai plancher ${payload.value} cycles d'affilée.\n` +
      `floor_delay_streak = ${payload.value}\n` +
      `🕑 ${payload.timestamp}`
    );
  }

  const errorLine =
    payload.lastError && payload.lastError.trim() !== ''
      ? `Dernière erreur : ${truncate(payload.lastError, MAX_ERROR_CHARS)}\n`
      : `Dernière erreur : (non disponible)\n`;
  return (
    `⚠️ crypto-buddy — DÉGRADÉ\n` +
    `Le bot bat toujours mais rate son cycle à répétition.\n` +
    `consecutive_failures = ${payload.value}\n` +
    errorLine +
    `🕑 ${payload.timestamp}`
  );
}
