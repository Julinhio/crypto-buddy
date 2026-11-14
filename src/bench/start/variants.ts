import type { DailyTable } from '../exit/daily.js';
import { EXIT_PARAMETERS } from '../exit/parameters.js';
import { stepTrailingLine, type TrailingLine } from '../exit/rules.js';
import type { ExitRule, HoldingView } from '../exposure/engine.js';

/**
 * HOW S4 IS STARTED — five ways, and one rule object that can begin in any of them.
 *
 * The bench's own S4 (`makeExitRule('S4')`) has exactly one start: every line in the market, no
 * history. To start it otherwise the rule's memory must be SEEDED, and the bench has no door for
 * that (its `TrailingRule` builds its lines itself; the engine refuses to resume a carried state
 * alongside a rule). `SeededTrailingRule` is that door, added beside the bench without touching
 * it: it holds the seeded lines and runs each daily close through the bench's own
 * `stepTrailingLine`, unchanged. Seeded like the bench it IS the bench — proven bar for bar in
 * `test/benchStart.ts` — so any difference between two variants comes from the seed alone.
 *
 * ── THE FIVE STARTS, at a start instant whose first daily close read is `firstCloseMs` ──
 *
 *   A   in position      every line in, no entry, no high: the bench's native start. The line is
 *                        bought at the next open; its high starts at the first daily close AFTER
 *                        that fill (not at the fill price — the bench's rule, kept as it is).
 *   B   continuous       the line states S4 would hold that day had it run without interruption
 *                        since 2020-10-01: in or out, and for a line in, the entry and the HIGH of
 *                        that trajectory. What production did on 06/11/2026.
 *   B'  continuous,      the same in/out states, but a line in restarts its high from its own
 *       from cash        fill. What production's code does today when it starts from cash:
 *                        `reconcileEntries` clears the entry and the high of a line it does not
 *                        hold. (On 06/11 the book held ~5 % of each asset, which is the only
 *                        reason the inherited highs survived.)
 *   C1  out, armed       every line out and armed, its exit dated `minDaysOut` days before the
 *                        first close: the 10-day wait is already served, so a line enters at the
 *                        first close above its 50-day mean — at once if it is above it. This is
 *                        S4's rebuy condition applied to the first entry.
 *   C2  out, armed,      every line out and armed, its exit dated AT the first close: no entry
 *       waiting          before 10 days, then the same condition.
 *
 * No new parameter anywhere: the two numbers above are S4's own (`EXIT_PARAMETERS`).
 *
 * ── B's INHERITED ENTRY ────────────────────────────────────────────────────────────────
 *
 * The rule resets a line's high when the fill it sees is not the entry it remembers. A B start
 * buys at the start, so the engine reports a NEW fill for a line whose entry is months old. In
 * production the inherited entry survived because the line was already held; here the same thing
 * is said explicitly: until an inherited line first leaves the market, the rule is shown the line
 * as held since its inherited entry. Its state then walks exactly as the continuous trajectory's
 * does — checked against that trajectory in the tests, and against the state production was
 * really seeded with on 06/11.
 */

const DAY_MS = 86_400_000;

export type StartVariant = 'A' | 'B' | 'Bp' | 'C1' | 'C2';
export const START_VARIANTS: readonly StartVariant[] = Object.freeze(['A', 'B', 'Bp', 'C1', 'C2']);

export const VARIANT_LABEL: Readonly<Record<StartVariant, string>> = Object.freeze({
  A: 'A · en position',
  B: 'B · trajectoire continue',
  Bp: 'B\' · continue, depuis du cash',
  C1: 'C1 · hors marché armé, sans attente',
  C2: 'C2 · hors marché armé, 10 jours',
});

export type SeedLines = Record<string, TrailingLine>;

export interface StartSeed {
  lines: SeedLines;
  /** B only: the lines whose inherited entry the rule keeps seeing until they first exit. */
  inherit: readonly string[];
}

const fresh = (): TrailingLine => ({ status: 'in', entryAtMs: null, high: null, exitAtMs: null, armed: false });
export const cloneLines = (lines: Readonly<SeedLines>): SeedLines =>
  Object.fromEntries(Object.entries(lines).map(([a, l]) => [a, { ...l }]));

