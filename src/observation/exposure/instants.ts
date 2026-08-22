/**
 * INSTANTS — parsed one way, in one place, and never in the host's timezone.
 *
 * `Date.parse('2026-08-12T00:00:00')` — no `Z`, no offset — resolves in the LOCAL timezone.
 * Every instant this module handles comes from somewhere that should carry a zone: a CLI
 * bound the operator typed, a `timestamptz` PostgREST always renders with an offset, or a
 * `barAt` the bot wrote with `toISOString()`. But "should" is not a guarantee, and the failure
 * is silent in the worst possible way: the same database window would acquire different bar
 * keys, different groupings and different artefact bytes under a different `TZ`, while every
 * integrity check still passed and the output was normalised back to `Z` on its way out.
 *
 * So a zone-free string is not parsed. It is refused, or it becomes null — never a guess.
 */

/** ISO-8601 with an EXPLICIT zone: a `Z`, or a `±HH:MM` / `±HHMM` offset. */
export const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** Days in a month, leap years included. `day 0` of the next month is the last of this one. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Milliseconds since the epoch, or null when the string carries no zone, will not parse, or
 * names a date that does not exist.
 *
 * THE CALENDAR IS VALIDATED, not normalised. `Date.parse('2026-02-30T00:00:00Z')` does not fail —
 * it rolls the date forward to 2 March. A typo in a window bound would then select a different
 * population than the operator typed, and the artefact would record only the normalised date, so
 * the typo would be invisible in the very file it moved. The month, the day, the hour, the
 * minute and the second are therefore checked against the real calendar before `Date.parse` is
 * trusted for the arithmetic.
 */
export function parseZonedInstant(raw: string): number | null {
  const match = ISO_WITH_ZONE.exec(raw);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  // 60 is a leap second the platform rolls over rather than represents; refused like any other
  // instant nobody can point at.
  if (second != null && Number(second) > 59) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Normalises a stored instant so two spellings of the same bar compare equal.
 *
 * Null on anything without an explicit zone, which is what makes a bar key comparable across
 * machines. A value the database renders without an offset would surface as a missing bar and
 * fail `every_cycle_keeps_its_bar` — loudly, rather than by quietly shifting a grouping.
 */
export function canonicalInstant(raw: string | null): string | null {
  if (raw == null) return null;
  const ms = parseZonedInstant(raw);
  return ms == null ? null : new Date(ms).toISOString();
}
