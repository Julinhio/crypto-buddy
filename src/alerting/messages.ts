/**
 * Alert payloads and their human-facing Telegram text — kept PURE (no env, no
 * network, no clock of their own) so the wording is unit-testable. The heartbeat
 * builds the payload (it has the counter value, the DB timestamp, and the last
 * error); beat.ts formats and sends it best-effort.
 */

/**
 * Which health counter crossed its threshold.
 *
 * `market_data` is the SECOND health state, and it is a different question from the other
 * two. `overheating` and `degraded` both describe a bot whose cycle is misbehaving;
 * `market_data` describes a bot whose cycle is working perfectly and has nothing to look
 * at. On 09/08 the dead-man's switch was green, `consecutive_failures` was zero, and the
 * bot was blind for 23 hours — none of the existing triggers could have said so.
 *
 * `market_data_recovered` is the only DOWNWARD crossing in the system. It exists because
 * the alert it closes can stay armed for a very long time (the real outage ran 22 cycles),
 * and "it's back" is otherwise unobservable without opening the dashboard.
 */
export type AlertTrigger = 'overheating' | 'degraded' | 'market_data' | 'market_data_recovered';

export interface AlertPayload {
  trigger: AlertTrigger;
  /**
   * The counter value at the crossing (floor_delay_streak / consecutive_failures /
   * consecutive_blind_cycles). On `market_data_recovered` it is the streak that just
   * ENDED — the length of the outage, which is the one number worth reading there.
   */
  value: number;
  /** ISO timestamp of the beat (DB now()), so the message is self-dating. */
  timestamp: string;
  /** Degraded only: the last cycle's error detail, if available. */
  lastError?: string | null;
  /**
   * Market-data only: the structured cause, when the cycle managed to capture one
   * (ccxt class / HTTP status / endpoint). Absent when the outage left nothing — which is
   * exactly the pre-PR situation this exists to end.
   */
  cause?: string | null;
}

/**
 * A PEAK STOP THAT WAS ARMED ON A CYCLE THAT DIED BEFORE IT COULD FIRE.
 *
 * The gap is narrow and real: the stop's exit is synthesized after the model call, the
 * parse and the coherence guard, so a cycle that fails at any of those three returns
 * without generating it. A stop whose firing depends on the model succeeding is not
 * deterministic, and the ladder presents it as though it were.
 *
 * The chosen posture is to make the gap VISIBLE rather than to close it here: closing it
 * means placing orders on paths that today place none and that have no `decided` row to
 * anchor the sovereign booking to — a change well beyond arming the gate, and one that
 * deserves its own PR and its own proofs. So this message exists to stop the gap being
 * silent, which is the only property it was missing.
 *
 * Wording matters more than usual: the operator must not read this as "an order failed".
 * Nothing was placed, nothing was lost, and the stop fires on the next successful cycle.
 * Kept PURE, like every other message here, so the wording is unit-testable.
 */
export function formatArmedStopNotFired(params: {
  /** Assets whose peak stop would have fired on this cycle. */
  assets: string[];
  /** The cycle's terminal status — error, parse_failed, guard_failed. */
  status: string;
  /** ISO timestamp, so the message is self-dating. */
  timestamp: string;
}): string {
  const list = params.assets.join(', ');
  return (
    `🛑 crypto-buddy — STOP DE PIC NON DÉCLENCHÉ\n` +
    `Le stop était armé sur ${list}, mais le cycle a échoué (${params.status}) avant de ` +
    `pouvoir le générer.\n` +
    `AUCUN ordre n'a été passé et rien n'est perdu : la ligne est toujours ouverte, et le ` +
    `stop tirera au prochain cycle réussi.\n` +
    `À surveiller si ça se répète — c'est le seul cas où une sortie déterministe dépend ` +
    `encore de la réussite du modèle.\n` +
    `🕑 ${params.timestamp}`
  );
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
  if (payload.trigger === 'market_data') {
    // Worded to prevent the exact misreading that would waste the first ten minutes at
    // 3 a.m.: the bot is FINE, it is not down, and nothing is at risk. What is broken is
    // upstream of it. The alert that fires on a healthy bot has to say so first.
    return (
      `📉 crypto-buddy — DONNÉES DE MARCHÉ INDISPONIBLES\n` +
      `Le bot se réveille normalement mais ne voit plus le marché : ` +
      `${payload.value} cycles d'affilée sans la moindre donnée exploitable.\n` +
      `consecutive_blind_cycles = ${payload.value}\n` +
      (payload.cause && payload.cause.trim() !== ''
        ? `Cause : ${truncate(payload.cause, MAX_ERROR_CHARS)}\n`
        : `Cause : (non capturée)\n`) +
      `Aucune décision, aucun ordre : le fail-closed tient, les positions sont intactes.\n` +
      `Détail complet et sonde de diagnostic dans market_data_incidents.\n` +
      `🕑 ${payload.timestamp}`
    );
  }

  if (payload.trigger === 'market_data_recovered') {
    // Says ONLY what the trigger establishes. It fires on `marketData === 'sighted'`,
    // which is a statement about the market READ and nothing else: that same cycle may
    // still have ended in `error`, `parse_failed` or `guard_failed`, or skipped because a
    // different dependency was down. Claiming "decisions resumed" here would tell the
    // operator the all-clear on the strength of a fact that does not support it — and the
    // cycle's own outcome already has its own alert (`degraded`) if it keeps failing.
    return (
      `✅ crypto-buddy — DONNÉES DE MARCHÉ RÉTABLIES\n` +
      `Le bot revoit le marché : le dernier réveil a de nouveau obtenu des données exploitables.\n` +
      `Durée de l'aveuglement : ${payload.value} cycles.\n` +
      `(Ceci ne dit rien de l'issue du cycle lui-même — s'il échoue pour une autre raison, ` +
      `l'alerte « dégradé » prendra le relais.)\n` +
      `🕑 ${payload.timestamp}`
    );
  }

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
