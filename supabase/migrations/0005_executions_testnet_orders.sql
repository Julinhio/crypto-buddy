-- Migration 0005 — executions: real testnet orders (the four states)
--
-- PR A modeled the fills (paper trading, no Binance order). PR B places the
-- movement as a REAL testnet order between the sovereign calculation and its
-- journaling, to prove our movements are technically executable on the exchange.
--
-- The journal now distinguishes FOUR states that PR A conflated:
--   1. WANTED    — the sovereign movement, sized at REAL (mainnet) prices.
--   2. SUBMITTED — what we managed to send to the testnet.
--   3. ACCEPTED  — what the exchange validated (filters OK).
--   4. EXECUTED  — what actually filled (full / partial / nothing).
--
-- It does this with TWO event rows per movement (append-only, never rewritten):
--
--   • event_type='intent'    — the SOVEREIGN booking (state 1). Carries the
--     ledger_* deltas and is the ONLY row that mutates the virtual portfolio.
--     Written BEFORE the exchange call. validation_status records the SOVEREIGN
--     validation (against the REAL mainnet filters, the authoritative one):
--       - 'executed' → passed, booked into the ledger;
--       - 'rejected' → a crumb (below the real min-notional / minQty): a clean
--                      no-op, NOT booked (ledger_* = 0), no order sent;
--       - 'failed'   → an unexpected block (e.g. qty > maxQty): NOT booked.
--
--   • event_type='execution' — the TESTNET trace (states 2-3-4). Written AFTER
--     the exchange responds. ledger_* = 0 (NEVER touches the book — the testnet
--     has bogus prices and is not an accounting source of truth). Links back to
--     its intent via intent_execution_id.
--
-- Crash safety: intent (durable) → order → execution (trace). A crash between
-- the writes leaves an intent with no trace = "wanted/booked, execution unknown"
-- — reconcilable, never a silent hole, and the next cycle re-sizes from the
-- already-updated book so a movement is never double-booked.
--
-- RLS is already enabled on the table (0003); nothing to change here.
-- How to apply: paste into the Supabase SQL editor and Run.

-- 1) Discriminate the two event kinds. default 'intent' keeps every existing
--    PR A modeled-fill row a (booked) intent, so the portfolio derives identically.
alter table public.executions
  add column if not exists event_type text not null default 'intent';

alter table public.executions drop constraint if exists executions_event_type_check;
alter table public.executions
  add constraint executions_event_type_check
  check (event_type in ('intent', 'execution'));

-- 2) The sovereign validation outcome only applies to intent rows. Relax NOT NULL
--    (execution rows leave it null and use execution_outcome instead), but require
--    it on intent rows. A NULL passes the existing enum check (NULL IN (...) is
--    unknown, which a CHECK treats as satisfied), so no extra enum change needed.
alter table public.executions alter column validation_status drop not null;

alter table public.executions drop constraint if exists executions_intent_has_validation_check;
alter table public.executions
  add constraint executions_intent_has_validation_check
  check (event_type <> 'intent' or validation_status is not null);

-- 3) The testnet execution trace (states 2-3-4). All nullable: an intent row
--    leaves them null; an execution row fills them from the testnet response.
alter table public.executions
  add column if not exists intent_execution_id bigint references public.executions (id),
  add column if not exists submitted_qty       numeric,   -- state 2: qty actually sent
  add column if not exists submitted_price      numeric,   -- the marketable LIMIT price sent
  add column if not exists time_in_force        text,      -- 'IOC' for the marketable limit
  add column if not exists exchange_avg_price   numeric,   -- avg fill price on testnet (trace only)
  add column if not exists execution_outcome    text;      -- normalized state 3/4 (see check below)

alter table public.executions drop constraint if exists executions_execution_outcome_check;
alter table public.executions
  add constraint executions_execution_outcome_check
  check (execution_outcome is null
         or execution_outcome in ('filled', 'partial', 'unfilled', 'rejected', 'error'));

-- 4) Indexes. The portfolio replay now filters event_type='intent' AND
--    validation_status='executed' — serve it without a filesort as the journal
--    grows. And one to reconcile a trace back to its intent.
create index if not exists executions_intent_status_id_idx
  on public.executions (event_type, validation_status, id);
create index if not exists executions_intent_execution_id_idx
  on public.executions (intent_execution_id);

comment on column public.executions.event_type is
  'Row kind: ''intent'' = the sovereign booking (carries ledger_*, mutates the book, written before the order); ''execution'' = the testnet trace (ledger_* = 0, written after the order, links to its intent via intent_execution_id).';
comment on column public.executions.execution_outcome is
  'Normalized testnet result on an execution row: filled / partial / unfilled / rejected (exchange refused) / error (call failed). Never affects the sovereign ledger.';
comment on column public.executions.intent_execution_id is
  'On an execution row, the id of the intent row it traces. Lets us reconcile wanted→submitted→accepted→executed after a crash.';
