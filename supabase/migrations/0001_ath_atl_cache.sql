-- Migration 0001 — ATH/ATL cache
--
-- One row per pair caching the all-time high / all-time low. The value is
-- seeded once from the long historical (weekly) series, then maintained from
-- the live price + recent daily candle extremes — so the long series is no
-- longer re-fetched on every run. See src/persistence/athAtlCache.ts.
--
-- Read-only market data only. No trading state, no decisions, no orders here.
--
-- How to apply: paste this file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → Run), or run it via the Supabase CLI
-- (`supabase db push`). See README → Persistence.

create table if not exists public.ath_atl_cache (
  symbol             text             primary key,        -- e.g. 'BTC/USDT'
  ath_price          double precision not null,           -- all-time high price
  ath_at             timestamptz      not null,           -- candle date of the ATH
  atl_price          double precision not null,           -- all-time low price
  atl_at             timestamptz      not null,           -- candle date of the ATL
  source_timeframe   text             not null,           -- seed series timeframe, e.g. '1w'
  source_candles     integer          not null,           -- seed series length
  seeded_at          timestamptz      not null default now(),  -- last FULL seed from long series
  updated_at         timestamptz      not null default now(),  -- last touch (seed or live/daily bump)
  last_update_source text             not null default 'seed'  -- 'seed' | 'reseed' | 'live' | 'daily'
);

comment on table public.ath_atl_cache is
  'Per-pair ATH/ATL cache. Seeded from the long historical series, then maintained from live price + recent daily extremes. Read-only market data — no trading state.';

-- Row Level Security: ENABLED with NO policies.
--
-- The backend connects with the service role key, which bypasses RLS, so it
-- keeps full read/write access. Any other key (anon/public) does NOT bypass
-- RLS and, with no policy granting access, is denied everything. This is the
-- secure default for a single-user, server-side backend: the cache is only
-- reachable with the server-side service key.
alter table public.ath_atl_cache enable row level security;
