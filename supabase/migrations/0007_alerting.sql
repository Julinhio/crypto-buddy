-- Migration 0007 — alerting (per-trigger debounce flags)
--
-- The scheduler already maintains two health counters in bot_state:
--   - floor_delay_streak    : decided cycles IN A ROW that asked for the floor
--                             delay (the AI is "overheating" / hammering the floor);
--   - consecutive_failures  : hard errors IN A ROW (the bot beats but its cycle
--                             keeps failing — the gap Healthchecks can't see, since
--                             the process is alive and still pinging).
--
-- The alerting PR sends ONE Telegram alert when either counter crosses its named
-- threshold (app config), stays silent while it remains above, and re-arms when it
-- drops back. The two triggers must be INDEPENDENT — an overheating alert must not
-- mask a degraded alert — so a single boolean can't carry both debounce states.
--
-- 0006 shipped a single placeholder `alert_sent` that no logic ever read or wrote.
-- Here we DROP it and add one debounce flag PER trigger. The debounce DECISION is a
-- pure app function (scheduler/policy.ts evaluateAlert); these columns are just its
-- persisted state, written like the counters: claimed pre-cycle (read back via
-- record_heartbeat's `returning *`), recomputed post-cycle, and stored by finish_run.
--
-- How to apply: paste into the Supabase SQL editor and Run. No data migration — the
-- new flags default to false (re-armed), which is the correct cold-start state.

-- ─────────────────────────────────────────────────────────────────────────────
-- bot_state: replace the unused single flag with one debounce flag per trigger.
alter table public.bot_state
  drop column if exists alert_sent,
  add column if not exists floor_alert_sent   boolean not null default false,
  add column if not exists failure_alert_sent boolean not null default false;

comment on column public.bot_state.floor_alert_sent is
  'Debounce flag for the overheating alert (floor_delay_streak ≥ threshold). True = already alerted while above; re-armed (false) once the streak drops back.';
comment on column public.bot_state.failure_alert_sent is
  'Debounce flag for the degraded alert (consecutive_failures ≥ threshold). True = already alerted while above; re-armed (false) once the failures reset.';

-- ─────────────────────────────────────────────────────────────────────────────
-- finish_run(): unchanged in spirit — reschedule + release + mark the run done in
-- ONE transaction, guarded by the fencing token. We only ADD two parameters that
-- it writes as PLAIN ASSIGNMENTS alongside the counters (NO new logic in this
-- safety-critical function; the debounce decision is made in the app). A reclaimed
-- run still can't clobber the flags — they ride the same `run_token` fencing guard.
--
-- The argument list changes, so we must DROP the old 10-arg version first (a bare
-- `create or replace` would leave a stale overload). Dropping also drops its grants,
-- which we re-apply below for the new 12-arg signature.
drop function if exists public.finish_run(
  uuid, bigint, integer, integer, integer, boolean, text, bigint, integer, text
);

-- create OR REPLACE for the new 12-arg version: after the drop above it simply
-- creates, and a re-run of this migration replaces in place (idempotent, like 0006).
create or replace function public.finish_run(
  p_run_token            uuid,
  p_run_id               bigint,
  p_delay_minutes        integer,
  p_consecutive_failures integer,
  p_floor_delay_streak   integer,
  p_succeeded            boolean,
  p_outcome              text,
  p_decision_id          bigint,
  p_missed_beats         integer,
  p_detail               text,
  p_floor_alert_sent     boolean,
  p_failure_alert_sent   boolean
)
returns boolean
language plpgsql
as $$
declare
  v_lock_held boolean;
begin
  -- Reschedule + release bot_state ONLY if we still own the lock (the fencing
  -- token). If our run overran and was reclaimed, we must NOT clobber the state —
  -- the reclaiming run owns rescheduling AND its own alert evaluation.
  update public.bot_state
     set next_check_at        = now() + make_interval(mins => p_delay_minutes),
         run_token            = null,
         locked_until         = null,
         last_success_at      = case when p_succeeded then now() else last_success_at end,
         consecutive_failures = p_consecutive_failures,
         floor_delay_streak   = p_floor_delay_streak,
         floor_alert_sent     = p_floor_alert_sent,
         failure_alert_sent   = p_failure_alert_sent,
         updated_at           = now()
   where id = 1
     and run_token = p_run_token;

  v_lock_held := found;

  -- ALWAYS close the history row. The run DID finish its cycle; on the fencing
  -- path it just lost the lock — that is NOT a crash, so don't leave it 'running'
  -- (that label is reserved for runs that truly never came back). Record the
  -- lock-lost in the detail, and only stamp next_check_at when we actually
  -- rescheduled.
  update public.scheduler_runs
     set finished_at   = now(),
         status        = 'completed',
         outcome       = p_outcome,
         decision_id   = p_decision_id,
         missed_beats  = p_missed_beats,
         next_check_at = case when v_lock_held then now() + make_interval(mins => p_delay_minutes) else null end,
         detail        = case
                           when v_lock_held then p_detail
                           else coalesce(p_detail || ' | ', '') ||
                                'lock lost/overran: reclaimed by another beat; this run did not reschedule bot_state'
                         end
   where id = p_run_id;

  return v_lock_held;  -- true = we held the lock (normal); false = fencing (reclaimed)
end;
$$;

-- Re-apply the lockdown for the NEW signature (the drop above removed the old
-- grants). New functions grant EXECUTE to PUBLIC by default; revoke that and grant
-- it back ONLY to service_role — anon/authenticated then can't call it at all.
revoke execute on function public.finish_run(
  uuid, bigint, integer, integer, integer, boolean, text, bigint, integer, text, boolean, boolean
) from public;
grant execute on function public.finish_run(
  uuid, bigint, integer, integer, integer, boolean, text, bigint, integer, text, boolean, boolean
) to service_role;
