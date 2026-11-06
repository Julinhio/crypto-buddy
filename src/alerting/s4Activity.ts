import type { VirtualPortfolio } from '../portfolio/derive.js';
import type { S4Line, S4MoveReason } from '../s4/core.js';
import { S4_TRAILING_STOP_PERCENT } from '../s4/core.js';
import type { S4Report } from '../s4/cycle.js';
import { formatAllocation, orderedAllocation, type AllocationSlice } from './allocation.js';

/**
 * THE S4 MOVEMENT NOTIFICATION — facts first, prose second.
 *
 * The cycle has already decided, booked and sent its orders when this is prepared: it reads the
 * cycle's report and nothing else. The explanation is produced in `beat.ts`, AFTER the cycle and
 * outside its timeout, by `explainS4` (the model, when it answers) or by `fallbackExplanation`
 * (the code, always). Nothing here can delay or change a movement.
 */

export interface S4MovementFacts {
  asset: string;
  side: 'buy' | 'sell';
  usd: number;
  reason: S4MoveReason;
  status: 'in' | 'out';
  /** The daily close S4 last read for this asset, and its 50-day mean. */
  close: number | null;
  sma50: number | null;
  /** In market: the high since entry and the exit threshold under it. */
  high: number | null;
  exitThreshold: number | null;
  entryDate: string | null;
  /** Out of market: the exit close and the days spent out. */
  exitDate: string | null;
  daysOut: number | null;
  armed: boolean;
  targetPercent: number | null;
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

const DAY_MS = 86_400_000;
const day = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));

/** Null when nothing moved and nothing was withheld: no message, and no model call. */
export function prepareS4Notification(report: S4Report, after: VirtualPortfolio | null, timestamp: string): S4Notification | null {
  if (report.movements.length === 0 && report.withheld.length === 0) return null;
  if (after == null) return null;
  const lineOf = new Map<string, S4Line>(report.lines.map((l) => [l.asset, l]));
  const lastEvent = new Map<string, { close: number; sma50: number; closeMs: number }>();
  for (const e of report.events) lastEvent.set(e.asset, { close: e.close, sma50: e.sma50, closeMs: e.closeMs });
  const targetOf = new Map(report.plan.map((p) => [p.asset, p.targetPercent]));
  const stop = 1 - S4_TRAILING_STOP_PERCENT / 100;
  const movements: S4MovementFacts[] = report.movements.map((m) => {
    const line = lineOf.get(m.asset);
    const ev = lastEvent.get(m.asset) ?? null;
    const atMs = ev?.closeMs ?? null;
    return {
      asset: m.asset,
      side: m.side,
      usd: m.usd,
      reason: m.reason,
      status: line?.status ?? 'in',
      close: ev?.close ?? null,
      sma50: ev?.sma50 ?? null,
      high: line?.status === 'in' ? line.high : null,
      exitThreshold: line?.status === 'in' && line.high != null ? line.high * stop : null,
      entryDate: line?.status === 'in' ? day(line.entryAtMs) : null,
      exitDate: line?.status === 'out' ? day(line.exitAtMs) : null,
      daysOut: line?.status === 'out' && line.exitAtMs != null && atMs != null ? Math.floor((atMs - line.exitAtMs) / DAY_MS) : null,
      armed: line?.armed ?? false,
      targetPercent: targetOf.get(m.asset) ?? null,
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

const fmtUsd = (v: number): string => `${v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const fmtPrice = (v: number): string => v.toLocaleString('fr-FR', { maximumFractionDigits: v >= 100 ? 0 : 4 });
const ofAsset = (asset: string): string => ('AEIOU'.includes(asset[0] ?? '') ? `d'${asset}` : `de ${asset}`);

/** The explanation the CODE writes — sent whenever the model does not answer in time. */
export function fallbackExplanation(n: S4Notification): string {
  const parts = n.movements.map((m) => {
    switch (m.reason) {
      case 'transition_initiale':
        return m.status === 'out'
          ? `${m.asset} est hors marché pour S4 depuis le ${m.exitDate} : sa part reste en cash`
          : `${m.asset} est en marché pour S4 (plus-haut ${m.high != null ? fmtPrice(m.high) : '—'}, sortie sous ${m.exitThreshold != null ? fmtPrice(m.exitThreshold) : '—'}) : la ligne rejoint sa cible de ${m.targetPercent?.toFixed(1) ?? '—'} %`;
      case 'sortie_s4':
        return `${m.asset} a clôturé à ${m.close != null ? fmtPrice(m.close) : '—'}, au moins ${S4_TRAILING_STOP_PERCENT} % sous son plus-haut depuis l'entrée : S4 sort entièrement la ligne, sa part reste en cash`;
      case 'rachat_s4':
        return `${m.asset} est resté au moins 10 jours hors marché puis a reclôturé au-dessus de sa moyenne 50 jours (${m.close != null ? fmtPrice(m.close) : '—'} contre ${m.sma50 != null ? fmtPrice(m.sma50) : '—'}) : S4 le rachète`;
      default:
        return `${m.asset} est ramené vers sa cible de ${m.targetPercent?.toFixed(1) ?? '—'} % après une dérive de plus de 2 %`;
    }
  });
  return `${parts.join('. ')}.`;
}

export function formatS4Activity(n: S4Notification, explanation: string): string {
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
    lines.push(explanation.trim());
  }
  lines.push('');
  lines.push(`Allocation : ${formatAllocation(n.allocation)}`);
  lines.push(`Total : ${fmtUsd(n.totalUsd)}`);
  return lines.join('\n');
}
