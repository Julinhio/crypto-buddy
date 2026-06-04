-- Migration 0004 — extend decisions with the risk-wrapper result
--
-- A decided row already stores `target_allocation` (what the AI proposed, raw).
-- We now also store what the CODE actually kept after clamping to the risk caps,
-- written in the SAME cycle (never a later mutation):
--   - applied_allocation : the bounded allocation (surplus sent to cash)
--   - clamped            : whether the wrapper changed anything
--   - clamp_reason       : human-readable explanation of the adjustments
--
-- Nullable on purpose: skipped / parse_failed / error rows have no allocation,
-- and decided rows created before this migration won't have it either (so we
-- can't add a NOT-NULL-for-decided CHECK without breaking them). The app sets
-- them on every new decided row.
--
-- How to apply: paste into the Supabase SQL editor and Run.

alter table public.decisions
  add column if not exists applied_allocation jsonb,
  add column if not exists clamped            boolean,
  add column if not exists clamp_reason       text;

comment on column public.decisions.applied_allocation is
  'Allocation after the risk wrapper bounded it to the caps (surplus → cash). The AI proposes (target_allocation), the code disposes (applied_allocation).';
