-- Migration 0015 — daily summary trigger mark
--
-- The daily Telegram summary fires ONCE per local day, around 9h local. The beat
-- runs every 5 min, so the "once per day" idempotence lives here: a date mark on the
-- bot_state singleton + an atomic claim. The logic is NOT "exactly at 9h" but "if we
-- have passed 9h local today and today's summary has not gone out yet, send it" — so
-- a bot that was down at 9h still sends at the first beat after.
--
-- `last_daily_summary_date` is the LOCAL date of the last summary sent (the app
-- computes it in the configured timezone and passes it in — Postgres has no notion
-- of Julien's local zone). `claim_daily_summary(p_local_date)` is the compare-and-set:
-- it sets the mark to today's local date ONLY if it is not already today, and returns
-- whether THIS call won — so even if twenty beats run after 9h, exactly one sends.
--
-- How to apply: paste into the Supabase SQL editor (Dashboard → SQL Editor → New
-- query → Run) BEFORE deploying the code that calls the RPC (the project's hard rule).

alter table public.bot_state
  add column if not exists last_daily_summary_date date;

-- The atomic once-per-day claim: a single conditional UPDATE on the singleton (same
-- compare-and-set shape as claim_due_run). Postgres row-locks the singleton, so two
-- beats racing past the send hour serialize and only the FIRST flips the mark → only
-- it gets `found` = true and sends. Returns true = WE claimed this local date's
-- summary (send it); false = already sent for this date (or someone else just claimed).
--
-- The predicate is `IS DISTINCT FROM`, NOT `<`: send once per DISTINCT local date, not
-- once per "date moved forward". This is DELIBERATE — DAILY_SUMMARY_TZ is meant to
-- change when Julien moves country, and a WESTWARD move makes the local date go
-- BACKWARD (mark = June 9 in Paris, then it is still June 8 in LA). A monotone `<`
-- would reject that earlier date AND the next equal one, skipping a bilan until the
-- date catches up; IS DISTINCT FROM sends it. Intra-day idempotence still holds (same
-- date → not distinct → no re-send) and the row lock keeps the claim atomic. Do NOT
-- regress this to a monotone comparison (a test locks the westward-travel case).
create or replace function public.claim_daily_summary(p_local_date date)
returns boolean
language plpgsql
as $$
begin
  update public.bot_state
     set last_daily_summary_date = p_local_date,
         updated_at = now()
   where id = 1
     and last_daily_summary_date is distinct from p_local_date;
  return found;
end;
$$;

-- Same lockdown as the other state functions: EXECUTE revoked from public, granted to
-- service_role only (the backend's key). anon/authenticated can't call it.
revoke execute on function public.claim_daily_summary(date) from public;
grant execute on function public.claim_daily_summary(date) to service_role;

comment on column public.bot_state.last_daily_summary_date is
  'Local date (in Julien''s configured timezone) of the last daily Telegram summary sent. The once-per-day idempotence mark; set atomically by claim_daily_summary so the summary goes out exactly once per local day even though the beat runs every 5 min.';
