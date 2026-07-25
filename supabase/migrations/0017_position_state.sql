-- Migration 0017 — position_state (Strategy V2, PR 3)
--
-- The lifecycle state of each position, OWNED and written every cycle. The mandate is
-- explicit that this is STATE, not a derivation: "c'est stocké et écrit à chaque
-- cycle, jamais reconstruit à l'exécution". That rule exists because the June
-- snapshot-V2 episode was paid for by reconstructing at read time.
--
-- STRICT OWNERSHIP, and it is the whole point of the table:
--
--   written by the CODE  : entry_date, peak_price_since_entry, last_significant_move_*
--   written by the MODEL : thesis, invalidation
--
-- `peak_price_since_entry` is a UNIT PRICE, never a position valuation. After a 50%
-- trim the valuation halves at constant price, so a trailing stop wired to a
-- valuation would fire on a fictitious drawdown. Enforced by a CHECK that it stays
-- positive, and by the code that only ever compares it to a price.
--
-- The peak is NOT reset by a reinforcement, NOT reset by a partial trim. It is reset
-- ONLY after a full exit — at which point the whole line starts a new life
-- (entry_date, peak and thesis all cleared together).
--
-- `entry_date` is the MOST RECENT zero → positive transition, never the first in the
-- table's history: a line that was sold off and bought back must not inherit the peak
-- of a previous life.
--
-- The thesis columns land NULL in this PR. They are written by the model, which only
-- learns to produce them with the v5 prompt (PR 4, behind STRATEGY_VERSION). Storing
-- them now is deliberate: the shape is what PR 4 fills in, not something PR 4 has to
-- migrate.
--
-- How to apply: paste into the Supabase SQL editor (Dashboard → SQL Editor → New
-- query → Run) BEFORE deploying the code that writes it (the project's hard rule).

create table if not exists public.position_state (
  -- One row per tradable base asset. The asset IS the identity: a position is a
  -- continuing thing whose life is described by entry_date, not a new row per entry.
  asset text primary key,

  -- ── owned by the CODE ──────────────────────────────────────────────────────
  -- Most recent transition from zero to positive. NULL while the line is flat.
  entry_date timestamptz,
  -- Highest UNIT PRICE observed since entry_date. NULL while flat. A price, never a
  -- valuation — see the header.
  peak_price_since_entry numeric check (peak_price_since_entry is null or peak_price_since_entry > 0),
  -- The last movement that actually booked on this asset (all of them are significant
  -- now: the 2% plumbing floor of PR 2 is what makes that true by construction).
  last_significant_move_at timestamptz,
  last_significant_move_side text check (last_significant_move_side in ('buy', 'sell')),
  last_significant_move_notional numeric check (last_significant_move_notional is null or last_significant_move_notional >= 0),
  -- Quantity held at the last write. Stored so a zero → positive transition can be
  -- detected against the PREVIOUS cycle without replaying the journal — the table has
  -- to know its own past for the entry rule to be state rather than a derivation.
  qty numeric not null default 0 check (qty >= 0),

  -- ── written by the MODEL (v5 only; NULL until then) ────────────────────────
  -- The thesis in force. It PERSISTS across a hold: rewriting it every wake-up would
  -- recreate the 787 reformulations of one paragraph the mandate diagnoses.
  thesis text,
  -- What would prove the thesis wrong.
  invalidation text,
  thesis_updated_at timestamptz,

  updated_at timestamptz not null default now()
);

comment on table public.position_state is
  'Per-position lifecycle state (Strategy V2 PR 3), written every cycle and never reconstructed at execution. Code owns entry_date / peak_price_since_entry / last_significant_move_*; the model owns thesis / invalidation (v5 only, NULL before that).';

comment on column public.position_state.entry_date is
  'Most recent zero → positive transition. NOT the first in history: a line sold off and bought back starts a new life and must not inherit the previous one''s peak.';

comment on column public.position_state.peak_price_since_entry is
  'Highest UNIT PRICE observed since entry_date — never a position valuation. A trailing stop wired to a valuation would fire on the fictitious drawdown a partial trim creates. Not reset by a reinforcement nor by a partial trim; reset only after a full exit.';

comment on column public.position_state.thesis is
  'The model''s thesis in force. Persists across a hold; rewritten only on a significant decision or an explicit replacement.';
