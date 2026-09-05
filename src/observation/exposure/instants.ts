/**
 * MOVED — the instant parsers now live in `src/time/instants.ts`.
 *
 * They were written here because the observer was their only consumer. The exposure-band
 * pilot's historical replay is the second, and it sits in `src/replay/`, which the
 * observer's own Proof 4 forbids from importing anything under `observation/exposure`.
 * Copying eighty lines of calendar validation into a second file is exactly the drift this
 * codebase refuses everywhere else — a zone check that disagreed with itself between two
 * readers of the SAME `barAt` would move a bar key without moving anything visible.
 *
 * So the module moved outward rather than being duplicated, and this shim keeps every
 * existing import — and the proofs written against them — spelled exactly as they were.
 */
export {
  ISO_WITH_ZONE,
  canonicalInstant,
  parseWindowBound,
  parseZonedInstant,
} from '../../time/instants.js';
