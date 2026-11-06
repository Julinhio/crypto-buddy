import type { ExitRule, HoldingView } from '../exposure/engine.js';
import type { DailyRow, DailyTable } from './daily.js';
import { EXIT_PARAMETERS } from './parameters.js';

/**
 * THE CANDIDATE RULES S1 TO S5, AND E0 — protocol `docs/PROTOCOLE-SORTIE-v0.3.md`, §7, §8, §15.
 *
 * Each rule is a daily state machine the engine feeds one daily close at a time (see `ExitRule`
 * in `engine.ts`). A rule only says which assets are OUT; the engine does the rest — a line held
 * out is excluded whatever its gate says and goes to zero, its share stays in cash, a line held
 * in obeys the gate. The rules never see a 4h bar, a regime, a weight or a price other than the
 * daily closes of `daily.ts`.
 *
 *   E0  no exit at all; with the engine's stop disabled, that is "100 % without any stop".
 *   S1  an asset is in while its close is above its 200-day mean, out otherwise.
 *   S2  S1 with hysteresis: out under 97 % of the mean, back in only above 103 %.
 *   S3  out when the close is 20 % or more under the highest daily close observed since the entry
 *       was FILLED; back in when the close re-crosses above the 50-day mean.
 *   S4  S3, and no rebuy before 10 days out of the market.
 *   S5  the synthetic index with S2's hysteresis, all four assets out or in together.
 *
 * ── STATES BEFORE THE WINDOW (§15) ─────────────────────────────────────────────────────
 *
 * S1, S2 and S5 depend on closes only, so their state is walked from the first close at which
 * their mean exists — long before the window opens — and read at each close: the state at the
 * first decision is the one the history implies, not a choice. A hysteresis walk needs a first
 * state; it is S1's (in iff the close is above the mean), on that first close.
 *
 * S3 and S4 depend on a filled entry, which only exists inside the run: they start IN, and their
 * trailing high starts with the first daily close after the entry is filled.
 */

const DAY_MS = 86_400_000;

export type CandidateName = 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
export type ExitRuleName = 'E0' | CandidateName;
export const CANDIDATES: readonly CandidateName[] = Object.freeze(['S1', 'S2', 'S3', 'S4', 'S5']);

function rowAt(table: DailyTable, closeMs: number): DailyRow {
  const i = table.rowByClose.get(closeMs);
  if (i == null) throw new Error(`exit rule: no daily close at ${new Date(closeMs).toISOString()}`);
  return table.rows[i]!;
}

function longMean(row: DailyRow, asset: string): number {
  const m = row.sma200[asset];
  if (m == null) throw new Error(`exit rule: ${asset} has no 200-day mean at ${new Date(row.closeMs).toISOString()}`);
  return m;
}

/**
 * The hysteresis walk of S2 (one series per asset) and S5 (the index), from the first close with a
 * mean. `in` at close `d` means "in after reading close `d`".
 */
export function hysteresisStates(
  rows: readonly DailyRow[],
  read: (row: DailyRow) => { close: number; mean: number | null },
): Map<number, boolean> {
  const out = new Map<number, boolean>();
  let state: boolean | null = null;
  for (const row of rows) {
    const { close, mean } = read(row);
    if (mean == null) continue;
    if (state == null) state = close > mean;
    else if (state && close < EXIT_PARAMETERS.hysteresisExitRatio * mean) state = false;
    else if (!state && close > EXIT_PARAMETERS.hysteresisEntryRatio * mean) state = true;
    out.set(row.closeMs, state);
  }
  return out;
}

class PureRule implements ExitRule {
  out: ReadonlySet<string> = new Set();
  constructor(readonly name: ExitRuleName, private readonly outAt: (closeMs: number) => ReadonlySet<string>) {}
  onDailyClose({ closeMs }: { closeMs: number }): void {
    this.out = this.outAt(closeMs);
  }
}

interface TrailingLine {
  status: 'in' | 'out';
  /** The entry the trailing high belongs to; a new entry resets it. */
  entryAtMs: number | null;
  /** Highest daily close observed after `entryAtMs`. */
  high: number | null;
  /** The daily close that decided the exit. */
  exitAtMs: number | null;
  /** A close at or under the 50-day mean has been seen since the exit: a re-crossing can now happen. */
  armed: boolean;
}

