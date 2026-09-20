/**
 * The ACTIVITY notification — a Telegram message on every wake-up where the bot
 * actually placed orders (a HOLD sends nothing). Distinct from the anomaly alerts
 * (overheating / degraded): this one is "here's what I did", not "something's wrong".
 *
 * Same posture as the alerts: the payload is built PURE (no env, no network, no
 * clock of its own — the timestamp is passed in), and beat.ts sends it best-effort
 * (sendTelegram: 5s timeout, never throws), strictly OUTSIDE the fenced cycle.
 *
 * The FACT (what moved) comes from the executions LEDGER booked this cycle — the
 * sign of baseDelta for the side, |quoteDelta| for the dollar amount — NEVER from
 * the model's self-assigned action_type (the same fact/intention split as the
 * dashboard PR #9). The resulting allocation + total come from the POST-trade book
 * (portfolioAfter).
 *
 * ── WHO MOVED EACH LINE ────────────────────────────────────────────────────────────
 *
 * Until 20/09/2026 the "why" under the movements was the model's `notification_summary`,
 * verbatim and alone — which read as if every order were the model's. Three layers other
 * than the model can move the book: the exposure band (2112: three buys under "aucune
 * action"), the peak stop (2051: a $142 exit under "maintien de toutes les positions"), and
 * the two together with a real revision (2139). The orders were right; the message lied by
 * juxtaposition. So each movement now carries the ORIGIN the cycle's facts prove — see
 * `provenance.ts` for the frontier — the layers get their own line, and the model's text is
 * labelled as what it is: the model's reasoning, never a global justification.
 */
import type { DecideResult } from '../decision/decide.js';
import { attributeCycle, formatPercent, type AttributedMovement, type BandFact, type CycleAttribution } from '../decision/provenance.js';
import { formatAllocation, orderedAllocation, type AllocationSlice } from './allocation.js';

export interface ActivityMovement {
  asset: string;
  side: 'buy' | 'sell';
  /** Dollars moved (|quoteDelta|, fee-inclusive cash impact), rounded for display. */
  usd: number;
}

export interface ActivityNotification {
  /** ISO timestamp of the wake-up (DB now()), for the header time. */
  timestamp: string;
  /** What actually moved this cycle, biggest first. */
  movements: ActivityMovement[];
  /** Each movement with the origin the cycle's facts prove, in the same order. */
  attribution: CycleAttribution;
  /** The model's concise notification_summary — its reasoning, labelled as such. */
  modelReasoning: string;
  /** Resulting allocation — positions biggest-first, cash last (see allocation.ts). */
  allocation: AllocationSlice[];
  /** Resulting total equity (USD). */
  totalUsd: number;
}

/**
 * Builds the activity-notification payload from a cycle result — PURE, no I/O.
 * Returns null UNLESS the cycle DECIDED and actually booked ≥1 movement at the
 * ledger (the fact). A hold (nothing booked), a skip, or an error → null → no
 * notification, so a bot that wakes every 15 min only pings when it truly moves.
 */
