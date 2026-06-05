-- Migration 0006 — scheduler (state machine + run-lock heartbeat)
--
-- The bot has a full, proven decision cycle (decide()), but it only runs on a
-- manual `npm run decide`. The scheduler makes it autonomous: a fixed external
-- cron (Railway, every 5 min — wired in a later PR) beats this entry point, and
-- a small STATE MACHINE WITH A LOCK decides, at each beat, whether to actually
-- run a cycle. This is also the run-lock that closes the PR #2 ATH/ATL cache race
-- (one run touches the cache at a time).
--
-- Two pieces, same append-only philosophy as `executions`:
--   - bot_state     : a SINGLETON row — next check, the run-lock, liveness, the
--                     backoff / overheating counters.
--   - scheduler_runs: an append-only history of every run attempt, for audit.
--
-- The atomicity of the claim lives HERE (in the DB), not in the app: a single
-- conditional UPDATE on the singleton row is the compare-and-set that guarantees
-- two overlapping beats never start two cycles. All time is UTC and compared to
-- the DATABASE's now(), never the app clock.
--
-- How to apply: paste into the Supabase SQL editor and Run. RLS deny-all on both
-- tables (service role bypasses, anon denied) — same posture as the rest.

-- ─────────────────────────────────────────────────────────────────────────────
-- State: one singleton row.
create table if not exists public.bot_state (
  id                    integer primary key default 1 check (id = 1),
  -- When the next cycle is due. NULL = due immediately (first run ever).
  next_check_at         timestamptz,
  -- The run-lock. run_token is the identity of the active run; locked_until is
  -- its expiry. Both NULL when idle. A claim sets both atomically.
  run_token             uuid,
  locked_until          timestamptz,
  -- Liveness: bumped on EVERY beat, even when no cycle runs.
  last_heartbeat_at     timestamptz,
  last_success_at       timestamptz,
  -- Backoff (hard errors) and overheating (consecutive floor-delay claims).
  consecutive_failures  integer     not null default 0,
  floor_delay_streak    integer     not null default 0,
  -- For the future alerting PR (anti-spam); maintained here, acted on later.
  alert_sent            boolean     not null default false,
  updated_at            timestamptz not null default now()
);

-- Seed the singleton (next_check_at NULL → the first beat runs immediately).
insert into public.bot_state (id) values (1) on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- History: append-only, one row per run attempt.
create table if not exists public.scheduler_runs (
  id            bigint generated always as identity primary key,
  run_token     uuid        not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  -- A run that crashes mid-cycle stays 'running' with finished_at NULL — which is
  -- exactly how you spot a crash at audit time. finish_run flips it to 'completed'.
  status        text        not null default 'running' check (status in ('running', 'completed')),
  outcome       text        check (outcome in ('decided', 'skip', 'error')),
  -- SET NULL (not the default RESTRICT): purging a decision row must never be
  -- blocked by, nor orphan, an audit row that merely references it.
  decision_id   bigint      references public.decisions (id) on delete set null,
  missed_beats  integer,
  next_check_at timestamptz,
  detail        text
);

