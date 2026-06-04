-- Migration 0003 — executions (execution journal)
--
-- The SINGLE source of truth for the virtual portfolio: an append-only log of
-- every asset movement. The portfolio (cash, positions, average cost, equity,
-- deployed %, realized/unrealized P&L) is DERIVED live from this log — we never
-- keep a positions table in parallel (duplicated state always drifts).
--
-- One row per movement, describing its FULL lifecycle, not just an order. In
-- this brick (PR A) rows are MODELED fills (paper trading, no Binance order);
-- PR B will fill the exchange_* columns with the real testnet fill.
--
-- ALL money is exact `numeric`, never float. How to apply: paste into the
-- Supabase SQL editor and Run. See README → Execution layer.

create table if not exists public.executions (
  -- Link
  id                   bigint generated always as identity primary key,
  created_at           timestamptz not null default now(),
  decision_id          bigint not null references public.decisions (id),

  -- The economic movement
  symbol               text    not null,                       -- trading pair, e.g. 'BTC/USDT'
  side                 text    not null check (side in ('buy', 'sell')),
  requested_qty        numeric not null,                        -- base qty the brain wanted
  rounded_qty          numeric,                                 -- after exchange step rounding (PR B)
  executed_qty         numeric,                                 -- exchange fill (PR B); modeled = requested in PR A
  valuation_price      numeric not null,                        -- REAL market price used to value (not testnet price)
  price_source         text    not null,                        -- e.g. 'binance-public-mainnet'
  fee                  numeric not null,                        -- modeled fee, in quote (USDT)

  -- The ledger effect: what ACTUALLY moved our virtual book (stored explicitly).
  -- On testnet/paper this is the wanted qty at the REAL price + modeled fee;
  -- with real money it'll be the real fill. Derivation reads these directly.
  ledger_base_delta    numeric not null,                        -- signed base qty (+ buy / − sell)
  ledger_quote_delta   numeric not null,                        -- signed USDT delta, NET of fee

  -- Validation (the concept deferred from brick 3 lands here)
  validation_status    text    not null
                         check (validation_status in ('executed', 'rejected', 'failed')),
  validation_reason    text,

  -- The testnet order journal (filled in PR B; null here)
  exchange_order_id    text,
  exchange_status      text,
  exchange_error_code  text,
  raw_response         jsonb
);

create index if not exists executions_decision_id_idx on public.executions (decision_id);
create index if not exists executions_created_at_idx on public.executions (created_at);

comment on table public.executions is
  'Append-only execution journal — the single source of truth the virtual portfolio is derived from. One row per asset movement, full lifecycle. No orders placed in PR A (modeled fills); exchange_* filled in PR B.';

-- RLS: enabled, no policies (deny-all) — service role bypasses, anon denied.
-- Same posture as the cache and decisions tables.
alter table public.executions enable row level security;
