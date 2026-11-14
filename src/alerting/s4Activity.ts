import type { VirtualPortfolio } from '../portfolio/derive.js';
import type { S4Line, S4MoveReason } from '../s4/core.js';
import { S4_TRAILING_STOP_PERCENT } from '../s4/core.js';
import type { S4Report } from '../s4/cycle.js';
import { decidingFromEvent, formatS4Motif, type S4DecidingClose, type S4MotifFacts } from '../s4/motif.js';
import { formatAllocation, orderedAllocation, type AllocationSlice } from './allocation.js';

/**
 * THE S4 MOVEMENT NOTIFICATION — what moved, and WHY, both written by the code.
 *
 * The cycle has already decided, booked and sent its orders when this is prepared: it reads the
 * cycle's report and nothing else. Nothing here can delay or change a movement.
 *
 * NO MODEL (chantier du 14/11/2026). Until then a model wrote the explanation from facts the code
 * handed it, and on 14/11 it gave a cause that was not the rule's (see `s4/motif.ts`). The motif
 * of each movement is now `formatS4Motif`: the cause the cycle attributed, with the values the
 * deciding close recorded. A paraphrase on top of it could add no fact and could only bring a
 * wrong cause back, so there is none.
 *
 * Two steps, because one of them may need a read:
 *   - `prepareS4Notification` (pure, called by the heartbeat) takes everything the cycle already
 *     holds — including the deciding close when THIS cycle consumed it;
 *   - `completeS4Notification` (called by `beat.ts`, after the run-lock is released) reads the
 *     journal for a movement whose decision was taken by an EARLIER cycle: an exit whose order
 *     did not fill, a rebuy that waited for a freeze to lift.
 */

export interface S4MovementFacts extends S4MotifFacts {
  usd: number;
}

export interface S4Notification {
  timestamp: string;
  label: string;
  firstCycle: boolean;
  ordersEnabled: boolean;
  movements: S4MovementFacts[];
  withheld: Array<{ asset: string; side: 'buy' | 'sell'; usd: number }>;
  allocation: AllocationSlice[];
  totalUsd: number;
}

/**
 * The close a movement executes the decision of — the key of its journal row. An exit is keyed
 * by the line's exit close; a rebuy by the close that let the line back in, which the rule
 * stamps on the line (`lastMoveAtMs`) and which stays there until the buy fills.
 */
function decidingCloseOf(reason: S4MoveReason, line: S4Line | undefined): number | null {
  if (line == null) return null;
  if (reason === 'sortie_s4') return line.status === 'out' ? line.exitAtMs : null;
  if (reason === 'rachat_s4') return line.lastMoveReason === 'rachat_s4' ? line.lastMoveAtMs : null;
  return null;
}

/** Null when nothing moved and nothing was withheld: no message at all. */
export function prepareS4Notification(report: S4Report, after: VirtualPortfolio | null, timestamp: string): S4Notification | null {
  if (report.movements.length === 0 && report.withheld.length === 0) return null;
  if (after == null) return null;
  // The line as the decision row recorded it, BEFORE the fills: an exit's key is its exit close,
  // and the post-fill line has already lost the entry a rebuy's key is read from.
  const lineOf = new Map<string, S4Line>(report.linesAtDecision.map((l) => [l.asset, l]));
  const lineBefore = new Map<string, S4Line>(report.linesBefore.map((l) => [l.asset, l]));
  const planOf = new Map(report.plan.map((p) => [p.asset, p]));
  const stop = 1 - S4_TRAILING_STOP_PERCENT / 100;

  const decidingInCycle = (asset: string, kind: 'exit' | 'rebuy', closeMs: number): S4DecidingClose | null => {
    const event = report.events.find((e) => e.asset === asset && e.kind === kind && e.closeMs === closeMs);
    if (!event) return null;
    // A rebuy's days out run from the exit close: an exit decided earlier in this same catch-up,
    // else the exit the line carried when the cycle started.
    const exitInCycle = report.events.filter((e) => e.asset === asset && e.kind === 'exit' && e.closeMs < closeMs).at(-1);
    return decidingFromEvent(event, exitInCycle?.closeMs ?? lineBefore.get(asset)?.exitAtMs ?? null);
  };

  const movements: S4MovementFacts[] = report.movements.map((m) => {
    const line = lineOf.get(m.asset);
    const plan = planOf.get(m.asset);
    const decidingCloseMs = decidingCloseOf(m.reason, line);
    const kind = m.reason === 'sortie_s4' ? 'exit' : 'rebuy';
    return {
      asset: m.asset,
      side: m.side,
      usd: m.usd,
      reason: m.reason,
      decidingCloseMs,
      deciding: decidingCloseMs != null ? decidingInCycle(m.asset, kind, decidingCloseMs) : null,
      decidedThisCycle: decidingCloseMs != null && report.closesDecided.includes(decidingCloseMs),
      lineStatus: line?.status ?? 'in',
      high: line?.status === 'in' ? line.high : null,
      exitThreshold: line?.status === 'in' && line.high != null ? line.high * stop : null,
      exitAtMs: line?.status === 'out' ? line.exitAtMs : null,
      currentPercent: plan?.currentPercent ?? null,
      targetPercent: plan?.targetPercent ?? null,
    };
  });
  const equityPositive = after.equity.gt(0);
  const slices: AllocationSlice[] = after.positions
    .map((p) => ({ label: p.asset, weight: equityPositive ? p.value.div(after.equity).times(100).toNumber() : 0 }))
    .filter((s) => s.weight > 0);
  return {
    timestamp,
    label: report.label,
    firstCycle: report.firstCycle,
    ordersEnabled: report.ordersEnabled,
    movements,
    withheld: report.withheld,
    allocation: orderedAllocation(slices, equityPositive ? after.cash.div(after.equity).times(100).toNumber() : 0),
    totalUsd: after.equity.toNumber(),
  };
}

