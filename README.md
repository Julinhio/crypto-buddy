# crypto-buddy

Autonomous crypto trading bot — work in progress.

So far it is a **read-only market data engine** with a **Supabase persistence
layer**. It connects to Binance, builds a structured "market context" object
for a configurable list of pairs, caches the rarely-changing ATH/ATL in
Supabase, and prints the context to the console for visual inspection. No LLM
call, no orders, no trading logic yet.

## What it does

Pairs are split into two families, kept strictly separate in the context:

- **Tradable** (default: `BTC/USDT`, `ETH/USDT`) — the bot may take positions
  on these later, under risk guardrails. Their base assets are balance-tracked.
- **Reference** watchlist (default: `SOL/USDT`, `BNB/USDT`) — priced and
  analyzed for market context only, **never traded, never allocated, no
  balance tracked**.

For every pair in **both** families:

- Pulls the current spot price and a primary candle series (default: 500 × 1d)
  from the **public Binance mainnet** endpoint — real market data, no API key
  needed.
- Computes a snapshot of indicators in code: RSI(14), SMA(50), SMA(200),
  EMA(21) — via `technicalindicators`.
- Computes price levels: month high/low, year high/low, and ATH/ATL served
  from the cache (see [Persistence](#persistence-ath--atl-cache)).

It also reads the authenticated **Binance testnet** account, keeping only the
**relevant balances** — the quote currency (USDT) and the base assets of
tradable pairs. The testnet seeds hundreds of unrelated assets; everything
outside that allowlist is filtered out. Reference-watchlist assets are never
balance-tracked.

Market data comes from mainnet on purpose (the testnet has synthetic
prices); only the account side is sandboxed.

Everything is assembled into one `MarketContext` object, printed in a
human-readable summary plus raw JSON.

## Persistence (ATH / ATL cache)

ATH/ATL barely moves, yet recomputing it means pulling a long weekly history.
Doing that every run is wasteful, so it is **cached in Supabase** (one row per
pair) and the long series is fetched only when needed:

- **No entry yet** (first pass / new pair) → fetch the long weekly series,
  compute ATH/ATL, store it. This is the only time the long series is pulled.
- **Entry present** → read it, and push it **only** if a new extreme appears.
  The maintenance signal is the live price **plus the high/low of recent daily
  candles** (already fetched for indicators). Because a daily candle records
  its day's true intraday high/low, an intraday spike that reverted between two
  runs is still captured — no extra request.
- **Safety re-seed** → if an entry is older than `cache.stalenessDays`
  (default 30), it is re-seeded fully from the long series. This window is
  aligned with `cache.maintenanceLookbackCandles` (default 30 daily candles):
  any downtime longer than the lookback triggers a full recompute, so no
  extreme can be lost for good.

The `allTime` field of the context is tagged with its origin — `seed`,
`reseed`, `cache`, `bumped`, or `fallback` — visible in the printed output
(e.g. `[460 × 1w · cache]`).

**Resilience:** the cache is an optimization, never a single point of failure.
If Supabase is unconfigured or unreachable, the bot logs a warning and falls
back to computing ATH/ATL from the long series for that run — exactly the
pre-cache behavior.

### Applying the migration

The schema is versioned in
[`supabase/migrations/0001_ath_atl_cache.sql`](supabase/migrations/0001_ath_atl_cache.sql).
To apply it: open the Supabase dashboard → **SQL Editor** → **New query**,
paste the file's contents, and **Run**. (The same file also works with the
Supabase CLI via `supabase db push` if you adopt it later.)

The table has **RLS enabled with no policies**: the backend reaches it with
the service role key (which bypasses RLS), while any anon/public key is denied
— the secure default for a single-user server-side backend.

## Setup

```sh
# 1. Install dependencies
npm install

# 2. Create your testnet API keys at https://testnet.binance.vision/
#    Permissions: enable spot trading + account read.

# 3. Copy the env template and fill in your keys
cp .env.example .env
#   edit .env with your BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET

# 4. (Optional but recommended) Set up Supabase persistence:
#    - create a project at https://supabase.com
#    - apply supabase/migrations/0001_ath_atl_cache.sql (see Persistence above)
#    - add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to .env
#    Without these, the bot still runs and computes ATH/ATL each run.
```

## Run

```sh
npm start
```

You should see a formatted summary per pair, followed by your testnet
balances, followed by the raw JSON of the full context object.

## Type check only

```sh
npm run typecheck
```

## Configuration

All knobs live in [`src/config/index.ts`](src/config/index.ts):

- `tradablePairs` — pairs the bot may allocate. Add one by appending a string
  (e.g. `'SOL/USDT'`); its base asset is automatically balance-tracked.
- `referencePairs` — context-only watchlist. Add one to enrich the market
  read without ever trading or tracking it.
- `primaryTimeframe` / `primaryLimit` — series used for indicators and
  month/year levels.
- `longTermTimeframe` / `longTermLimit` — series used to seed ATH/ATL.
- `indicators` — RSI period, list of SMA periods, list of EMA periods.
- `cache` — `stalenessDays` (re-seed threshold) and
  `maintenanceLookbackCandles` (recent daily candles scanned for new extremes).

The set of balance-tracked assets is derived from `tradablePairs` via
`tradableAssets()` — no separate asset list to maintain. The core code never
needs to be touched to add a pair or tune an indicator.

## Project layout

```
src/
├── index.ts                 # entry point
├── config/index.ts          # pairs, timeframes, indicators, cache tuning
├── exchanges/binance.ts     # public mainnet + authenticated testnet clients
├── market/
│   ├── klines.ts            # candle + ticker fetch
│   ├── indicators.ts        # RSI / SMA / EMA snapshot
│   └── levels.ts            # month / year / ATH-ATL (isolated extremesOf)
├── account/balances.ts      # testnet balances, filtered to tradable assets
├── persistence/
│   ├── supabase.ts          # service-role client factory (null if unset)
│   └── athAtlCache.ts       # ATH/ATL seed / maintain / fallback logic
└── context/
    ├── build.ts             # assembles MarketContext
    └── print.ts             # human-readable console output

supabase/
└── migrations/
    └── 0001_ath_atl_cache.sql   # versioned cache table + RLS
```

## Coming next (not in this brick)

- LLM decision step: send `MarketContext` + portfolio target spec to a model.
- Execution layer: place orders on testnet to reach the target allocation,
  with hard-coded risk guardrails.
- More persistence: decision journal, orders, portfolio snapshots, bot state
  (deliberately **not** created yet — this brick adds only the connection and
  the ATH/ATL cache).
