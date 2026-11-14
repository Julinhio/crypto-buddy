import { S4_MIN_DAYS_OUT, S4_TRAILING_STOP_PERCENT, type S4CloseEvent, type S4MoveReason } from './core.js';

/**
 * WHY AN S4 MOVEMENT HAPPENED — written by the code, from recorded values, and by nothing else.
 *
 * Chantier du 14/11/2026. The notification of the 14/11 said BTC and BNB were sold because their
 * close had fallen under the 50-day mean. That was false: the 20 % trailing stop had fired (BTC
 * 68 314 at or under 69 296, BNB 630,31 under 639,53). The sentence came from a model that was
 * handed the close and the mean but an EMPTY high and threshold — the line had already been set
 * "out", and its high goes with its entry. It filled the hole with the one comparison it could
 * see.
 *
 * So the cause is no longer something a sentence can get wrong:
 *
 *   - the CAUSE is the movement's `reason`, attributed by the cycle from the book and the line
 *     state (`s4MoveReason`);
 *   - the VALUES are the ones the deciding daily close recorded — the journal row of
 *     `s4_close_decisions`, or its in-memory twin when the close was consumed by this very cycle
 *     (`decidingFromEvent` and `decidingFromJournal` build the same object from either);
 *   - a value that could not be read is SAID to be missing. Nothing is ever filled in.
 *
 * Pure: no I/O, no clock. The live notification and the replay of past cycles run this same code.
 */
const DAY_MS = 86_400_000;

/** The daily close that decided an exit or a rebuy, as recorded when it was decided. */
export interface S4DecidingClose {
  kind: 'exit' | 'rebuy';
  closeMs: number;
  close: number;
  sma50: number;
  /** Exit: the high the close was judged against, and the exit threshold under it. */
  high: number | null;
  threshold: number | null;
  /** Rebuy: whole days between the exit close and this close. Null when not on record. */
  daysOut: number | null;
}

/** Everything the motif of ONE movement is written from. */
export interface S4MotifFacts {
  asset: string;
  side: 'buy' | 'sell';
  reason: S4MoveReason;
  /** The close whose decision this movement executes (exit / rebuy): the journal's key. */
  decidingCloseMs: number | null;
  /** That close's record — null when it has not been (or could not be) read. */
  deciding: S4DecidingClose | null;
  /** The deciding close was consumed by the cycle that moved; false = executed later. */
  decidedThisCycle: boolean;
  /** The line as the decision row recorded it, before the fills. */
  lineStatus: 'in' | 'out';
  high: number | null;
  exitThreshold: number | null;
  exitAtMs: number | null;
  /** The engine's plan for the line: weight before the orders, and target. */
  currentPercent: number | null;
  targetPercent: number | null;
}

/** The in-memory twin of a journal row: what `commitCloses` writes for this event. */
export function decidingFromEvent(event: S4CloseEvent, exitAtMs: number | null): S4DecidingClose | null {
  if (event.kind !== 'exit' && event.kind !== 'rebuy') return null;
  return {
    kind: event.kind,
    closeMs: event.closeMs,
    close: event.close,
    sma50: event.sma50,
    high: event.kind === 'exit' ? event.highAfter : null,
    threshold: event.kind === 'exit' ? event.thresholdPrice : null,
    daysOut: event.kind === 'rebuy' && exitAtMs != null ? Math.floor((event.closeMs - exitAtMs) / DAY_MS) : null,
  };
}

/** One row of `s4_close_decisions`, as PostgREST returns it (numeric → string). */
export interface S4JournalRow {
  close_at: string;
  event: string;
  close: string | number;
  sma50: string | number;
  high_after: string | number | null;
  threshold_price: string | number | null;
  days_out: number | null;
}

const numOrNull = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The journal's record of a deciding close. A rebuy row carries no `days_out` (the line is back
 * in): the duration is the last out-of-market row's count, plus the days since that row — the
 * same number `decidingFromEvent` gets from the exit date, every close being a UTC midnight.
 */
export function decidingFromJournal(row: S4JournalRow, previousOut: { close_at: string; days_out: number | null } | null): S4DecidingClose | null {
  if (row.event !== 'exit' && row.event !== 'rebuy') return null;
  const closeMs = Date.parse(row.close_at);
  const close = numOrNull(row.close);
  const sma50 = numOrNull(row.sma50);
  if (!Number.isFinite(closeMs) || close == null || sma50 == null) return null;
  let daysOut: number | null = null;
  if (row.event === 'rebuy' && previousOut?.days_out != null) {
    const prevMs = Date.parse(previousOut.close_at);
    if (Number.isFinite(prevMs) && prevMs < closeMs) daysOut = previousOut.days_out + Math.round((closeMs - prevMs) / DAY_MS);
  }
  return {
    kind: row.event,
    closeMs,
    close,
    sma50,
    high: row.event === 'exit' ? numOrNull(row.high_after) : null,
    threshold: row.event === 'exit' ? numOrNull(row.threshold_price) : null,
    daysOut,
  };
}

// ── formatting ───────────────────────────────────────────────────────────────────────────

