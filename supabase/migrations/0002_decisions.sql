-- Migration 0002 — decisions
--
-- One row per bot wake-up: the AI's proposed target allocation + reasoning, the
-- full context it saw, and traceability. This layer DECIDES and LOGS only —
-- it places no orders and reads trading state only (the "AI proposes, code
-- disposes" split; execution + guardrails come in a later brick).
--
-- How to apply: paste this file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → Run). See README → Decision layer.

create table if not exists public.decisions (
  -- Identity
  id                       bigint generated always as identity primary key,
  created_at               timestamptz not null default now(),

  -- Wake-up status
  status                   text not null
                             check (status in ('decided', 'skipped', 'parse_failed')),
  skip_reason              text,              -- set only when status = 'skipped'

  -- The decision produced by the AI. NULL unless status = 'decided', because a
  -- skipped / parse_failed wake-up has no valid allocation (see the CHECKs below).
  target_allocation        jsonb,             -- e.g. {"BTC": 20, "ETH": 15, "USDT": 65}
  action_type              text
                             check (action_type is null
                               or action_type in ('hold', 'rebalance', 'de_risk', 'rotate')),
  what_changed             text,              -- what changed since the last decision
  confidence               text
                             check (confidence is null
                               or confidence in ('low', 'medium', 'high')),
  market_state             text
                             check (market_state is null
                               or market_state in ('trend', 'range', 'high_vol', 'risk_off')),
  reasoning                text,              -- full human-readable rationale
  requested_delay_minutes  double precision,  -- raw delay the AI asked for
  applied_delay_minutes    integer,           -- delay after code clamps it to [15, 240]

  -- What the AI saw — the "tape" to replay a decision later. Always stored,
  -- including for skipped / parse_failed wake-ups.
  market_context           jsonb not null,

  -- Traceability
  model                    text,              -- model that decided (NULL if no LLM call)
  prompt_version           text not null,     -- versioned mandate, e.g. 'v1'
  git_sha                  text,              -- commit that produced the decision (NULL if unknown)
  raw_response             text,              -- raw LLM text before parsing (debug parse failures)
  latency_ms               integer,           -- LLM call duration
  input_tokens             integer,           -- cost is recomputed later from token counts
  output_tokens            integer,

  -- Integrity: a 'decided' row must carry a complete decision; a 'skipped' row
  -- must carry a reason. Defense in depth alongside the code-side validation.
  constraint decisions_decided_complete check (
    status <> 'decided' or (
      target_allocation is not null and
      action_type is not null and
      what_changed is not null and
      confidence is not null and
      market_state is not null and
      reasoning is not null and
      requested_delay_minutes is not null and
      applied_delay_minutes is not null
    )
  ),
  constraint decisions_skipped_has_reason check (
    status <> 'skipped' or skip_reason is not null
  )
);

-- Fast "latest N decisions" reads.
create index if not exists decisions_created_at_idx
  on public.decisions (created_at desc);

comment on table public.decisions is
  'One row per bot wake-up: AI target allocation + reasoning, the context seen, and traceability. Decide-and-log only — no orders placed in this layer.';

-- Row Level Security: ENABLED with NO policies (deny-all), same posture as the
-- ATH/ATL cache. The backend uses the service role key, which bypasses RLS;
-- any anon/public key is denied all access.
alter table public.decisions enable row level security;
