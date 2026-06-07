-- Migration 0008 — equity snapshots
--
-- One row per wake-up: a PHOTO of the bot's equity and portfolio composition at
-- the moment it valued itself, valued at the SAME prices the AI saw that cycle
-- (decisions.market_context). This is the storage half of moving the equity curve
-- from "reconstructed at read time" to "stored once at write time": the bot writes
-- a snapshot each time it can value its book, so the dashboard can later plot the
-- curve by reading these rows directly instead of replaying the whole history.
--
-- WHY a dedicated table when market_context.account.portfolio already carries the
-- same numbers? Because that view is buried in a large per-decision jsonb blob; a
-- lean, append-only projection keyed for time-ordered reads is what a curve wants —
-- no digging, no reconstruction. This table is OBSERVABILITY, derived from the
-- ledger; it is never read back into the accounting and never influences a trade.
--
-- WHY `double precision` for the value columns (not `numeric`)? supabase-js returns
-- `numeric` as strings; these values exist only to be plotted, so a clean JS number
-- on read is what we want. Same choice as the ATH/ATL cache prices (0001), and
-- consistent with how the portfolio view is already serialized into market_context
-- as plain rounded numbers. The "money is exact `numeric`, never float" rule stays
-- where it belongs — the sovereign ledger (`executions`, 0003) — which this table
-- only ever READS from (via the existing derivation), never writes back to.
--
-- How to apply: paste this file into the Supabase SQL editor (Dashboard → SQL
-- Editor → New query → Run), or run it via the Supabase CLI (`supabase db push`).
-- See README → Persistence. No data migration / backfill — snapshots start
-- accumulating from the first wake-up after this ships.

create table if not exists public.equity_snapshots (
  -- Identity + link
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),       -- ≈ wake-up time (written seconds later)

  -- One photo per decision row. UNIQUE makes a second photo of the same wake-up
  -- impossible at the DB level (defense in depth — the scheduler lock already
  -- serializes cycles). The exact wake-up timestamp lives on decisions.created_at,
  -- joinable via this FK. Cascade: a snapshot has no meaning without its decision,
  -- and it is pure observability — safe to delete with it (UNLIKE the sovereign
  -- executions ledger, which deliberately does NOT cascade).
  decision_id   bigint not null unique
                  references public.decisions (id) on delete cascade,

  -- The equity photo, valued at the wake-up's market_context prices.
  equity_usd    double precision not null,                -- cash + Σ position values
  cash_usd      double precision not null,                -- free cash held in the reserve stable
  reserve_asset text not null,                            -- the reserve stable, e.g. 'USDT'

  -- Composition: one entry per open (deployed) position. Cash is in cash_usd above,
  -- so equity_usd = cash_usd + Σ positions[].value_usd. Shape:
  --   [{ asset, qty, price, value_usd, price_stale }, …]
  -- price_stale = true means that asset had no live price this wake-up and was
  -- valued at its avg cost (the curve point is then only as fresh as that fallback).
  positions     jsonb not null
);

-- Serves the curve read: snapshots in chronological order.
create index if not exists equity_snapshots_created_at_idx
  on public.equity_snapshots (created_at);

comment on table public.equity_snapshots is
  'One equity photo per wake-up (1:1 with decisions, UNIQUE decision_id): total equity, free cash, and portfolio composition, valued at that cycle''s market_context prices. Observability projection derived from the executions ledger — read-only for the dashboard curve; never feeds accounting or a decision.';

-- Row Level Security: ENABLED with NO policies (deny-all), same posture as every
-- other table. The backend uses the service role key, which bypasses RLS; any
-- anon/public key is denied all access.
alter table public.equity_snapshots enable row level security;