/**
 * The seed of one variant. `continuous` is the continuous trajectory's lines just BEFORE the first
 * daily close the start will read (B and B' only) — the start then reads that close itself, as the
 * continuous trajectory does.
 */
export function seedOf(variant: StartVariant, assets: readonly string[], firstCloseMs: number, continuous: Readonly<SeedLines> | null): StartSeed {
  switch (variant) {
    case 'A':
      return { lines: Object.fromEntries(assets.map((a) => [a, fresh()])), inherit: [] };
    case 'B': {
      if (!continuous) throw new Error('start variants: B needs the continuous trajectory\'s lines');
      const lines = cloneLines(continuous);
      return { lines, inherit: assets.filter((a) => lines[a]!.status === 'in' && lines[a]!.entryAtMs != null) };
    }
    case 'Bp': {
      if (!continuous) throw new Error('start variants: B\' needs the continuous trajectory\'s lines');
      const lines = cloneLines(continuous);
      // What `reconcileEntries` does to a line in the market that the book does not hold.
      for (const a of assets) if (lines[a]!.status === 'in') lines[a] = fresh();
      return { lines, inherit: [] };
    }
    case 'C1':
    case 'C2': {
      const exitAtMs = variant === 'C1' ? firstCloseMs - EXIT_PARAMETERS.minDaysOut * DAY_MS : firstCloseMs;
      return { lines: Object.fromEntries(assets.map((a) => [a, { status: 'out', entryAtMs: null, high: null, exitAtMs, armed: true } satisfies TrailingLine])), inherit: [] };
    }
  }
}

/** S4, started from a seed. See the file header. */
export class SeededTrailingRule implements ExitRule {
  readonly name = 'S4';
  out: ReadonlySet<string>;
  readonly lines: SeedLines;
  /** Inherited entries still shown to the rule (B). Dropped for good at the line's first exit. */
  private readonly inherited = new Map<string, number>();

  constructor(
    private readonly table: DailyTable,
    seed: StartSeed,
    /** Called after each daily close with the lines as they stand — used to record a trajectory. */
    private readonly onClose?: (closeMs: number, lines: Readonly<SeedLines>) => void,
  ) {
    this.lines = cloneLines(seed.lines);
    for (const asset of table.assets) if (!this.lines[asset]) throw new Error(`seeded rule: no seed for ${asset}`);
    for (const asset of seed.inherit) {
      const entry = this.lines[asset]!.entryAtMs;
      if (this.lines[asset]!.status !== 'in' || entry == null) throw new Error(`seeded rule: ${asset} has no entry to inherit`);
      this.inherited.set(asset, entry);
    }
    this.out = new Set(table.assets.filter((a) => this.lines[a]!.status === 'out'));
  }

  onDailyClose({ closeMs, holdings }: { closeMs: number; holdings: Readonly<Record<string, HoldingView>> }): void {
    const i = this.table.rowByClose.get(closeMs);
    if (i == null) throw new Error(`seeded rule: no daily close at ${new Date(closeMs).toISOString()}`);
    const row = this.table.rows[i]!;
    for (const asset of this.table.assets) {
      const close = row.close[asset]!;
      const mean = row.sma50[asset];
      if (mean == null) throw new Error(`seeded rule: ${asset} has no 50-day mean at ${new Date(closeMs).toISOString()}`);
      const line = this.lines[asset]!;
      const inheritedEntry = this.inherited.get(asset);
      const holding: HoldingView | undefined = inheritedEntry != null ? { held: true, entryAtMs: inheritedEntry } : holdings[asset];
      stepTrailingLine(line, { asset, closeMs, close, mean, holding }, EXIT_PARAMETERS.minDaysOut, this.name);
      if (inheritedEntry != null && line.status === 'out') this.inherited.delete(asset);
    }
    this.out = new Set(this.table.assets.filter((a) => this.lines[a]!.status === 'out'));
    this.onClose?.(closeMs, this.lines);
  }
}
