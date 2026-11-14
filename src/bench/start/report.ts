import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Column, HorizonStats, StartRow, Summary } from './run.js';
import type { HorizonKey } from './study.js';
import { START_VARIANTS, VARIANT_LABEL, type StartVariant } from './variants.js';

/**
 * THE REPORT'S FIGURES AND TABLES — drawn from the study's own output, so that no number in
 * `docs/RAPPORT-DEMARRAGE-S4.md` is typed by hand: the tables are generated here
 * (`out/bench-start/tables.md`) and the charts are static SVG files (`docs/img/demarrage-s4/`).
 *
 * Static on purpose: the report is read on GitHub, where an image cannot carry a tooltip. Every
 * value a chart shows is therefore also in a table beside it, and every series is named by a
 * legend AND a label on the chart — three of the five hues sit under 3:1 on the light surface and
 * may not carry identity alone.
 */

const IMG_DIR = path.join('docs', 'img', 'demarrage-s4');
const OUT_DIR = path.join('out', 'bench-start');

// The palette: five categorical slots in their fixed order (validated: adjacent CVD ΔE ≥ 9.1,
// normal-vision ≥ 19.6 on this surface), the kept basket in the de-emphasis gray.
const SURFACE = '#fcfcfb';
const INK = '#0b0b0b';
const INK_2 = '#52514e';
const MUTED = '#898781';
const GRID = '#e1e0d9';
const AXIS = '#c3c2b7';
export const COLOR: Readonly<Record<Column, string>> = Object.freeze({ A: '#2a78d6', B: '#eb6834', Bp: '#1baf7a', C1: '#eda100', C2: '#e87ba4', hold: '#a3a29b' });
export const SHORT: Readonly<Record<Column, string>> = Object.freeze({ A: 'A', B: 'B', Bp: 'B\'', C1: 'C1', C2: 'C2', hold: 'Panier conservé' });
const LONG: Readonly<Record<Column, string>> = Object.freeze({ ...VARIANT_LABEL, hold: 'Panier conservé sans rien faire' });
const FONT = 'system-ui, -apple-system, \'Segoe UI\', sans-serif';
const DAY_MS = 86_400_000;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);

/** French figures: a real minus, a decimal comma. */
export function fr(v: number, digits = 1, signed = false): string {
  const abs = Math.abs(v).toFixed(digits).replace('.', ',');
  const zero = Number(Math.abs(v).toFixed(digits)) === 0;
  return `${zero ? '' : v < 0 ? '−' : signed ? '+' : ''}${abs}`;
}
export const pct = (v: number, digits = 1, signed = true): string => `${fr(v, digits, signed)} %`;

/** Round tick values covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

interface Frame { x: number; y: number; w: number; h: number }

function svgOpen(width: number, height: number, title: string, subtitle: string): string[] {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT}" role="img" aria-label="${esc(title)}">`,
    `<rect width="${width}" height="${height}" fill="${SURFACE}"/>`,
    `<text x="24" y="34" font-size="18" font-weight="600" fill="${INK}">${esc(title)}</text>`,
    `<text x="24" y="56" font-size="13" fill="${INK_2}">${esc(subtitle)}</text>`,
  ];
}

/** One key per series, wrapped onto as many rows as the width needs. Returns the rows used. */
function legend(columns: readonly Column[], x: number, y: number, maxWidth: number): { svg: string[]; rows: number } {
  const svg: string[] = [];
  let cx = x;
  let cy = y;
  let rows = 1;
  for (const c of columns) {
    const width = 24 + LONG[c].length * 6.6 + 24;
    if (cx > x && cx + width > x + maxWidth) {
      cx = x;
      cy += 20;
      rows += 1;
    }
    svg.push(`<line x1="${cx}" y1="${cy - 4}" x2="${cx + 18}" y2="${cy - 4}" stroke="${COLOR[c]}" stroke-width="${c === 'hold' ? 2 : 3}" stroke-linecap="round"/>`);
    svg.push(`<text x="${cx + 24}" y="${cy}" font-size="12" fill="${INK_2}">${esc(LONG[c])}</text>`);
    cx += width;
  }
  return { svg, rows };
}