/**
 * S3 and S4. "Repasse au-dessus" is a RE-crossing (§15): after the exit, the rebuy needs a close at
 * or under the 50-day mean, then a later close strictly above it. An exit taken while the close is
 * still above its mean therefore waits for the market to dip under it first, instead of buying the
 * line back at the next close.
 */
class TrailingRule implements ExitRule {
  private readonly lines: Record<string, TrailingLine>;
  out: ReadonlySet<string> = new Set();
  constructor(
    readonly name: 'S3' | 'S4',
    private readonly table: DailyTable,
    private readonly minDaysOut: number,
  ) {
    this.lines = Object.fromEntries(
      table.assets.map((a) => [a, { status: 'in', entryAtMs: null, high: null, exitAtMs: null, armed: false } satisfies TrailingLine]),
    );
  }

  onDailyClose({ closeMs, holdings }: { closeMs: number; holdings: Readonly<Record<string, HoldingView>> }): void {
    const row = rowAt(this.table, closeMs);
    const stop = 1 - EXIT_PARAMETERS.trailingStopPercent / 100;
    for (const asset of this.table.assets) {
      const line = this.lines[asset]!;
      const close = row.close[asset]!;
      const mean = row.sma50[asset];
      if (mean == null) throw new Error(`exit rule ${this.name}: ${asset} has no 50-day mean at ${new Date(closeMs).toISOString()}`);
      if (line.status === 'in') {
        const h = holdings[asset];
        if (!h?.held) continue;
        if (h.entryAtMs == null) throw new Error(`exit rule ${this.name}: ${asset} is held with no entry on record`);
        if (line.entryAtMs !== h.entryAtMs) {
          line.entryAtMs = h.entryAtMs;
          line.high = null;
        }
        // Closes observed AFTER the fill. A close at the very instant of the fill is the decision
        // close that caused it, not an observation of the position.
        if (closeMs <= h.entryAtMs) continue;
        line.high = line.high == null ? close : Math.max(line.high, close);
        if (close <= line.high * stop) {
          line.status = 'out';
          line.exitAtMs = closeMs;
          line.armed = close <= mean;
          line.entryAtMs = null;
          line.high = null;
        }
        continue;
      }
      if (closeMs <= line.exitAtMs!) continue;
      const waited = closeMs - line.exitAtMs! >= this.minDaysOut * DAY_MS;
      if (line.armed && close > mean && waited) {
        line.status = 'in';
        line.exitAtMs = null;
        line.armed = false;
      } else if (close <= mean) {
        line.armed = true;
      }
    }
    this.out = new Set(this.table.assets.filter((a) => this.lines[a]!.status === 'out'));
  }
}

/** A fresh rule for one run. Stateful rules must never be shared between two runs. */
export function makeExitRule(name: ExitRuleName, table: DailyTable): ExitRule {
  const none: ReadonlySet<string> = new Set();
  switch (name) {
    case 'E0':
      return new PureRule('E0', () => none);
    case 'S1':
      return new PureRule('S1', (closeMs) => {
        const row = rowAt(table, closeMs);
        return new Set(table.assets.filter((a) => !(row.close[a]! > longMean(row, a))));
      });
    case 'S2': {
      const walks = Object.fromEntries(
        table.assets.map((a) => [a, hysteresisStates(table.rows, (r) => ({ close: r.close[a]!, mean: r.sma200[a] ?? null }))]),
      );
      return new PureRule('S2', (closeMs) => {
        rowAt(table, closeMs);
        return new Set(table.assets.filter((a) => {
          const state = walks[a]!.get(closeMs);
          if (state == null) throw new Error(`exit rule S2: ${a} has no state at ${new Date(closeMs).toISOString()}`);
          return !state;
        }));
      });
    }
    case 'S3':
      return new TrailingRule('S3', table, 0);
    case 'S4':
      return new TrailingRule('S4', table, EXIT_PARAMETERS.minDaysOut);
    case 'S5': {
      const walk = hysteresisStates(table.rows, (r) => ({ close: r.index, mean: r.indexSma200 }));
      const all: ReadonlySet<string> = new Set(table.assets);
      return new PureRule('S5', (closeMs) => {
        rowAt(table, closeMs);
        const state = walk.get(closeMs);
        if (state == null) throw new Error(`exit rule S5: no index state at ${new Date(closeMs).toISOString()}`);
        return state ? none : all;
      });
    }
  }
}