export function prepareActivityNotification(
  result: DecideResult,
  timestamp: string,
): ActivityNotification | null {
  if (result.status !== 'decided') return null;
  const booked = result.execution?.bookedLedger ?? [];
  if (booked.length === 0) return null; // HOLD / nothing booked → no notification
  const after = result.portfolioAfter;
  if (after == null) return null; // defensive — a decided+booked cycle always has it

  // Movements from the LEDGER: side = sign of baseDelta, $ = |quoteDelta|, per asset.
  const byAsset = new Map<string, ActivityMovement>();
  for (const e of booked) {
    const asset = e.symbol.split('/')[0];
    if (!asset) continue;
    const usd = e.quoteDelta.abs().toNumber();
    const existing = byAsset.get(asset);
    if (existing) existing.usd += usd; // defensive (one booking per asset in practice)
    else byAsset.set(asset, { asset, side: e.baseDelta.gt(0) ? 'buy' : 'sell', usd });
  }
  const movements = [...byAsset.values()].sort((a, b) => b.usd - a.usd);

  // Resulting allocation via the shared helper: positions biggest-first, cash last.
  const equityPositive = after.equity.gt(0);
  const positionSlices: AllocationSlice[] = [];
  for (const p of after.positions) {
    const weight = equityPositive ? p.value.div(after.equity).times(100).toNumber() : 0;
    if (weight > 0) positionSlices.push({ label: p.asset, weight });
  }
  const cashWeight = equityPositive ? after.cash.div(after.equity).times(100).toNumber() : 0;

  return {
    timestamp,
    movements,
    // `result.provenance` is absent on fixtures assembled without it; the attribution
    // then says so on every line rather than guessing (see attributeCycle).
    attribution: attributeCycle(result.provenance ?? null, movements),
    modelReasoning: (result.row.notification_summary ?? '').trim(),
    allocation: orderedAllocation(positionSlices, cashWeight),
    totalUsd: after.equity.toNumber(),
  };
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** Wake-up time as `HH'h'MM`, in UTC (the project's display convention). */
function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}h${pad2(d.getUTCMinutes())}`;
}

/** French elision: `d'ETH` before a vowel, `de BTC` otherwise. */
function ofAsset(asset: string): string {
  return 'AEIOU'.includes(asset[0] ?? '') ? `d'${asset}` : `de ${asset}`;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

const fmtUsd = (n: number): string => `~${Math.round(n)}$`;
const pct = (n: number): string => `${formatPercent(n)} %`;
const pts = (n: number): string => `${n > 0 ? '+' : ''}${formatPercent(n)} pt${Math.abs(n) >= 2 ? 's' : ''}`;

/** The short tag after a movement — the origin, and the layers that resized it. */
function originTag(m: AttributedMovement): string {
  switch (m.origin) {
    case 'modele': {
      const resized = m.adjustments.map((a) =>
        a.layer === 'bande' ? 'montant ajusté par la bande' : 'borné par le plafond de risque',
      );
      return ['modèle', ...resized].join(', ');
    }
    case 'stop':
      return 'stop de pic (code)';
    case 'bande':
      return 'bande';
    case 'bande_deplacement':
      return 'bande (déplacement de correction)';
    case 'bande_contre_modele':
      return "bande, contre l'intention du modèle";
    case 'retour_vers_cible':
      return 'retour vers la cible (chaîne)';
    case 'derive':
      return 'rééquilibrage de dérive (cible maintenue)';
    case 'non_etablie':
      return 'origine non établie';
  }
}

/** The model's line: what it decided this cycle, judged on its intention alone. */
function modelLine(n: ActivityNotification): string {
  const a = n.attribution;
  if (!a.hasIntentReference) {
    return 'Modèle : aucune intention de référence (première décision ou référence illisible) — ses lignes ne sont pas jugées.';
  }
  if (a.revisions.length === 0) return 'Modèle : maintien, aucune ligne révisée.';
  const parts = a.revisions.map((r) => {
    const from = r.fromPercent == null ? 'ouvert' : formatPercent(r.fromPercent);
    let text = `${r.asset} ${from} → ${formatPercent(r.toPercent)} %`;
    const traded = a.movements.find((m) => m.asset === r.asset && m.origin === 'modele');
    const movedByAnother = a.movements.find((m) => m.asset === r.asset && m.origin !== 'modele');
    if (traded) {
      for (const adj of traded.adjustments) {
        if (adj.layer === 'bande') {
          text += ` (son plan initial aurait ${traded.side === 'buy' ? 'acheté' : 'vendu'} ${fmtUsd(adj.modelPlanNotional)} ${ofAsset(r.asset)})`;
        } else {
          text += ` (borné par le plafond de risque à ${pct(adj.toPercent)})`;
        }
      }
    } else if (movedByAnother?.origin === 'stop') {
      // The stop exited the line the model was revising: the exit is the code's, the
      // revision stays the model's.
      text += ' (ligne sortie par le stop)';
    } else if (movedByAnother) {
      // The line traded, but not on the model's account: its revision alone produced no
      // movement (a sub-floor change, or a weight the book already held).
      text += ' (sans mouvement propre)';
    } else if (!r.traded) {
      text += ' (non tradé)';
    }
    return text;
  });
  return `Modèle : révision ${parts.join(', ')}.`;
}

/** The band's line — the bound it moved the target to and what each line absorbed. */
function bandLine(n: ActivityNotification): string | null {
  const band = n.attribution.band;
  if (band == null) return null;
  const causeOf = (l: BandFact['lines'][number]): string => {
    if (l.origin === 'allocation_de_secours') return ' (ligne ouverte, sans conviction du modèle)';
    if (l.cause === 'seuil_de_mouvement') return ' (sous le seuil)';
    if (l.cause === 'plafond_individuel') return ' (plafond individuel)';
    if (l.cause === 'gel') return ' (gelée)';
    return '';
  };
  const moved = band.lines
    .filter((l) => Math.abs(l.correctionPoints) > 0.005)
    .sort((x, y) => Math.abs(y.correctionPoints) - Math.abs(x.correctionPoints))
    .map((l) => `${l.asset} ${pts(l.correctionPoints)}${causeOf(l)}`);
  const clauses: string[] = [];
  if (band.boundPercent != null) {
    const verb = band.direction === 'up' ? 'relevée au plancher' : 'abaissée au plafond';
    let head = `exposition cible ${pct(band.targetExposurePercent)} ${verb} ${pct(band.boundPercent)}`;
    if (band.consolidated) head += ' (consolidation)';
    if (moved.length > 0) head += ` — ${moved.join(', ')}`;
    clauses.push(head);
  } else {
    clauses.push(`plus de correction due (exposition cible ${pct(band.targetExposurePercent)} dans la bande)`);
  }
  if (band.unrealisablePoints > 0.005) clauses.push(`${formatPercent(band.unrealisablePoints)} pt(s) irréalisables`);
  for (const m of n.attribution.movements) {
    if (m.origin === 'bande_deplacement' || m.origin === 'bande_contre_modele') clauses.push(m.note);
  }
  return `Bande : ${clauses.join(' ; ')}.`;
}

/** One line per protective exit the code generated. */
function stopLines(n: ActivityNotification): string[] {
  return n.attribution.stopExits.map((s) => {
    const cause =
      s.drawdownFromPeakPercent != null
        ? `${formatPercent(Math.abs(s.drawdownFromPeakPercent))} % sous le pic pendant une transition, seuil ${formatPercent(s.thresholdPercent)} %`
        : `seuil ${formatPercent(s.thresholdPercent)} %`;
    const movement = n.attribution.movements.find((m) => m.asset === s.asset && m.origin === 'stop');
    // A stop the code generated but the ledger does not carry did not book (a venue filter,
    // a failed booking): said as such, never presented as an exit that happened.
    if (movement == null) {
      return `Stop de pic : sortie totale ${ofAsset(s.asset)} générée par le code (${cause}) — NON comptabilisée ce cycle, voir le journal d'exécution.`;
    }
    const consequence = movement.note ? ` — ${movement.note}` : '';
    return `Stop de pic : sortie totale ${ofAsset(s.asset)} (${cause})${consequence}.`;
  });
}

/** Composes the activity Telegram text — PURE. */
export function formatActivity(n: ActivityNotification): string {
  const lines: string[] = [`🤖 Crypto-Buddy a bougé · ${formatTime(n.timestamp)}`, ''];
  const attributed = new Map(n.attribution.movements.map((m) => [`${m.asset}:${m.side}`, m]));
  for (const m of n.movements) {
    const tag = attributed.get(`${m.asset}:${m.side}`);
    lines.push(
      `${m.side === 'buy' ? 'Achat' : 'Vente'} ${fmtUsd(m.usd)} ${ofAsset(m.asset)}` +
        (tag ? ` — ${originTag(tag)}` : ''),
    );
  }
  lines.push('');
  lines.push(modelLine(n));
  lines.push(...stopLines(n));
  const band = bandLine(n);
  if (band) lines.push(band);
  const gate = n.attribution.gate;
  if (gate) {
    // The dropped vector is the one the gate judged — corrected by the band when the pilot
    // corrected — so each dropped leg names the layer whose plan carried it, never "the
    // model's" as a whole.
    const legOrigin = { modele: 'modèle', derive: 'cible maintenue', bande: 'bande', non_etablie: 'origine non établie' } as const;
    const dropped = gate.droppedLegs.map((l) => `${l.side === 'buy' ? 'achat' : 'vente'} ${l.asset} (${legOrigin[l.origin]})`).join(', ');
    lines.push(
      `Porte de transition : vecteur refusé — ${gate.droppedLegs.length} jambe(s) non exécutée(s)` +
        (dropped ? ` : ${dropped}` : '') +
        ` ; ${truncate(gate.reason, 160)}.`,
    );
  }
  for (const m of n.attribution.movements) {
    if (m.origin === 'non_etablie' || m.origin === 'retour_vers_cible' || m.origin === 'derive') {
      lines.push(`${m.asset} : ${m.note}.`);
    }
  }
  if (n.modelReasoning) lines.push(`Raisonnement du modèle : ${truncate(n.modelReasoning, 300)}`);
  lines.push('');
  lines.push(`Alloc : ${formatAllocation(n.allocation)}`);
  lines.push(`Total : ${fmtUsd(n.totalUsd)}`);
  return lines.join('\n');
}
