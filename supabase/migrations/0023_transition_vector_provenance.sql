-- Migration 0023 — provenance of a refused leg (transition layer, still OBSERVE MODE)
--
-- Extends `transition_observations` (0022) with the vector-level facts. The layer still
-- blocks nothing: these columns record what it WOULD have refused and, crucially, WHY.
--
-- ── The question these columns exist to answer ──────────────────────────────────
--
-- When the gate becomes blocking, a leg can be refused for two different reasons: because
-- its own asset is frozen, or because ANOTHER leg of the same vector was and the refusal
-- is atomic — a portfolio target is refused whole or not at all. In the second case the
-- leg's own row looks perfectly tradable: actionable asset, confirmed regime, no stop.
-- Without a column separating the two, no amount of re-reading afterwards can tell an
-- operator which episode they are looking at.
--
-- Building it now, in observe mode, means arriving at the switch with a column that has
-- been filled and verified for weeks, instead of one whose first row lands the day it
-- counts.
--
-- ── Why these are NOT the existing order_* columns ──────────────────────────────
--
-- `order_side` / `order_verdict` describe what actually BOOKED, and they keep meaning
-- exactly that — a column whose meaning changes halfway through a series is worse than a
-- missing one, and this table is the evidence base for the blocking decision.
--
-- The new `leg_*` columns describe the model's VECTOR: the movements computed from the
-- distance between its allocation and the book, before execution. That is the population
-- the blocking gate will act on, so it is the population that has to be rehearsed. The two
-- coincide on almost every cycle and diverge exactly where it matters — a movement refused
-- by a venue filter or a failed booking is a leg the gate would still have judged.
--
-- How to apply: paste into the Supabase SQL editor (Dashboard → SQL Editor → New query →
-- Run) BEFORE deploying the code that writes it (the project's hard rule).

-- ── the leg, per asset ─────────────────────────────────────────────────────────
-- All null on the vast majority of rows: a cycle moves at most a couple of assets, and
-- most cycles move none.
alter table public.transition_observations
  add column if not exists leg_side text,
  add column if not exists leg_notional numeric,
  add column if not exists leg_verdict text,
  add column if not exists leg_reason text;

-- ── the vector, per cycle (denormalised onto every row of that cycle) ──────────
-- NULLABLE rather than `not null default false`: rows written before this migration were
-- produced by code that computed no vector at all, and "false" would assert that their
-- cycle was examined and cleared. Null means not computed, which is the truth about them.
alter table public.transition_observations
  add column if not exists atomic_refusal boolean,
  add column if not exists atomic_trigger_asset text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transition_observations_leg_side_chk') then
    alter table public.transition_observations
      add constraint transition_observations_leg_side_chk
      check (leg_side is null or leg_side in ('buy', 'sell'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'transition_observations_leg_notional_chk') then
    alter table public.transition_observations
      add constraint transition_observations_leg_notional_chk
      check (leg_notional is null or leg_notional >= 0);
  end if;
  -- `cancelled_atomic` is the value this whole migration is for. The other four mirror
  -- `order_verdict`'s vocabulary so the two columns stay readable side by side.
  if not exists (select 1 from pg_constraint where conname = 'transition_observations_leg_verdict_chk') then
    alter table public.transition_observations
      add constraint transition_observations_leg_verdict_chk
      check (leg_verdict is null
             or leg_verdict in ('allowed', 'forbidden', 'cancelled_atomic', 'superseded', 'unjudged'));
  end if;
  -- A trigger without a refusal is incoherent, and so is a refusal that names no leg:
  -- the two are recorded together or not at all.
  if not exists (select 1 from pg_constraint where conname = 'transition_observations_atomic_chk') then
    alter table public.transition_observations
      add constraint transition_observations_atomic_chk
      check ((atomic_refusal is true and atomic_trigger_asset is not null)
             or (atomic_refusal is not true and atomic_trigger_asset is null));
  end if;
end $$;

comment on column public.transition_observations.leg_verdict is
  'Provenance of this cycle''s leg on this asset. `forbidden` = its OWN asset refuses it. `cancelled_atomic` = its own asset was fine, but another leg of the same vector was forbidden and a portfolio target is refused whole or not at all. `superseded` = a deterministic exit (the peak stop) was taking the whole line anyway. `unjudged` = no usable regime. Read together with `gate` to tell a cancelled-while-actionable leg from a cancelled-while-unreadable one.';

comment on column public.transition_observations.leg_side is
  'The MODEL''S VECTOR, not what booked — the movement computed before execution, which is the population the blocking gate will act on. `order_side` remains what actually booked.';

comment on column public.transition_observations.atomic_refusal is
  'Cycle-level, repeated on every row of the cycle: the strategic legs were refused as a block. Null on rows written before migration 0023, which computed no vector — not false, which would claim the cycle was examined.';

comment on column public.transition_observations.atomic_trigger_asset is
  'Which leg brought the vector down. When several were forbidden it is the first by (asset, side); `leg_verdict = ''forbidden''` on the same cycle lists them all.';

-- The headline query — "which legs would the gate have refused, and which of those only
-- because of a neighbour" — over a table where the overwhelming majority of rows carry no
-- leg at all. Partial, so it stays small as the journal grows by four rows per cycle.
create index if not exists transition_observations_legs_idx
  on public.transition_observations (created_at desc)
  where leg_verdict is not null;
