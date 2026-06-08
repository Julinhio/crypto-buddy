/**
 * Shared allocation display — the ONE home for the "positions biggest-first, cash
 * ALWAYS last" convention, used by BOTH the activity notification and the daily
 * summary so the two can't drift. Cash is the reserve, not a position; with the ≥30%
 * floor it is usually the biggest slice, but it stays in the tail so the positions
 * read first. Intentional, not a bug (see the consumers' tests).
 */
export interface AllocationSlice {
  /** Asset ticker, or 'cash' for the reserve stable. */
  label: string;
  /** Percent of equity. */
  weight: number;
}

/** Open positions by DECREASING weight, then cash appended LAST (never sorted in). */
export function orderedAllocation(positions: AllocationSlice[], cashWeight: number): AllocationSlice[] {
  return [...positions].sort((a, b) => b.weight - a.weight).concat({ label: 'cash', weight: cashWeight });
}

/** "22% BTC · 12% ETH · 58% cash" — the shared one-line allocation format. */
export function formatAllocation(slices: AllocationSlice[]): string {
  return slices.map((s) => `${Math.round(s.weight)}% ${s.label}`).join(' · ');
}
