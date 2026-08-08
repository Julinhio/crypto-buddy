-- Migration 0022 — transition_observations (transition layer, OBSERVE MODE)
--
-- One row per (cycle, tradable asset): what the transition layer WOULD have done, and
-- what the model actually did. The layer blocks nothing in this PR — it computes, it
-- writes here, and the model's allocation is applied exactly as before. The switch to
-- blocking is a separate PR, taken on the evidence this table produces.
--
-- Why the layer exists: the bot sells into rallies (cash 47% → 77% over the first week of
-- August while BTC/ETH/BNB rose). The regime shown to the model is smoothed over three
-- confirmation bars while pullbackConsumed / bounceConsumed are computed on the current
-- bar, so during a transition it reads a label describing the past next to flags
-- describing the present — and 12 of that week's 24 orders were placed in exactly that
-- state, 10 of them sells. Measured in docs/RAPPORT-CONTRAT-TRANSITION.md.
--
-- ── What this table is FOR ──────────────────────────────────────────────────────
--
-- Answering, from SQL and after any number of restarts: how often would the gate have
-- fired, on which assets, and which real orders would it have stopped. The two access
-- paths are "one cycle, all assets" and "one asset, over time", which is what the indexes
-- below serve.
--
-- ── Reading stop_would_fire ─────────────────────────────────────────────────────
--
-- In observe mode NOTHING exits, so the peak is never reset and a line stays below its
-- threshold: the flag can be true on many CONSECUTIVE cycles for what the contract makes
-- a SINGLE exit. Count EPISODES (maximal runs of consecutive true per asset), never rows.
-- A naive count(*) would read as hundreds of exits where the rule produces one.
--
-- How to apply: paste into the Supabase SQL editor (Dashboard → SQL Editor → New query →
-- Run) BEFORE deploying the code that writes it (the project's hard rule).

create table if not exists public.transition_observations (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  -- The cycle. ON DELETE CASCADE because an observation about a decision that no longer
  -- exists is not evidence of anything.
  decision_id bigint not null references public.decisions (id) on delete cascade,
  asset       text   not null,

  -- The 4h bar the verdict was computed on — NOT the wake-up time. Null when no bar had
  -- closed for this asset, which is the `no_regime` case below.
  bar_at      timestamptz,

  -- ── the actionability rule ────────────────────────────────────────────────────
  actionable       boolean not null,
  -- The regime after hysteresis: identical to what the model was shown. The layer gates,
  -- it never relabels (proven exhaustively — see src/test/stickyTransition.ts).
  confirmed_regime text,
  -- The unsmoothed label at that bar. The gap between this and confirmed_regime is the
  -- defect the layer exists to close, so both are stored side by side.
  raw_regime       text,
  -- Consecutive OBSERVED bars of the same raw label — the counter the gate reads.
  run_length       integer not null,
  -- The same count ignoring holes in the 4h grid; mirrors production's Hysteresis and
  -- drives confirmed_regime. Equal to run_length whenever the grid is complete.
  label_run        integer not null,
  risk_off         boolean not null,

  -- ── the peak stop ─────────────────────────────────────────────────────────────
  stop_armed             boolean not null,
  stop_would_fire        boolean not null,
  stop_threshold_percent numeric not null,
  -- A UNIT PRICE, never a position valuation (see position_state's own comment).
  peak_price                  numeric,
  price                       numeric,
  drawdown_from_peak_percent  numeric,
  -- Why an ARMED stop did not evaluate: no live price, a stale one, or no peak on record.
  -- Stored rather than collapsed into stop_would_fire=false, because "did not fire" and
  -- "could not look" are different facts and only the second one is a data problem.
  stop_abstained_reason       text,

  -- ── the priority ladder ───────────────────────────────────────────────────────
  -- Exactly the fixed order: stop_exit > risk_off_reduction > frozen > actionable.
  -- `no_regime` is the honest fifth outcome, not a rung.
  gate        text not null
                check (gate in ('stop_exit', 'risk_off_reduction', 'frozen', 'actionable', 'no_regime')),
  gate_reason text not null,

  -- ── the real order, when one booked on this asset this cycle ──────────────────
  -- Null on the vast majority of rows: most cycles book nothing. `superseded` is kept
  -- apart from allowed/forbidden on purpose — on a stop_exit cycle the code would be
  -- selling the whole line anyway, so the model's order is moot rather than refused, and
  -- folding it either way would corrupt the count this table exists to produce.
  order_side     text    check (order_side is null or order_side in ('buy', 'sell')),
  order_notional numeric check (order_notional is null or order_notional >= 0),
  order_verdict  text    check (order_verdict is null
                          or order_verdict in ('allowed', 'forbidden', 'superseded', 'unjudged')),
  order_reason   text,

  -- One verdict per asset per cycle. A cycle computes at most one movement per asset (it
  -- is reaching a target, not trading around it), so this is the natural grain — and it
  -- makes the write idempotent under a retry.
  constraint transition_observations_unique_per_cycle_asset unique (decision_id, asset)
);

comment on table public.transition_observations is
  'Transition layer in OBSERVE MODE: per cycle and per asset, what the layer would have done (actionability, peak stop, priority ladder) and its verdict on the order the model actually placed. Blocks nothing — the model''s allocation is applied unchanged.';

comment on column public.transition_observations.stop_would_fire is
  'Observe mode never exits, so the peak is never reset and this can be true on many CONSECUTIVE cycles for what the contract makes a SINGLE exit. Count episodes (maximal runs per asset), never rows.';

comment on column public.transition_observations.order_verdict is
  'Counterfactual only: the order had already booked when this was written. `superseded` = the stop was exiting the whole line anyway, so the model''s order is moot rather than refused.';

-- "One cycle, all assets" — the audit of a single wake-up.
create index if not exists transition_observations_decision_idx
  on public.transition_observations (decision_id);

-- "One asset, over time" — the freeze/stop history that the blocking decision will rest on.
create index if not exists transition_observations_asset_time_idx
  on public.transition_observations (asset, created_at desc);

-- The headline query — "which real orders would the layer have stopped" — over a table
-- where the overwhelming majority of rows carry no order at all. Partial, so it stays
-- small as the journal grows by four rows per cycle.
create index if not exists transition_observations_orders_idx
  on public.transition_observations (created_at desc)
  where order_verdict is not null;

-- Row Level Security: ENABLED with NO policies (deny-all), same posture as every other
-- table. The backend uses the service role key, which bypasses RLS; any anon/public key
-- is denied all access.
--
-- It matters here for a reason specific to this table: it is the evidence base on which
-- the decision to switch the layer to BLOCKING will be taken. A writable observation log
-- is a writable argument.
alter table public.transition_observations enable row level security;