function yAxis(f: Frame, ticks: readonly number[], scale: (v: number) => number, label: (v: number) => string, zero = true): string[] {
  const out: string[] = [];
  for (const t of ticks) {
    const y = n1(scale(t));
    out.push(`<line x1="${f.x}" y1="${y}" x2="${f.x + f.w}" y2="${y}" stroke="${zero && t === 0 ? AXIS : GRID}" stroke-width="1"/>`);
    out.push(`<text x="${f.x - 8}" y="${n1(scale(t) + 4)}" font-size="11" fill="${MUTED}" text-anchor="end" style="font-variant-numeric: tabular-nums">${esc(label(t))}</text>`);
  }
  return out;
}

function yearAxis(f: Frame, fromMs: number, toMs: number, scale: (ms: number) => number, caption: string, labels = true): string[] {
  const out: string[] = [`<line x1="${f.x}" y1="${f.y + f.h}" x2="${f.x + f.w}" y2="${f.y + f.h}" stroke="${AXIS}" stroke-width="1"/>`];
  for (let year = new Date(fromMs).getUTCFullYear(); year <= new Date(toMs).getUTCFullYear(); year += 1) {
    const ms = Date.UTC(year, 0, 1);
    if (ms < fromMs || ms > toMs) continue;
    const x = n1(scale(ms));
    out.push(`<line x1="${x}" y1="${f.y + f.h}" x2="${x}" y2="${f.y + f.h + 5}" stroke="${AXIS}" stroke-width="1"/>`);
    if (labels) out.push(`<text x="${x}" y="${f.y + f.h + 19}" font-size="11" fill="${MUTED}" text-anchor="middle">${year}</text>`);
  }
  if (caption) out.push(`<text x="${f.x + f.w / 2}" y="${f.y + f.h + 38}" font-size="12" fill="${INK_2}" text-anchor="middle">${esc(caption)}</text>`);
  return out;
}