const priceDecimals = (v: number): number => (Math.abs(v) >= 10 ? 2 : 4);
const fmtNumber = (v: number, decimals: number): string => v.toLocaleString('fr-FR', { maximumFractionDigits: decimals });
export const fmtPrice = (v: number): string => fmtNumber(v, priceDecimals(v));

/**
 * Two prices that are COMPARED in a sentence. Rounded independently they can print as the same
 * number while one is under the other; the precision is raised until the text shows the gap.
 */
function fmtCompared(a: number, b: number): [string, string] {
  let decimals = Math.max(priceDecimals(a), priceDecimals(b));
  let sa = fmtNumber(a, decimals);
  let sb = fmtNumber(b, decimals);
  while (a !== b && sa === sb && decimals < 8) {
    decimals += 1;
    sa = fmtNumber(a, decimals);
    sb = fmtNumber(b, decimals);
  }
  return [sa, sb];
}

const fmtPercent = (v: number): string => `${v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

/** "14/11" — a daily close is a UTC midnight, so the date is read in UTC. */
export function fmtCloseDay(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const UNREAD = 'Valeurs de la décision non relues dans le journal.';

function exitMotif(m: S4MotifFacts): string {
  const head = `${m.asset} vendu :`;
  const d = m.deciding?.kind === 'exit' ? m.deciding : null;
  if (d == null) {
    return `${head} sortie S4, clôture journalière à ${S4_TRAILING_STOP_PERCENT} % ou plus sous le plus-haut depuis l'entrée. ${UNREAD}`;
  }
  const later = m.decidedThisCycle ? '' : ` Sortie décidée à la clôture du ${fmtCloseDay(d.closeMs)}, exécutée à ce cycle.`;
  if (d.threshold == null || d.high == null) {
    return `${head} sortie S4, clôture ${fmtPrice(d.close)} à ${S4_TRAILING_STOP_PERCENT} % ou plus sous le plus-haut depuis l'entrée (seuil non enregistré).${later}`;
  }
  const [close, threshold] = fmtCompared(d.close, d.threshold);
  // The rule exits at or under the threshold (`close <= high × 0,8`): equality is said as such.
  const position = d.close < d.threshold ? 'sous le' : 'au niveau du';
  return `${head} clôture ${close} ${position} seuil de sortie ${threshold} (${S4_TRAILING_STOP_PERCENT} % sous le plus-haut ${fmtPrice(d.high)}).${later}`;
}

function rebuyMotif(m: S4MotifFacts): string {
  const head = `${m.asset} racheté :`;
  const d = m.deciding?.kind === 'rebuy' ? m.deciding : null;
  if (d == null) {
    return `${head} rachat S4, au moins ${S4_MIN_DAYS_OUT} jours hors marché puis clôture repassée au-dessus de la moyenne 50 jours. ${UNREAD}`;
  }
  const later = m.decidedThisCycle ? '' : ` Rachat décidé à la clôture du ${fmtCloseDay(d.closeMs)}, exécuté à ce cycle.`;
  const days = d.daysOut != null ? `${d.daysOut} jours hors marché (minimum ${S4_MIN_DAYS_OUT})` : `au moins ${S4_MIN_DAYS_OUT} jours hors marché (durée exacte non enregistrée)`;
  const [close, mean] = fmtCompared(d.close, d.sma50);
  return `${head} ${days}, clôture ${close} repassée au-dessus de la moyenne 50 jours ${mean}.${later}`;
}

function weightMove(m: S4MotifFacts, verb: string): string | null {
  if (m.currentPercent == null || m.targetPercent == null) return null;
  return `ligne ${verb} de ${fmtPercent(m.currentPercent)} à sa cible de ${fmtPercent(m.targetPercent)}`;
}

function transitionMotif(m: S4MotifFacts): string {
  const done = m.side === 'buy' ? 'acheté' : 'vendu';
  if (m.lineStatus === 'out') {
    const since = m.exitAtMs != null ? ` depuis la clôture du ${fmtCloseDay(m.exitAtMs)}` : '';
    return `${m.asset} ${done} : hors marché pour S4${since}, sa part reste en cash.`;
  }
  const move = weightMove(m, m.side === 'buy' ? 'portée' : 'ramenée') ?? 'ligne amenée à sa cible';
  const stop =
    m.high != null && m.exitThreshold != null
      ? ` (plus-haut suivi ${fmtPrice(m.high)}, seuil de sortie ${fmtPrice(m.exitThreshold)})`
      : ' (plus-haut suivi à partir de cette entrée)';
  return `${m.asset} ${done} : en marché pour S4, ${move}${stop}.`;
}

function rebalanceMotif(m: S4MotifFacts): string {
  const done = m.side === 'buy' ? 'acheté' : 'vendu';
  const move = weightMove(m, 'ramenée');
  return move != null ? `${m.asset} ${done} : rééquilibrage, ${move}.` : `${m.asset} ${done} : rééquilibrage vers la cible.`;
}

/** One sentence per movement: the cause the code attributed, with the values on record. */
export function formatS4Motif(m: S4MotifFacts): string {
  switch (m.reason) {
    case 'sortie_s4':
      return exitMotif(m);
    case 'rachat_s4':
      return rebuyMotif(m);
    case 'transition_initiale':
      return transitionMotif(m);
    default:
      return rebalanceMotif(m);
  }
}