create index if not exists scheduler_runs_run_token_idx on public.scheduler_runs (run_token);
create index if not exists scheduler_runs_started_at_idx on public.scheduler_runs (started_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- record_heartbeat(): liveness on EVERY beat. Returns the current state so the
-- app can log WHY it's about to no-op (not due vs locked) using DB time.
create or replace function public.record_heartbeat()
returns public.bot_state
language sql
as $$
  update public.bot_state set last_heartbeat_at = now() where id = 1 returning *;
$$;

-- claim_due_run(): the ATOMIC claim. A single conditional UPDATE on the singleton
-- is the compare-and-set — Postgres takes a row lock, so two concurrent claims
-- serialize and the loser re-evaluates its WHERE against the now-locked row →
-- 0 rows. On a win it also opens the history row. Returns the pre-claim counters
-- and DB now() the app needs; returns NO rows when not due or already locked.
create or replace function public.claim_due_run(
  p_run_token        uuid,
  p_lock_ttl_seconds integer
)
returns table (
  run_id               bigint,
  prev_next_check_at   timestamptz,
  db_now               timestamptz,
  consecutive_failures integer,
  floor_delay_streak   integer
)
language plpgsql
as $$
declare
  v_prev_next timestamptz;
  v_failures  integer;
  v_floor     integer;
  v_run_id    bigint;
begin
  update public.bot_state
     set run_token    = p_run_token,
         locked_until = now() + make_interval(secs => p_lock_ttl_seconds)
   where id = 1
     and (next_check_at is null or next_check_at <= now())                       -- due?
     and (run_token is null or locked_until is null or locked_until <= now())    -- free / expired?
   returning next_check_at, consecutive_failures, floor_delay_streak
        into v_prev_next, v_failures, v_floor;

  if not found then
    return;  -- not due, or a live lock exists → claim refused (no rows)
  end if;

  insert into public.scheduler_runs (run_token, started_at, status)
  values (p_run_token, now(), 'running')
  returning id into v_run_id;

  return query select v_run_id, v_prev_next, now(), v_failures, v_floor;
end;
$$;

-- finish_run(): reschedule + release + mark the run done, in ONE transaction.
-- The WHERE run_token = p_run_token is the FENCING TOKEN: a run whose lock expired
-- and was reclaimed by another beat CANNOT clobber the state — it returns false and
-- the reclaimer owns rescheduling. next_check_at is computed from the DB now() so
-- there is no app-clock drift. Rescheduling happens ONLY here, after the work.
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
  p_detail               text
)
returns boolean
language plpgsql
as $$
declare
  v_lock_held boolean;
begin
  -- Reschedule + release bot_state ONLY if we still own the lock (the fencing
  -- token). If our run overran and was reclaimed, we must NOT clobber the state —
  -- the reclaiming run owns rescheduling.
  update public.bot_state
     set next_check_at        = now() + make_interval(mins => p_delay_minutes),
         run_token            = null,
         locked_until         = null,
         last_success_at      = case when p_succeeded then now() else last_success_at end,
         consecutive_failures = p_consecutive_failures,
         floor_delay_streak   = p_floor_delay_streak,
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

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: enabled, no policies (deny-all). The functions are SECURITY INVOKER, so a
-- stray anon/authenticated call runs under deny-all and silently affects 0 rows
-- (no leak, no write); the service-role backend bypasses RLS and works normally.
alter table public.bot_state enable row level security;
alter table public.scheduler_runs enable row level security;

-- Beyond deny-all on the rows, lock down WHO may even invoke these functions.
-- New functions grant EXECUTE to PUBLIC by default; revoke that and grant it back
-- ONLY to service_role (the backend's key). anon/authenticated then can't call
-- them at all. The owner (postgres) keeps execute regardless — so the migration
-- itself is unaffected. Double-check after applying that the service key still
-- works (it runs as service_role, which is granted below).
revoke execute on function public.record_heartbeat() from public;
revoke execute on function public.claim_due_run(uuid, integer) from public;
revoke execute on function public.finish_run(
  uuid, bigint, integer, integer, integer, boolean, text, bigint, integer, text
) from public;

grant execute on function public.record_heartbeat() to service_role;
grant execute on function public.claim_due_run(uuid, integer) to service_role;
grant execute on function public.finish_run(
  uuid, bigint, integer, integer, integer, boolean, text, bigint, integer, text
) to service_role;

comment on table public.bot_state is
  'Singleton scheduler state: next check, run-lock (run_token + locked_until), liveness, backoff/overheating counters. Mutated only via the record_heartbeat / claim_due_run / finish_run functions.';
comment on table public.scheduler_runs is
  'Append-only history of run attempts. A row stuck at status=running with finished_at NULL is a crashed run.';