const pathOf = (points: ReadonlyArray<[number, number]>): string => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n1(x)} ${n1(y)}`).join(' ');

/** End labels, pushed apart vertically when they would overlap, each tied to its line by a leader. */
function endLabels(items: Array<{ column: Column; x: number; y: number; text: string }>, f: Frame): string[] {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const placed: number[] = [];
  for (const [i, it] of sorted.entries()) placed[i] = Math.max(it.y, i === 0 ? f.y + 6 : placed[i - 1]! + 14);
  const overflow = placed.length > 0 ? Math.max(0, placed.at(-1)! - (f.y + f.h)) : 0;
  const out: string[] = [];
  for (const [i, it] of sorted.entries()) {
    const ly = placed[i]! - overflow;
    out.push(`<circle cx="${n1(it.x)}" cy="${n1(it.y)}" r="4" fill="${COLOR[it.column]}" stroke="${SURFACE}" stroke-width="2"/>`);
    out.push(`<line x1="${n1(it.x + 5)}" y1="${n1(it.y)}" x2="${n1(it.x + 14)}" y2="${n1(ly)}" stroke="${AXIS}" stroke-width="1"/>`);
    out.push(`<text x="${n1(it.x + 17)}" y="${n1(ly + 4)}" font-size="11" fill="${INK_2}">${esc(it.text)}</text>`);
  }
  return out;
}

// ── chart 1: the result by start date, one line per variant ──────────────────────────────

/**
 * A year after a start in late 2020 the capital was multiplied by eight; after most other starts it
 * moved by a few tens of percent. On a linear axis the first hides everything else. The axis is
 * therefore MULTIPLICATIVE (logarithmic in the capital): doubling and halving sit at the same
 * distance from zero, and every start is readable. Ticks are plain returns.
 */
const RETURN_TICKS = [-75, -50, -25, 0, 50, 100, 200, 400, 800, 1600];

function chartByStart(rows: readonly StartRow[], key: HorizonKey, title: string, subtitle: string): string {
  const W = 1040;
  const usable = rows.filter((r) => COLUMNS_ALL.every((c) => r.readings[c][key] != null));
  const t = usable.map((r) => Date.parse(r.start));
  const value = (r: StartRow, c: Column): number => r.readings[c][key]!.returnPercent;
  const all = usable.flatMap((r) => COLUMNS_ALL.map((c) => value(r, c)));
  const log = (v: number): number => Math.log(1 + v / 100);
  const [min, max] = [Math.min(...all), Math.max(...all)];
  const pad = (log(max) - log(min)) * 0.04;
  const [lo, hi] = [log(min) - pad, log(max) + pad];
  const ticks = RETURN_TICKS.filter((v) => v > -100 && log(v) >= lo && log(v) <= hi);
  const key1 = legend(COLUMNS_ALL, 24, 82, W - 48);
  const f: Frame = { x: 70, y: 82 + key1.rows * 20 + 6, w: W - 70 - 150, h: 360 };
  const out = svgOpen(W, f.y + f.h + 52, title, subtitle);
  const sx = (ms: number): number => f.x + ((ms - t[0]!) / (t.at(-1)! - t[0]!)) * f.w;
  const sy = (v: number): number => f.y + f.h - ((log(v) - lo) / (hi - lo)) * f.h;
  out.push(...key1.svg);
  out.push(...yAxis(f, ticks, sy, (v) => pct(v, 0)));
  out.push(...yearAxis(f, t[0]!, t.at(-1)!, sx, 'Date de départ'));
  // The kept basket first, behind: context, not a contender.
  for (const c of ['hold', ...START_VARIANTS] as Column[]) {
    out.push(`<path d="${pathOf(usable.map((r, i) => [sx(t[i]!), sy(value(r, c))]))}" fill="none" stroke="${COLOR[c]}" stroke-width="${c === 'hold' ? 1.5 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  const last = usable.at(-1)!;
  out.push(...endLabels(COLUMNS_ALL.map((c) => ({ column: c, x: sx(t.at(-1)!), y: sy(value(last, c)), text: `${SHORT[c]} ${pct(value(last, c), 0)}` })), f));
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

const COLUMNS_ALL: readonly Column[] = [...START_VARIANTS, 'hold'];

// ── chart 2: each variant against A, same start — small multiples around zero ─────────────

