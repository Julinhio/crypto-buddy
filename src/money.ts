import Decimal from 'decimal.js';

// Money is exact, never IEEE-754 float. All ledger math goes through Decimal,
// and Postgres stores it in `numeric` columns (read back as strings → Decimal).
//
// Wide exponent bounds so toString() never emits scientific notation for the
// crypto ranges we deal with (tiny quantities, large prices) — Postgres numeric
// parses plain decimal strings, not "1e-9".
Decimal.set({ precision: 40, toExpNeg: -40, toExpPos: 40 });

export { Decimal };

/** Convenience constructor. */
export function dec(value: Decimal.Value): Decimal {
  return new Decimal(value);
}

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

/** Serialize a Decimal for a Postgres `numeric` column (full precision, no exponent). */
export function toNumericString(value: Decimal): string {
  return value.toString();
}

/** Parse a Postgres `numeric` (returned as a string by supabase-js) into a Decimal. */
export function fromNumeric(value: string | number | null | undefined): Decimal {
  if (value == null || value === '') return ZERO;
  return new Decimal(value);
}

/** Human-readable USD amount (2 dp). */
export function fmtUsd(value: Decimal): string {
  return value.toFixed(2);
}

/** Human-readable asset quantity (8 dp, trimmed). */
export function fmtQty(value: Decimal): string {
  return value.toDecimalPlaces(8).toString();
}

/** Percentage with 1 dp. */
export function fmtPct(value: Decimal): string {
  return `${value.toDecimalPlaces(1).toString()}%`;
}
