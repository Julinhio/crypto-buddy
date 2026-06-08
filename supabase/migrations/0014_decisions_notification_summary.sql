-- Migration 0014 — decisions: notification_summary
--
-- A SHORT, phone-friendly one-liner the model writes ALONGSIDE its verbose
-- what_changed / reasoning: the "why" line for the activity Telegram notification
-- (a notif on every wake-up that actually placed orders). The existing fields are
-- complete but verbose (prices, RSI, several sentences); this is the crisp
-- justification a mobile notification needs.
--
-- Nullable on purpose: legacy rows predate it (NO backfill — a full reset follows
-- this PR), and the CODE is the real guard — validateDecision requires it non-empty
-- on every new `decided` row (strict structured output), so the model always
-- produces it. It is deliberately NOT added to the decisions_decided_complete CHECK
-- (that would reject the legacy rows); same "code disposes" posture as the rest.
--
-- How to apply: paste into the Supabase SQL editor (Dashboard → SQL Editor → New
-- query → Run) BEFORE deploying the code that writes it (the project's hard rule).

alter table public.decisions
  add column if not exists notification_summary text;

comment on column public.decisions.notification_summary is
  'Short (~1-2 sentences) plain-language summary of the decision, written by the model for the activity Telegram notification — distinct from the verbose what_changed/reasoning. Nullable (legacy rows / no backfill); required in code on every new decided row.';
