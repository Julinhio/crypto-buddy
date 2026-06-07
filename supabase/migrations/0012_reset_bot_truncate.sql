-- Migration 0012 — reset_bot: purge via TRUNCATE (pg-safeupdate-safe)
--
-- BUG (surfaced on the FIRST real reset from the dashboard): reset_bot's purge (0010)
-- issued four unqualified `DELETE FROM <table>` statements. This Supabase database runs
-- the pg-safeupdate guard, which rejects any UPDATE/DELETE with no WHERE clause —
-- "DELETE requires a WHERE clause". So the purge raised, the RPC 500'd, and the reset
-- never ran. 0010's reviews covered the lock/concurrency logic, not this runtime guard.
--
-- FIX: purge with a single TRUNCATE instead of four full-table DELETEs.
--   - pg-safeupdate hooks the executor for UPDATE/DELETE command nodes; TRUNCATE is a
--     UTILITY statement it does not — and structurally cannot — guard. So the fix holds
--     regardless of how/whether the guard is configured, and it does NOT depend on
--     toggling a GUC we'd have to name exactly (the proposed `sql_safe_updates` is a
--     CockroachDB variable, not a standard Postgres/pg-safeupdate one — a wrong name
--     would itself error). TRUNCATE sidesteps the whole question.
--   - It is the semantically honest operation here: "empty these tables entirely".
--   - It is TRANSACTIONAL in Postgres, so atomicity under the run-lock is unchanged: a
--     later RAISE rolls the whole body back, including the truncate AND the lock claim —
--     the base is never left half-purged and the lock is never left stuck.
--
-- FK SAFETY: one TRUNCATE lists every FK-linked table together. executions,
-- equity_snapshots and scheduler_runs all reference decisions, and executions has a
-- self-FK (intent_execution_id); emptying them in the same statement satisfies every
-- constraint, so NO CASCADE is needed. The only other public tables — ath_atl_cache and
-- bot_state — reference none of these and are left untouched, exactly as before.
--
-- SEQUENCES NOT RESET (deliberately no RESTART IDENTITY): a plain TRUNCATE leaves the
-- identity sequences advancing, so this is behavior-IDENTICAL to the old DELETEs (empty
-- tables, ids keep climbing) — only guard-safe and faster. Keeping ids monotonic across
-- resets means every decision/execution id stays globally unique (cleaner cross-session
-- debugging) and preserves the assumption the dashboard's journal/curve reconcile on.
--
-- PRIVILEGE: TRUNCATE requires the TRUNCATE table privilege, which is NOT implied by
-- DELETE. This function is SECURITY INVOKER (runs as the caller), and the dashboard
-- calls it as service_role, so we grant TRUNCATE to service_role below (idempotent —
-- a no-op if Supabase's defaults already cover it). No need to switch to SECURITY
-- DEFINER; the posture stays identical to 0010 / claim_due_run / finish_run.
--
-- How to apply: paste into the Supabase SQL editor and Run (or `supabase db push`).
-- DEPLOY ORDER (like 0010): apply this migration BEFORE relying on the dashboard reset.

create or replace function public.reset_bot(
  p_new_starting_capital_usd numeric
)
returns table (
  status        text,
  locked_until  timestamptz,
  next_check_at timestamptz
)
-- SECURITY INVOKER (default): runs as the caller (the dashboard's service_role), which
-- bypasses RLS and holds the privileges the purge needs — same posture as 0010.
language plpgsql
as $$
declare
  v_locked_until timestamptz;
  v_next         timestamptz;
begin
  -- 1. Validate the new capital BEFORE touching the lock or any data. The range check
  --    also rejects NaN / +-Infinity (both `<= 100000` comparisons are false). On
  --    reject we purge nothing.
  if p_new_starting_capital_usd is null
     or not (p_new_starting_capital_usd >= 1 and p_new_starting_capital_usd <= 100000) then
    return query select 'invalid'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 2. Claim the run-lock — the SAME compare-and-set the scheduler uses (claim_due_run)
  --    MINUS the "due?" check: a reset claims regardless of next_check_at. The table is
  --    aliased and the WHERE columns qualified (locked_until collides with the OUT
  --    column). A live lock → 0 rows → the bot is mid-cycle → refuse with 'busy',
  --    purge nothing. (This UPDATE HAS a WHERE clause, so pg-safeupdate allows it.)
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

  -- 3. Purge the history. ONE TRUNCATE over every FK-linked table at once (children and
  --    parent together → constraints satisfied without CASCADE). TRUNCATE is a utility
  --    statement, not an UPDATE/DELETE, so pg-safeupdate's WHERE-clause guard never
  --    applies. Atomic with the rest of this transaction; rolled back by any RAISE below.
  truncate table
    public.executions,
    public.equity_snapshots,
    public.scheduler_runs,
    public.decisions;

  -- 4. Reset bot_state to a clean slate, write the new capital, and RELEASE the lock, in
  --    one statement. next_check_at = now() so the next beat runs a fresh cycle on the
  --    empty ledger (portfolio = the new capital, 100% cash, curve from zero).
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

  -- The singleton must exist (0006 seeds it). Its absence here is a fault: RAISE so the
  -- whole transaction — including the truncate and the claim — rolls back.
  if not found then
    raise exception 'reset_bot: bot_state singleton (id=1) is missing during finalize';
  end if;

  return query select 'reset'::text, null::timestamptz, v_next;
end;
$$;

-- TRUNCATE requires the TRUNCATE table privilege (not implied by DELETE). Grant it to
-- service_role — the role the dashboard calls this SECURITY INVOKER function as.
-- Idempotent: a no-op if Supabase's default privileges already include it.
grant truncate on table
  public.executions,
  public.equity_snapshots,
  public.scheduler_runs,
  public.decisions
to service_role;

-- Re-assert the function lockdown (create-or-replace preserves the existing ACL, but
-- keep it explicit + self-contained, mirroring 0010): execute only by service_role.
revoke execute on function public.reset_bot(numeric) from public;
grant execute on function public.reset_bot(numeric) to service_role;

comment on function public.reset_bot(numeric) is
  'Atomically resets the bot: claims the run-lock like a beat (status=busy and purges nothing if a cycle holds it), then in ONE transaction TRUNCATEs decisions/executions/equity_snapshots/scheduler_runs (pg-safeupdate-safe; identity sequences NOT reset), resets bot_state counters/flags, releases the lock, reschedules next_check_at=now(), and writes the new starting_capital_usd (validated 1..100000). Keeps ath_atl_cache. Returns one row: status (reset|busy|invalid), locked_until, next_check_at.';