/** Reads one deciding close from the journal. Null = not on record, or the read failed. */
export type DecidingCloseReader = (asset: string, kind: 'exit' | 'rebuy', closeMs: number) => Promise<S4DecidingClose | null>;

/**
 * Fills, from the journal, the deciding close of every exit or rebuy that this cycle executed
 * without having decided it. Best-effort and TOTAL: a read that fails or throws leaves the
 * movement without its values, and the motif then says they were not read — the notification
 * leaves either way, and never with a number nobody recorded.
 */
export async function completeS4Notification(n: S4Notification, read: DecidingCloseReader): Promise<S4Notification> {
  const movements = await Promise.all(
    n.movements.map(async (m): Promise<S4MovementFacts> => {
      if (m.deciding != null || m.decidingCloseMs == null) return m;
      if (m.reason !== 'sortie_s4' && m.reason !== 'rachat_s4') return m;
      try {
        return { ...m, deciding: await read(m.asset, m.reason === 'sortie_s4' ? 'exit' : 'rebuy', m.decidingCloseMs) };
      } catch (err) {
        console.warn(`[warn] s4 notification: deciding close of ${m.asset} not read (${err instanceof Error ? err.message : String(err)}) — best-effort.`);
        return m;
      }
    }),
  );
  return { ...n, movements };
}

const fmtUsd = (v: number): string => `${v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const ofAsset = (asset: string): string => ('AEIOU'.includes(asset[0] ?? '') ? `d'${asset}` : `de ${asset}`);

export function formatS4Activity(n: S4Notification): string {
  const time = (() => {
    const d = new Date(n.timestamp);
    return Number.isFinite(d.getTime()) ? `${String(d.getUTCHours()).padStart(2, '0')}h${String(d.getUTCMinutes()).padStart(2, '0')}` : '—';
  })();
  const lines: string[] = [`🤖 Crypto-Buddy · ${n.label} · ${time} UTC`, ''];
  for (const m of n.movements) lines.push(`${m.side === 'buy' ? 'Achat' : 'Vente'} ${fmtUsd(m.usd)} ${ofAsset(m.asset)}`);
  if (n.withheld.length > 0) {
    lines.push(`Coupe-circuit actif : ${n.withheld.length} ordre(s) non envoyé(s) — ${n.withheld.map((w) => `${w.side === 'buy' ? 'achat' : 'vente'} ${w.asset} ${fmtUsd(w.usd)}`).join(', ')}`);
  }
  if (n.movements.length > 0) {
    lines.push('');
    if (n.firstCycle) lines.push('Premier cycle du pilote : le portefeuille rejoint l\'état S4.');
    for (const m of n.movements) lines.push(formatS4Motif(m));
  }
  lines.push('');
  lines.push(`Allocation : ${formatAllocation(n.allocation)}`);
  lines.push(`Total : ${fmtUsd(n.totalUsd)}`);
  return lines.join('\n');
}