function chartGaps(rows: readonly StartRow[], key: HorizonKey, reference: StartVariant, title: string, subtitle: string): string {
  const others = START_VARIANTS.filter((v) => v !== reference);
  const W = 1040;
  const panelH = 120;
  const gap = 44;
  const top = 86;
  const H = top + others.length * (panelH + gap) + 30;
  const usable = rows.filter((r) => START_VARIANTS.every((c) => r.readings[c][key] != null));
  const t = usable.map((r) => Date.parse(r.start));
  const diff = (r: StartRow, c: Column): number => r.readings[c][key]!.returnPercent - r.readings[reference][key]!.returnPercent;
  const all = usable.flatMap((r) => others.map((c) => diff(r, c)));
  const bound = Math.max(Math.abs(Math.min(...all)), Math.abs(Math.max(...all)));
  const ticks = niceTicks(-bound, bound, 4);
  const [lo, hi] = [Math.min(ticks[0]!, -bound), Math.max(ticks.at(-1)!, bound)];
  const out = svgOpen(W, H, title, subtitle);
  others.forEach((c, i) => {
    const f: Frame = { x: 70, y: top + i * (panelH + gap) + 22, w: W - 70 - 40, h: panelH };
    const sx = (ms: number): number => f.x + ((ms - t[0]!) / (t.at(-1)! - t[0]!)) * f.w;
    const sy = (v: number): number => f.y + f.h - ((v - lo) / (hi - lo)) * f.h;
    const share = (test: (v: number) => boolean): string => fr((usable.filter((r) => test(diff(r, c))).length / usable.length) * 100, 0);
    const mean = usable.reduce((s, r) => s + diff(r, c), 0) / usable.length;
    out.push(`<line x1="${f.x}" y1="${f.y - 13}" x2="${f.x + 18}" y2="${f.y - 13}" stroke="${COLOR[c]}" stroke-width="3" stroke-linecap="round"/>`);
    out.push(`<text x="${f.x + 24}" y="${f.y - 9}" font-size="13" font-weight="600" fill="${INK}">${esc(`${LONG[c]}  moins  ${SHORT[reference]}`)}</text>`);
    out.push(`<text x="${f.x + f.w}" y="${f.y - 9}" font-size="12" fill="${INK_2}" text-anchor="end">${esc(`écart moyen ${fr(mean, 1, true)} pt · mieux que ${SHORT[reference]} : ${share((v) => v >= 0.05)} % des départs · pareil : ${share((v) => Math.abs(v) < 0.05)} % · moins bien : ${share((v) => v <= -0.05)} %`)}</text>`);
    out.push(...yAxis(f, ticks, sy, (v) => `${fr(v, 0, true)} pt`));
    const line = usable.map((r, k): [number, number] => [sx(t[k]!), sy(diff(r, c))]);
    out.push(`<path d="${pathOf(line)} L${n1(sx(t.at(-1)!))} ${n1(sy(0))} L${n1(sx(t[0]!))} ${n1(sy(0))} Z" fill="${COLOR[c]}" fill-opacity="0.12"/>`);
    out.push(`<path d="${pathOf(line)}" fill="none" stroke="${COLOR[c]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    out.push(...yearAxis(f, t[0]!, t.at(-1)!, sx, i === others.length - 1 ? 'Date de départ' : '', i === others.length - 1));
  });
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

// ── chart 3: the spread over the start dates — worst, typical range, median, best ─────────

function chartSpread(summary: Summary, title: string, subtitle: string): string {
  const keys: HorizonKey[] = ['91', '182', '365'];
  const names: Record<string, string> = { '91': 'À 3 mois', '182': 'À 6 mois', '365': 'À 12 mois' };
  const W = 1040;
  const rowH = 26;
  const panelH = COLUMNS_ALL.length * rowH;
  const top = 96;
  const gap = 78;
  const H = top + keys.length * (panelH + gap) + 6;
  const out = svgOpen(W, H, title, subtitle);
  // Key, drawn once: what the marks are.
  const kx = 24;
  const ky = 80;
  out.push(`<line x1="${kx}" y1="${ky - 4}" x2="${kx + 60}" y2="${ky - 4}" stroke="${AXIS}" stroke-width="1"/>`);
  out.push(`<rect x="${kx + 16}" y="${ky - 8}" width="28" height="8" rx="4" fill="${COLOR.A}"/>`);
  out.push(`<circle cx="${kx + 30}" cy="${ky - 4}" r="5" fill="${INK}" stroke="${SURFACE}" stroke-width="2"/>`);
  out.push(`<text x="${kx + 70}" y="${ky}" font-size="12" fill="${INK_2}">trait fin : du pire au meilleur départ · barre : 8 départs sur 10 · point : départ médian</text>`);
  keys.forEach((key, p) => {
    const stats = summary.weekly[key];
    const f: Frame = { x: 250, y: top + p * (panelH + gap) + 26, w: W - 250 - 90, h: panelH };
    const cols = COLUMNS_ALL.filter((c) => stats.columns[c]);
    const lo0 = Math.min(...cols.map((c) => stats.columns[c]!.return.min));
    const hi0 = Math.max(...cols.map((c) => stats.columns[c]!.return.max));
    const ticks = niceTicks(Math.min(0, lo0), hi0, 8);
    const [lo, hi] = [Math.min(ticks[0]!, lo0), Math.max(ticks.at(-1)!, hi0)];
    const sx = (v: number): number => f.x + ((v - lo) / (hi - lo)) * f.w;
    out.push(`<text x="24" y="${f.y - 10}" font-size="14" font-weight="600" fill="${INK}">${esc(`${names[key]} — ${stats.starts} départs`)}</text>`);
    for (const tick of ticks) {
      out.push(`<line x1="${n1(sx(tick))}" y1="${f.y}" x2="${n1(sx(tick))}" y2="${f.y + f.h}" stroke="${tick === 0 ? AXIS : GRID}" stroke-width="1"/>`);
      out.push(`<text x="${n1(sx(tick))}" y="${f.y + f.h + 16}" font-size="11" fill="${MUTED}" text-anchor="middle" style="font-variant-numeric: tabular-nums">${esc(pct(tick, 0))}</text>`);
    }
    cols.forEach((c, i) => {
      const d = stats.columns[c]!.return;
      const y = f.y + i * rowH + rowH / 2;
      out.push(`<text x="${f.x - 12}" y="${n1(y + 4)}" font-size="12" fill="${INK_2}" text-anchor="end">${esc(LONG[c])}</text>`);
      out.push(`<line x1="${n1(sx(d.min))}" y1="${n1(y)}" x2="${n1(sx(d.max))}" y2="${n1(y)}" stroke="${AXIS}" stroke-width="1"/>`);
      out.push(`<line x1="${n1(sx(d.min))}" y1="${n1(y - 4)}" x2="${n1(sx(d.min))}" y2="${n1(y + 4)}" stroke="${MUTED}" stroke-width="1"/>`);
      out.push(`<line x1="${n1(sx(d.max))}" y1="${n1(y - 4)}" x2="${n1(sx(d.max))}" y2="${n1(y + 4)}" stroke="${MUTED}" stroke-width="1"/>`);
      out.push(`<rect x="${n1(sx(d.p10))}" y="${n1(y - 4)}" width="${n1(Math.max(2, sx(d.p90) - sx(d.p10)))}" height="8" rx="4" fill="${COLOR[c]}"/>`);
      out.push(`<circle cx="${n1(sx(d.median))}" cy="${n1(y)}" r="5" fill="${INK}" stroke="${SURFACE}" stroke-width="2"/>`);
      out.push(`<text x="${f.x + f.w + 10}" y="${n1(y + 4)}" font-size="11" fill="${INK_2}" style="font-variant-numeric: tabular-nums">${esc(`méd. ${pct(d.median, 0)}`)}</text>`);
    });
  });
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

// ── chart 4: the pilot's own start, bar by bar ───────────────────────────────────────────

export interface PilotSeries {
  start: string;
  t: number[];
  equity: Record<Column, number[]>;
}

function chartPilot(p: PilotSeries, title: string, subtitle: string): string {
  const W = 1040;
  const key = legend(COLUMNS_ALL, 24, 82, W - 48);
  const f: Frame = { x: 70, y: 82 + key.rows * 20 + 6, w: W - 70 - 170, h: 290 };
  const H = f.y + f.h + 52;
  const all = COLUMNS_ALL.flatMap((c) => p.equity[c]);
  const ticks = niceTicks(Math.min(...all), Math.max(1000, ...all), 6);
  const [lo, hi] = [Math.min(ticks[0]!, Math.min(...all)), Math.max(ticks.at(-1)!, Math.max(...all))];
  const [t0, t1] = [p.t[0]!, p.t.at(-1)!];
  const sx = (ms: number): number => f.x + ((ms - t0) / (t1 - t0)) * f.w;
  const sy = (v: number): number => f.y + f.h - ((v - lo) / (hi - lo)) * f.h;
  const out = svgOpen(W, H, title, subtitle);
  out.push(...key.svg);
  out.push(...yAxis(f, ticks, sy, (v) => `${fr(v, 0)} $`, false));
  out.push(`<line x1="${f.x}" y1="${f.y + f.h}" x2="${f.x + f.w}" y2="${f.y + f.h}" stroke="${AXIS}" stroke-width="1"/>`);
  for (let d = Math.ceil(t0 / DAY_MS) * DAY_MS; d <= t1; d += DAY_MS) {
    const x = n1(sx(d));
    const date = new Date(d);
    out.push(`<line x1="${x}" y1="${f.y + f.h}" x2="${x}" y2="${f.y + f.h + 5}" stroke="${AXIS}" stroke-width="1"/>`);
    out.push(`<text x="${x}" y="${f.y + f.h + 19}" font-size="11" fill="${MUTED}" text-anchor="middle">${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}</text>`);
  }
  out.push(`<text x="${f.x + f.w / 2}" y="${f.y + f.h + 38}" font-size="12" fill="${INK_2}" text-anchor="middle">Clôtures 4h, novembre 2026 (UTC)</text>`);
  for (const c of ['hold', ...START_VARIANTS] as Column[]) {
    out.push(`<path d="${pathOf(p.t.map((ms, i) => [sx(ms), sy(p.equity[c][i]!)]))}" fill="none" stroke="${COLOR[c]}" stroke-width="${c === 'hold' ? 1.5 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  out.push(...endLabels(COLUMNS_ALL.map((c) => ({ column: c, x: sx(t1), y: sy(p.equity[c].at(-1)!), text: `${SHORT[c]} ${fr(p.equity[c].at(-1)!, 0)} $` })), f));
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

// ── tables ───────────────────────────────────────────────────────────────────────────────

const HORIZON_NAME: Record<HorizonKey, string> = { '91': '3 mois', '182': '6 mois', '365': '12 mois', end: 'fin des données' };
const table = (head: string[], rows: string[][]): string =>
  [`| ${head.join(' | ')} |`, `|${head.map((_, i) => (i === 0 ? '---' : '---:')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const frDay = (iso: string | null): string => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

function statsTable(stats: HorizonStats): string {
  return table(
    ['Démarrage', 'Moyenne', 'Médiane', 'Pire départ', 'Meilleur départ', '8 départs sur 10 entre', 'Pire chute (moyenne / maximum)', 'Temps en marché'],
    COLUMNS_ALL.filter((c) => stats.columns[c]).map((c) => {
      const s = stats.columns[c]!;
      return [
        LONG[c],
        pct(s.return.mean),
        pct(s.return.median),
        `${pct(s.return.min)} (${frDay(s.return.minAt)})`,
        `${pct(s.return.max)} (${frDay(s.return.maxAt)})`,
        `${pct(s.return.p10)} et ${pct(s.return.p90)}`,
        `${pct(-s.maxDrawdown.mean)} / ${pct(-s.maxDrawdown.max)}`,
        pct(s.timeInMarketMean, 0, false),
      ];
    }),
  );
}

function gapTable(stats: HorizonStats, reference: Column): string {
  const g = stats.gaps[reference] ?? {};
  return table(
    [`Écart avec ${SHORT[reference]}, même date`, 'Moyen', 'Médian', 'Pire', 'Meilleur', `Mieux / pareil / moins bien que ${SHORT[reference]}`],
    COLUMNS_ALL.filter((c) => g[c]).map((c) => {
      const d = g[c]!;
      return [LONG[c], `${fr(d.mean, 1, true)} pt`, `${fr(d.median, 1, true)} pt`, `${fr(d.min, 1, true)} pt (${frDay(d.minAt)})`, `${fr(d.max, 1, true)} pt (${frDay(d.maxAt)})`, `${fr(d.winsPercent, 0)} % / ${fr(d.tiesPercent, 0)} % / ${fr(d.lossesPercent, 0)} %`];
    }),
  );
}

function groupTable(groups: Record<string, HorizonStats>, first: string): string {
  return table(
    [first, 'Départs', ...COLUMNS_ALL.map((c) => `${SHORT[c]} (médiane / pire)`)],
    Object.entries(groups).filter(([, s]) => s.starts > 0).map(([name, s]) => [name, String(s.starts), ...COLUMNS_ALL.map((c) => (s.columns[c] ? `${pct(s.columns[c]!.return.median, 0)} / ${pct(s.columns[c]!.return.min, 0)}` : '—'))]),
  );
}

export function tablesMarkdown(summary: Summary): string {
  const parts: string[] = [`<!-- Généré par \`npm run bench:start\` — données jusqu'au ${summary.asOf}. Ne pas modifier à la main. -->`];
  for (const key of ['91', '182', '365', 'end'] as HorizonKey[]) {
    const s = summary.weekly[key];
    parts.push(`### Grille hebdomadaire — ${HORIZON_NAME[key]} (${s.starts} départs)`, statsTable(s), gapTable(s, 'A'), gapTable(s, 'B'));
  }
  parts.push(`### Contrôle quotidien — 12 mois (${summary.daily365.starts} départs)`, statsTable(summary.daily365), gapTable(summary.daily365, 'A'));
  parts.push('### 3 mois, selon le marché au départ', groupTable(summary.weeklyByMarket['91'], 'Marché au départ'));
  parts.push('### 12 mois, selon le marché au départ', groupTable(summary.weeklyByMarket['365'], 'Marché au départ'));
  parts.push(
    '### Sensibilité au décalage du départ (résultat à 12 mois)',
    table(
      ['Démarrage', 'Un jour plus tard : écart médian', '9 fois sur 10 sous', 'Maximum', 'Une semaine plus tard : écart médian', '9 fois sur 10 sous', 'Maximum'],
      COLUMNS_ALL.filter((c) => summary.neighbours.daily[c] && summary.neighbours.weekly[c]).map((c) => {
        const [d, w] = [summary.neighbours.daily[c]!, summary.neighbours.weekly[c]!];
        return [LONG[c], `${fr(d.medianAbsPoints, 1)} pt`, `${fr(d.p90AbsPoints, 1)} pt`, `${fr(d.maxAbsPoints, 1)} pt (${frDay(d.maxAt)})`, `${fr(w.medianAbsPoints, 1)} pt`, `${fr(w.p90AbsPoints, 1)} pt`, `${fr(w.maxAbsPoints, 1)} pt (${frDay(w.maxAt)})`];
      }),
    ),
    `Départs hebdomadaires où la porte de transition retient au moins une ligne à la première décision : ${fr(summary.gatedStartsPercent, 0)} %.`,
  );
  parts.push('### 12 mois, selon l\'année du départ', groupTable(summary.weeklyByYear, 'Année'));
  if (summary.pilot) {
    const p = summary.pilot;
    parts.push(
      `### Départ du 06/11/2026 (${fr(p.days, 1)} jours de données)`,
      table(
        ['Démarrage', 'Capital le 14/11 à 04:00 UTC', 'Capital à la fin des données', 'Rendement', 'Pire chute', 'Temps en marché'],
        COLUMNS_ALL.map((c) => [LONG[c], p.equityAtProductionReading ? `${fr(p.equityAtProductionReading[c], 2)} $` : '—', `${fr(p.readings[c].equityUsd, 2)} $`, pct(p.readings[c].returnPercent, 2), pct(-p.readings[c].maxDrawdownPercent, 2), pct(p.readings[c].timeInMarketPercent, 0, false)]),
      ),
      `Production réelle : ${fr(p.productionObserved.startEquityUsd, 2)} $ au départ, ${fr(p.productionObserved.equityUsd, 2)} $ le 14/11 à 04:05 UTC, soit ${pct(p.productionObserved.returnPercent, 1)} — ${fr(1000 * (1 + p.productionObserved.returnPercent / 100), 0)} $ pour 1 000 $.`,
    );
  }
  parts.push(
    '### Fidélité',
    table(
      ['Origine d\'une trajectoire continue', 'Rejoint pour de bon l\'état de celle de 2020 le', 'Soit, après son origine'],
      summary.fidelity.originConvergence.map((c) => [frDay(c.origin), frDay(c.convergedAt), c.monthsAfterOrigin == null ? '—' : `${fr(c.monthsAfterOrigin, 1)} mois`]),
    ),
    table(
      ['B contre la trajectoire continue elle-même', 'Départs', 'Écart moyen', 'Écart maximal'],
      (['91', '182', '365', 'end'] as HorizonKey[]).filter((k) => summary.bVersusSlice[k]).map((k) => [HORIZON_NAME[k], String(summary.bVersusSlice[k]!.starts), `${fr(summary.bVersusSlice[k]!.meanGapPoints, 2, true)} pt`, `${fr(summary.bVersusSlice[k]!.maxAbsGapPoints, 2)} pt`]),
    ),
  );
  return `${parts.join('\n\n')}\n`;
}

/** Writes the charts and the tables; returns the files written. */
export function writeReportAssets(summary: Summary, weekly: readonly StartRow[], pilot: PilotSeries | null = null, rootDir = process.cwd()): string[] {
  const img = path.resolve(rootDir, IMG_DIR);
  mkdirSync(img, { recursive: true });
  const n = summary.weekly['365'].starts;
  const files: Array<[string, string]> = [
    [path.join(IMG_DIR, 'rendement-12-mois.svg'), chartByStart(weekly, '365', 'Résultat de S4 à 12 mois, selon la date de départ', `Rendement net 12 mois après le départ, frais compris. Un départ par semaine (${n} départs), une courbe par façon de démarrer. Échelle multiplicative.`)],
    [path.join(IMG_DIR, 'rendement-3-mois.svg'), chartByStart(weekly, '91', 'Résultat de S4 à 3 mois, selon la date de départ', `Rendement net 3 mois après le départ, frais compris. Un départ par semaine (${summary.weekly['91'].starts} départs). Échelle multiplicative.`)],
    [path.join(IMG_DIR, 'ecart-12-mois.svg'), chartGaps(weekly, '365', 'A', 'Ce que change la façon de démarrer, à date égale (12 mois)', 'Rendement à 12 mois de chaque démarrage moins celui de A, pour un départ le même jour. Au-dessus de zéro : il a fait mieux que A.')],
    [path.join(IMG_DIR, 'ecart-3-mois.svg'), chartGaps(weekly, '91', 'A', 'Ce que change la façon de démarrer, à date égale (3 mois)', 'Rendement à 3 mois de chaque démarrage moins celui de A, pour un départ le même jour. Au-dessus de zéro : il a fait mieux que A.')],
    [path.join(IMG_DIR, 'dispersion.svg'), chartSpread(summary, 'Dispersion du résultat selon la date de départ', 'Rendement net, frais compris. La longueur de chaque trait est ce que la seule date de départ fait varier.')],
  ];
  if (pilot) files.push([path.join(IMG_DIR, 'depart-06-11.svg'), chartPilot(pilot, 'Un départ le 06/11/2026, selon la façon de démarrer', '1 000 $ de cash le 06/11 à 08:00 UTC, premiers achats à 12:00 UTC. Capital à chaque clôture 4h, frais compris.')]);
  for (const [file, text] of files) writeFileSync(path.resolve(rootDir, file), text);
  mkdirSync(path.resolve(rootDir, OUT_DIR), { recursive: true });
  writeFileSync(path.resolve(rootDir, OUT_DIR, 'tables.md'), tablesMarkdown(summary));
  return [...files.map(([f]) => f.replace(/\\/g, '/')), `${OUT_DIR.replace(/\\/g, '/')}/tables.md`];
}
