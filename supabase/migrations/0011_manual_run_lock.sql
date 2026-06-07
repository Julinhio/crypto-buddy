-- Migration 0011 — manual-run lock (close the back-door reset/cycle race)
--
-- 0010's reset_bot claims the run-lock so a reset is mutually exclusive with a
-- SCHEDULED cycle (the beat, via claim_due_run). But `npm run decide` calls decide()
-- DIRECTLY, taking NO lock. So a manual run could read the old ledger, a reset could
-- claim the apparently-free lock and purge + rewrite the capital, and the manual run
-- would then write decisions/executions onto the purged base — the SAME race, by the
-- back door. (Independently, a manual run during a Railway beat was already a
-- potential double-cycle.) Closing this closes the whole class: EVERY mutation path
-- — beat, manual run, reset — now goes through the one run-lock.
--
-- These two functions let the manual entrypoint claim the lock NOW and release it
-- after the cycle:
--   - claim_manual_run mirrors claim_due_run's atomic compare-and-set MINUS the
--     "due?" check (a manual run wants to run immediately, exactly like reset_bot).
--     Returns true on a claim, false when a live lock is held (a cycle or a reset
--     owns it → the manual run refuses, like the reset). It does NOT open a
--     scheduler_runs row: a manual run is not a beat; it is audited via the
--     decisions it writes.
--   - release_manual_run clears the lock, FENCED by the run_token (like finish_run):
--     if our lock expired and was reclaimed, we don't clobber the new owner's. It
--     leaves next_check_at untouched — a manual run is orthogonal to the scheduler's
--     cadence; the scheduler resumes its normal logic afterwards.
--
-- Mutating bot_state only through functions keeps the singleton's "mutated only via
-- record_heartbeat / claim_due_run / finish_run" contract intact (these just extend
-- that set). SECURITY INVOKER; execute revoked from public, granted to service_role.
--
-- How to apply: paste into the Supabase SQL editor and Run. Migration-before-deploy.

-- claim_manual_run(): atomic lock claim WITHOUT the due check. true = claimed.
create or replace function public.claim_manual_run(
  p_run_token        uuid,
  p_lock_ttl_seconds integer
)
returns boolean
language plpgsql
as $$
begin
  -- Aliased + qualified WHERE: same compare-and-set as claim_due_run, minus the
  -- (next_check_at <= now()) due predicate. A live lock (run_token set, not expired)
  -- matches 0 rows → found is false → the caller refuses.
  update public.bot_state as b
     set run_token    = p_run_token,
         locked_until = now() + make_interval(secs => p_lock_ttl_seconds),
         updated_at   = now()
   where b.id = 1
     and (b.run_token is null or b.locked_until is null or b.locked_until <= now());
  return found;
end;
$$;

-- release_manual_run(): fenced release. true = we still held the lock and cleared it.
create or replace function public.release_manual_run(
  p_run_token uuid
)
returns boolean
language plpgsql
as $$
begin
  -- Fencing token: only clear the lock if WE still own it. If our run overran its
  -- TTL and the lock was reclaimed (by a beat or a reset), this affects 0 rows and
  -- we must NOT clobber the new owner's claim. next_check_at is deliberately left
  -- as-is (a manual run does not reschedule the scheduler).
  update public.bot_state
     set run_token    = null,
         locked_until = null,
         updated_at   = now()
   where id = 1
     and run_token = p_run_token;
  return found;
end;
$$;

-- Lockdown (mirror 0006): revoke from public, grant only to service_role.
revoke execute on function public.claim_manual_run(uuid, integer) from public;
revoke execute on function public.release_manual_run(uuid) from public;
grant execute on function public.claim_manual_run(uuid, integer) to service_role;
grant execute on function public.release_manual_run(uuid) to service_role;

comment on function public.claim_manual_run(uuid, integer) is
  'Atomically claims the bot run-lock for a manual `npm run decide` cycle — like claim_due_run but with no due check (runs now). Returns true on a claim, false when a cycle or a reset holds the lock. Mirrors reset_bot''s claim so every mutation path is mutually exclusive.';
comment on function public.release_manual_run(uuid) is
  'Releases a manual run''s lock, fenced by the run_token (no-op if reclaimed after overrunning the TTL). Leaves next_check_at untouched.';
