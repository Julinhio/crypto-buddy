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
 * dashboard PR #9). The "why" is the model's concise notification_summary; the
 * resulting allocation + total come from the POST-trade book (portfolioAfter).
 */
import type { DecideResult } from '../decision/decide.js';

export interface ActivityMovement {
  asset: string;
  side: 'buy' | 'sell';
  /** Dollars moved (|quoteDelta|, fee-inclusive cash impact), rounded for display. */
  usd: number;
}

export interface ActivityAllocationSlice {
  /** Asset ticker, or 'cash' for the reserve stable. */
  label: string;
  /** Percent of equity. */
  weight: number;
}

export interface ActivityNotification {
  /** ISO timestamp of the wake-up (DB now()), for the header time. */
  timestamp: string;
  /** What actually moved this cycle, biggest first. */
  movements: ActivityMovement[];
  /** The model's concise notification_summary (the "why"). */
  why: string;
  /** Resulting allocation (open positions + cash), biggest first. */
  allocation: ActivityAllocationSlice[];
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

  // Resulting allocation: open positions (weight %), biggest first, then cash.
  const allocation: ActivityAllocationSlice[] = [];
  const equityPositive = after.equity.gt(0);
  for (const p of after.positions) {
    const weight = equityPositive ? p.value.div(after.equity).times(100).toNumber() : 0;
    if (weight > 0) allocation.push({ label: p.asset, weight });
  }
  allocation.push({
    label: 'cash',
    weight: equityPositive ? after.cash.div(after.equity).times(100).toNumber() : 0,
  });

  return {
    timestamp,
    movements,
    why: (result.row.notification_summary ?? '').trim(),
    allocation,
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

const fmtPct = (n: number): string => `${Math.round(n)}%`;
const fmtUsd = (n: number): string => `~${Math.round(n)}$`;

/** Composes the activity Telegram text — PURE, matching the validated mockup. */
export function formatActivity(n: ActivityNotification): string {
  const lines: string[] = [`🤖 Crypto-Buddy a bougé · ${formatTime(n.timestamp)}`, ''];
  for (const m of n.movements) {
    lines.push(`${m.side === 'buy' ? 'Achat' : 'Vente'} ${fmtUsd(m.usd)} ${ofAsset(m.asset)}`);
  }
  lines.push('');
  if (n.why) lines.push(`Pourquoi : ${truncate(n.why, 300)}`, '');
  lines.push(`Alloc : ${n.allocation.map((a) => `${fmtPct(a.weight)} ${a.label}`).join(' · ')}`);
  lines.push(`Total : ${fmtUsd(n.totalUsd)}`);
  return lines.join('\n');
}
