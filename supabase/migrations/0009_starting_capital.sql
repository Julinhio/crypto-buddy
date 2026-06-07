-- Migration 0009 — starting capital in the database
--
-- The sovereign starting capital — the INITIAL CONDITION of the whole virtual
-- portfolio (portfolio = startingCapital + Σ ledger deltas, derived live) — has
-- lived in an env var (STARTING_CAPITAL_USD, on Railway). An env var can't be
-- edited from the dashboard, so this moves the value into the DB, read by the bot.
-- This is the PREREQUISITE for a forthcoming reset utility; the reset itself (the
-- dashboard danger-zone UI, table purges, and WRITING a new capital) is a separate
-- PR and is OUT OF SCOPE here. This PR adds NO human-triggered write path — the bot
-- only READS this value.
--
-- KEY PROPERTY — the live bot's derived portfolio must be byte-identical before and
-- after this PR. We move the source of the value, we do NOT touch the value: the
-- seed below equals exactly what the live bot uses today (env unset on Railway →
-- the code default of 500), so the derivation is unchanged.
--
-- Type: `numeric` (EXACT), not double precision. This is an accounting value — the
-- ledger handles money exactly via decimal.js, and the bot reads this back through
-- fromNumeric() into a Decimal. (Contrast the equity_snapshots value columns, which
-- are observability and intentionally double precision.) supabase-js returns numeric
-- as a string; the bot parses it with fromNumeric, same as the ledger.
--
-- Nullable on purpose: a brand-new (vierge) base has no value yet, so the column is
-- NULL and the bot bootstraps on the env var until a value is present (e.g. written
-- by the future reset). "The DB is the source of truth once the value is present."
--
-- How to apply: paste into the Supabase SQL editor and Run (or `supabase db push`).
-- DEPLOY ORDER: apply this migration BEFORE deploying the new bot code. The bot also
-- falls back to the env var when the value is absent/unreadable, so deploy-first is
-- safe too (just transient warnings) — migration-first is the clean path.

alter table public.bot_state
  add column if not exists starting_capital_usd numeric;

-- Defense in depth for a fundamental accounting value: never zero/negative (it would
-- corrupt P&L). NULL stays allowed (vierge base → env bootstrap). Idempotent add.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bot_state_starting_capital_positive'
  ) then
    alter table public.bot_state
      add constraint bot_state_starting_capital_positive
      check (starting_capital_usd is null or starting_capital_usd > 0);
  end if;
end $$;

-- Seed the live singleton with the capital the bot uses TODAY — env unset on Railway
-- → the code default of 500 (see src/config/index.ts envNumber('STARTING_CAPITAL_USD',
-- 500)). Only where still NULL: idempotent, and never clobbers a value a later reset
-- has written.
update public.bot_state
   set starting_capital_usd = 500
 where id = 1
   and starting_capital_usd is null;

comment on column public.bot_state.starting_capital_usd is
  'Sovereign starting capital in USD (exact numeric) — the initial condition of the derived virtual portfolio. Read by the bot, with an env-var (STARTING_CAPITAL_USD) bootstrap fallback when NULL/unreadable. Written out-of-band by the future reset utility, NOT by the scheduler functions (unlike the other bot_state columns).';

-- RLS is already enabled (deny-all, service role bypass) on bot_state from 0006 —
-- nothing to change here. The bot reads this column with the service-role key.
