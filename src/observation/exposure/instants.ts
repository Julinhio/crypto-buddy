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
export const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Milliseconds since the epoch, or null when the string carries no zone or will not parse. */
export function parseZonedInstant(raw: string): number | null {
  if (!ISO_WITH_ZONE.test(raw)) return null;
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
