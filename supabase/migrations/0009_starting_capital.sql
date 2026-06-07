-- Migration 0009 — starting capital in the database (column only, NO seed)
--
-- The sovereign starting capital — the INITIAL CONDITION of the whole virtual
-- portfolio (portfolio = startingCapital + Σ ledger deltas, derived live) — has
-- lived in an env var (STARTING_CAPITAL_USD, on Railway). An env var can't be
-- edited from the dashboard, so this moves the value into the DB, read by the bot.
-- This is the PREREQUISITE for a forthcoming reset utility; the reset itself (the
-- dashboard danger-zone UI, table purges, and WRITING a capital) is a separate PR,
-- OUT OF SCOPE here. This PR adds NO write path — the bot only READS this value.
--
-- This migration adds ONLY the (nullable) column. It deliberately does NOT seed any
-- value:
--   - Seeding a hard-coded constant (e.g. 500) bakes an install-specific value into
--     a migration — fragile, and it would clobber a differently-configured capital.
--   - Left NULL, the column means "no capital explicitly set yet". The bot then
--     bootstraps on the env var (the install's real current value). The column gets
--     a real value only when someone explicitly sets it — i.e. the future reset.
--
-- INVARIANCE — the live bot's derived portfolio is byte-identical before and after.
-- Today STARTING_CAPITAL_USD is unset on Railway, so the bot uses the code default
-- of 500. After this migration the column is NULL, the bot falls back to that same
-- env bootstrap (500), and derives exactly as before. We move the SOURCE, not the
-- value. On the first reset, the DB gets a real value and becomes authoritative.
--
-- Type: `numeric` (EXACT) — an accounting value, read back via fromNumeric() into a
-- Decimal (contrast equity_snapshots' double-precision observability columns).
--
-- How to apply: paste into the Supabase SQL editor and Run (or `supabase db push`).
-- DEPLOY ORDER: apply this migration BEFORE deploying the new bot code, so the
-- column exists and the bot takes the NULL → env-bootstrap path. (If the code ships
-- first, the bot reads a not-yet-existing column; it treats undefined_column as the
-- same objective absence and still bootstraps on the env — but migration-first is
-- the clean path and avoids relying on that detection.)

alter table public.bot_state
  add column if not exists starting_capital_usd numeric;

-- Defense in depth for a fundamental accounting value: when a value IS set (by the
-- future reset) it must be strictly positive — a zero/negative capital would corrupt
-- P&L. NULL stays allowed (no value set yet → env bootstrap). Idempotent add. This
-- constrains future writes; it imposes no value of its own.
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

comment on column public.bot_state.starting_capital_usd is
  'Sovereign starting capital in USD (exact numeric) — the initial condition of the derived virtual portfolio. NULL = not explicitly set yet → the bot bootstraps on the env var STARTING_CAPITAL_USD. Set out-of-band by the future reset utility (NOT by the scheduler functions). The bot only READS it; on a genuine read failure (schema present, DB unreachable) the bot fails the cycle rather than fall back, to never derive on a stale value.';

-- RLS is already enabled (deny-all, service role bypass) on bot_state from 0006 —
-- nothing to change here. The bot reads this column with the service-role key.
