-- Migration 0010 — reset_bot (atomic, lock-guarded reset of the bot)
--
-- The dashboard's reset utility wipes the bot's history and redefines its starting
-- capital. It is the MOST DESTRUCTIVE operation in the project (it erases everything)
-- and the first DB MUTATION driven by the dashboard. Both reasons demand it run as a
-- single atomic, lock-guarded server-side function rather than a sequence of REST
-- calls (supabase-js cannot express a multi-statement transaction).
--
-- THE LOCK INVARIANT (non-negotiable). The bot derives its portfolio from two
-- separate reads inside decide() — the executions ledger, then the starting capital.
-- A purge landing between them would desync the book. We close that race the same way
-- the scheduler serializes its own beats: through the run-lock on the bot_state
-- singleton (run_token + locked_until). The lock is LOGICAL (persisted columns),
-- NOT a Postgres row lock — decide()'s reads run as separate autocommit statements
-- that take no lock. reset_bot honors that same logical lock:
--   - If a cycle holds the lock (run_token set, locked_until in the future), the
--     conditional-claim UPDATE matches 0 rows → we return 'busy' and purge NOTHING.
--   - If we win the claim, we hold the bot_state ROW lock for the rest of this
--     transaction, so any concurrent beat's claim_due_run / record_heartbeat blocks
--     until we commit, then sees the lock free + next_check_at = now() and runs a
--     fresh cycle on the clean base. No cycle's two reads can straddle a purge.
-- This holds because the config enforces lockTtl (600s) > maxCycleSeconds (300s).
--
-- ATOMICITY. The whole body is ONE implicit transaction. A RAISE anywhere — or any
-- failure — rolls back EVERYTHING, including the lock claim: the base is never left
-- half-purged and the lock is never left stuck.
--
-- NOT TOUCHED: ath_atl_cache (market data, independent of capital — purging it would
-- only force a needless re-seed) and the bot_state identity row (id=1) itself.
--
-- The new capital is validated AT THE SOURCE here (>= 1 and <= 100000, which also
-- rejects NaN/Infinity), complementing the bot reader's existing positive+finite
-- rejection and the bot_state CHECK (0009). Widen the upper bound explicitly when
-- moving from testnet to real money.
--
-- How to apply: paste into the Supabase SQL editor and Run (or `supabase db push`).
-- DEPLOY ORDER (hard constraint, like 0009): apply this migration BEFORE deploying
-- the dashboard route that calls it — a call to a not-yet-created function errors.

create or replace function public.reset_bot(
  p_new_starting_capital_usd numeric
)
returns table (
  status        text,
  locked_until  timestamptz,
  next_check_at timestamptz
)
language plpgsql
-- SECURITY INVOKER (default): runs as the caller. The dashboard calls it as the
-- service role, which bypasses RLS and holds the table privileges the purge needs —
-- same posture as claim_due_run / finish_run.
as $$
declare
  v_locked_until timestamptz;
  v_next         timestamptz;
begin
  -- 1. Validate the new capital BEFORE touching the lock or any data. The range
  --    check also rejects NaN / +-Infinity (NaN <= 100000 and Infinity <= 100000 are
  --    both false for Postgres numeric). On reject we purge nothing.
  if p_new_starting_capital_usd is null
     or not (p_new_starting_capital_usd >= 1 and p_new_starting_capital_usd <= 100000) then
    return query select 'invalid'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 2. Claim the run-lock — the SAME compare-and-set the scheduler uses
  --    (claim_due_run), MINUS the "due?" check: a reset claims regardless of
  --    next_check_at. The table is aliased and the WHERE columns qualified because
  --    locked_until collides with this function's OUT column name (plpgsql would
  --    otherwise raise on the ambiguous reference). If a live lock exists, 0 rows
  --    match → the bot is mid-cycle → refuse with 'busy', purge nothing.
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

  -- 3. Purge the history, children before parents (FK-safe order). Explicit even
  --    where a cascade/set-null would cover it, for readability. executions has a
  --    self-FK (intent_execution_id, NO ACTION) — a full-table delete is fine
  --    (the constraint is checked at statement end, with no rows left).
  delete from public.executions;
  delete from public.equity_snapshots;
  delete from public.scheduler_runs;
  delete from public.decisions;

  -- 4. Reset bot_state to a clean slate, write the new capital, and RELEASE the lock,
  --    in one statement. next_check_at = now() so the next beat runs a fresh cycle on
  --    the empty ledger (portfolio = the new capital, 100% cash, curve from zero).
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

  -- The singleton must exist (0006 seeds it). Its absence here is a fault: RAISE so
  -- the whole transaction — including the purge and the claim — rolls back.
  if not found then
    raise exception 'reset_bot: bot_state singleton (id=1) is missing during finalize';
  end if;

  return query select 'reset'::text, null::timestamptz, v_next;
end;
$$;

-- Lockdown (mirror 0006): new functions grant EXECUTE to PUBLIC by default; revoke
-- that and grant it back ONLY to service_role, so anon/authenticated can't call it.
revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (returns status=busy and purges nothing if a cycle holds it), then in ONE transaction purges decisions/executions/equity_snapshots/scheduler_runs, resets bot_state counters/flags, releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at.';
