-- Migration 0018 — reset_bot: purge position_state too (Strategy V2, PR 3)
--
-- 0017 added a PERSISTENT table that reset_bot did not know about. A reset truncates
-- the ledger and rewrites the capital, but `position_state` survived — so the first
-- post-reset cycle that bought an asset held before the reset would find a stored qty
-- still positive, conclude the line was never closed, and keep the OLD entry date,
-- the OLD peak and (from v5 on) the OLD thesis.
--
-- That is exactly the "previous life" failure the table exists to prevent, arriving
-- through the one door the lifecycle rules cannot see: they compare the stored
-- quantity against the book, and a reset makes both wrong at once.
--
-- The fix is one line in the TRUNCATE list plus the matching grant. `position_state`
-- has no foreign key to `decisions` (its identity is the asset, not a cycle), so
-- adding it to the same statement raises no constraint question — it is listed with
-- the others purely so the purge stays a single atomic utility statement.
--
-- Everything else about reset_bot is unchanged and re-stated verbatim: the lock claim,
-- the validation range, the pg-safeupdate-safe TRUNCATE, the untouched ath_atl_cache
-- and the identity sequences that deliberately keep climbing.
--
-- How to apply: paste into the Supabase SQL editor and Run. Apply BEFORE deploying the
-- code that writes position_state (the project's hard rule).

create or replace function public.reset_bot(
  p_new_starting_capital_usd numeric
)
returns table (
  status        text,
  locked_until  timestamptz,
  next_check_at timestamptz
)
language plpgsql
as $$
declare
  v_locked_until timestamptz;
  v_next         timestamptz;
begin
  -- 1. Validate the new capital BEFORE touching the lock or any data.
  if p_new_starting_capital_usd is null
     or not (p_new_starting_capital_usd >= 1 and p_new_starting_capital_usd <= 100000) then
    return query select 'invalid'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 2. Claim the run-lock — the same compare-and-set the scheduler uses, minus the
  --    "due?" check. A live lock → 0 rows → the bot is mid-cycle → refuse, purge nothing.
  update public.bot_state as b
     set run_token    = gen_random_uuid(),
         locked_until = now() + make_interval(secs => 60)
   where b.id = 1
     and (b.run_token is null or b.locked_until is null or b.locked_until <= now());

  if not found then
    select b.locked_until into v_locked_until from public.bot_state as b where b.id = 1;
    return query select 'busy'::text, v_locked_until, null::timestamptz;
    return;
  end if;

  -- 3. Purge the history. position_state joins the list as of this migration: a reset
  --    means "this portfolio never happened", and a peak that outlives it would steer
  --    the trailing logic of a portfolio it knows nothing about.
  truncate table
    public.executions,
    public.equity_snapshots,
    public.scheduler_runs,
    public.position_state,
    public.decisions;

  -- 4. Reset bot_state to a clean slate, write the new capital, release the lock.
  v_next := now();
  update public.bot_state as b
     set run_token            = null,
         locked_until         = null,
         consecutive_failures = 0,
         floor_delay_streak   = 0,
         floor_alert_sent     = false,
         failure_alert_sent   = false,
         last_success_at      = null,
         next_check_at        = v_next,
         starting_capital_usd = p_new_starting_capital_usd,
         updated_at           = now()
   where b.id = 1;

  if not found then
    raise exception 'reset_bot: bot_state singleton (id=1) is missing during finalize';
  end if;

  return query select 'reset'::text, null::timestamptz, v_next;
end;
$$;

-- TRUNCATE requires the TRUNCATE privilege (not implied by DELETE). Idempotent.
grant truncate on table
  public.executions,
  public.equity_snapshots,
  public.scheduler_runs,
  public.position_state,
  public.decisions
to service_role;

revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (status=busy and purges nothing if a cycle holds it), then in ONE transaction TRUNCATEs decisions/executions/equity_snapshots/scheduler_runs/position_state (pg-safeupdate-safe; identity sequences NOT reset), resets bot_state counters/flags, releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at.';
