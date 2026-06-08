-- Migration 0013 — executions idempotency key
--
-- The last hard guard before real capital: a decided movement can be BOOKED into
-- the sovereign ledger and PLACED as a real order AT MOST ONCE, even if the same
-- decision's execution is replayed (a resend after a network timeout, a re-entered
-- executeMovements). Today the bot never replays a decision in production, so this
-- is a dormant-but-correct safety net + the exchange-side guard that graduates the
-- testnet path toward real money (see migration 0005 / README → Replay safety).
--
-- ONE deterministic key per (decision, movement): cb_<decision_id>_<symbol>_<side>
-- (one movement per asset+side per decision → stable, collision-free). The SAME
-- string is the ledger dedup key AND the order's clientOrderId, so the two faces —
-- the ledger booking and the real order — share one identity by construction.
--
-- SCOPE. This closes the SAME-decision replay. The cross-decision orphan/reclaimer
-- race (two DIFFERENT decision_ids → two different keys) is NOT closed by this key:
-- it stays covered by the booking-first model (the reclaimer re-derives from the
-- already-booked ledger and never repeats — README → Replay safety) plus the beat
-- watchdog (a follow-up PR) for the residual duplicate ORDER in the pre-booking
-- window. Real capital wants this key AND that watchdog, together.
--
-- How to apply: paste into the Supabase SQL editor (Dashboard → SQL Editor → New
-- query → Run) BEFORE deploying the code that writes the key — the project's hard
-- rule. No backfill: existing rows keep idempotency_key = NULL (historical, never
-- replayed). NULLs are DISTINCT under the unique index below, so they never
-- conflict — and only BOOKED sovereign intents set the key (rejected intents and
-- execution traces leave it NULL), which is why a transient rejection can never
-- poison a movement's key and block its later real booking.

alter table public.executions
  add column if not exists idempotency_key text;

-- A FULL unique index (NOT partial): ON CONFLICT (idempotency_key) infers a full
-- index cleanly, which is what the booking upsert (resolution=ignore-duplicates)
-- relies on — a partial `WHERE idempotency_key IS NOT NULL` index would NOT be
-- inferred without repeating the predicate, which the client can't express. The
-- default NULLS-DISTINCT semantics make this safe anyway: every NULL row (old
-- rows, rejected intents, execution traces) is exempt, only non-null keys dedupe.
create unique index if not exists executions_idempotency_key_uq
  on public.executions (idempotency_key);

comment on column public.executions.idempotency_key is
  'Deterministic per-(decision, movement) idempotency key (cb_<decision_id>_<symbol>_<side>). Set ONLY on booked sovereign intents; NULL on rejected intents and execution traces. Unique (NULLs exempt): a replay of the same decision''s booking hits ON CONFLICT DO NOTHING (one book), and the SAME string is the order''s clientOrderId (one real order). Closes the same-decision replay; the cross-decision race stays on booking-first + the beat watchdog. Real-money guard.';
