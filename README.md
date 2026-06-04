# crypto-buddy

Autonomous crypto trading bot — work in progress. The guiding principle is
**the AI proposes, the code disposes**: a model suggests a target allocation,
deterministic code decides what to do with it. The AI never places orders.

So far it has four bricks:

1. A **read-only market data engine** — connects to Binance and builds a
   structured "market context" object (prices, indicators, reference levels,
   balances) for a configurable list of pairs.
2. A **Supabase persistence layer** — caches the rarely-changing ATH/ATL.
3. An **LLM decision layer** — at each wake-up, sends the context to Claude,
   gets back a target allocation + reasoning, validates it, and journals it.
4. An **execution layer — the economic brain (dry-run / paper trading)** —
   the bot runs its own virtual portfolio valued at real prices, shows it to
   the AI, bounds the AI's allocation to hard risk caps, and computes the
   movements to get there. It journals **modeled** fills so the portfolio
   evolves, but places **no real orders** yet (that's the next brick).

Still **no real orders**: the execution brick is paper trading only.

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

## Decision layer (the brain)

`npm run decide` runs one **wake-up**: build the market context, ask Claude for
a target allocation, validate it, and journal everything to the `decisions`
table (one row per wake-up). **Decide-and-log only — no orders are placed**, and
the allocation guardrails (position caps, max deployed) belong to the later
execution brick, where they'll gate real orders.

**What the model is told.** A frozen system prompt (the mandate, versioned as
`prompt_version`) sets a balanced, disciplined temperament — protect capital
first, act rarely but well — around five principles: doing nothing is the
default; enter/exit in steps; reference levels are the compass (accumulate
toward lows, lighten toward highs); a trade must beat fees + spread; stay
consistent with past decisions and keep small caps on a shorter leash. The
user message carries the volatile data: the allowed assets, the market context,
and the last few decisions (for coherence and to fill `what_changed`).

**What the model returns** — strict JSON, enforced by Anthropic structured
outputs and re-validated in code:

```json
{
  "target_allocation": { "BTC": 20, "ETH": 15, "USDT": 65 },
  "action_type": "rebalance",
  "what_changed": "short note",
  "confidence": "medium",
  "market_state": "range",
  "reasoning": "longer free text",
  "next_delay_minutes": 60
}
```

Validation: `target_allocation` keys are **exactly** this cycle's allocatable
universe — the base assets of the tradable pairs that **actually returned data
this cycle**, plus the reserve stable (always allocatable). It is derived from
the live context, not from config: if the data engine dropped a pair (no
price/indicators), that asset is **not** offered to the model — same spirit as
the skip rule, so we never journal a `decided` on an asset we know nothing
about. The reserve stable is **USDT** (the quote we actually hold and trade
against on the testnet), not the USDC shown in early drafts. Reference/watchlist
assets (SOL, BNB) are context only and can never appear — the structured-output
schema fixes the keys, so the model can't even emit them. Percentages must sum
to 100 (small rounding tolerance), each ≥ 0; `next_delay_minutes` is clamped by
code to `[15, 240]` (raw value kept in `requested_delay_minutes`, clamped in
`applied_delay_minutes`).

**Four outcomes** (the row's `status`):

- `decided` — valid response; the full decision is stored.
- `parse_failed` — the model answered, but the output didn't parse or violated
  the schema/rules; the raw response is stored, no decision is made, clear error.
- `error` — the LLM **call itself** failed (API down, rate-limited, 5xx). This
  is distinct from `parse_failed`: the model never answered. The error detail is
  stored (in `raw_response`) and logged; no decision is made.
- `skipped` — no tradable pair returned usable data; the LLM is **not** called
  (the AI never decides on an empty universe), `skip_reason` is set, critical log.

**Resilience.** A missing `ANTHROPIC_API_KEY` is a configuration error, not a
status: the run exits hard (non-zero) up front. Transient API failures become
`error` rows instead of crashing. If Supabase is down, the decision is still
produced and printed — it just isn't journaled, and a warning says so.

### Applying the migration

Same flow as brick 2: paste
[`supabase/migrations/0002_decisions.sql`](supabase/migrations/0002_decisions.sql)
into the Supabase **SQL Editor** and **Run**. RLS is enabled with no policies
(deny-all), same posture as the cache table.

## Execution layer (the economic brain)

The decision cycle now runs a **dry-run / paper-trading** economic brain. No
real orders are placed; the bot computes (and journals as *modeled* fills) what
it *would* do.

**Sovereign capital, not the testnet basket.** The testnet account is inflated
(~$76k fake) and resets monthly, so it's ignored as an economic source of
truth. The bot manages its own **virtual portfolio** seeded with
`STARTING_CAPITAL_USD` (default $500), valued at the **real** market prices we
already fetch.

**One source of truth: the `executions` journal.** The whole portfolio — cash,
positions, weighted-average cost, equity, deployed %, realized/unrealized P&L —
is **derived live** by replaying the append-only journal. There's no positions
table kept in parallel (duplicated state always drifts). Money is exact
`numeric` end to end (`decimal.js`), never float.

- **Weighted-average cost.** A buy blends the average cost with the buy price
  (fees excluded from cost basis); a sell realizes P&L and leaves the average
  untouched. Unrealized = `qty·(price − avgCost)`; realized is derived as
  `(equity − capital) − unrealized`, which makes every fee fall out as a
  realized cost with no double-counting.
- **Fees** are modeled (`FEE_PERCENT`, default 0.1% per movement).

**Risk wrapper — the AI proposes, the code disposes.** After the AI answers, the
code bounds the allocation to hard caps and writes the result onto the decision
(`applied_allocation`, `clamped`, `clamp_reason`). Every overage is "too much
risk", so the surplus always goes to **cash** (USDT), never to another coin:

- at most **35%** per large-cap (BTC, ETH);
- at most **15%** per small-cap (more volatile, shorter leash — dormant until a
  small cap is added);
- at least **30%** in cash — sacred capital protection.

Caps are configurable per coin class in [`src/config/index.ts`](src/config/index.ts).

**Dry-run movements.** The cycle computes the buys/sells to move from the
current book to the bounded allocation, sized on equity at real prices, prints
them, and journals them as modeled fills (`validation_status='executed'`,
`exchange_*` null) so the portfolio evolves next cycle. **No Binance order is
placed** — that, plus validation against the exchange's real filters
(min-notional, lot size), is the next brick (PR B).

### Applying the migrations

Paste each into the Supabase **SQL Editor** and **Run**, in order:
[`0003_executions.sql`](supabase/migrations/0003_executions.sql) (the execution
journal) and
[`0004_extend_decisions.sql`](supabase/migrations/0004_extend_decisions.sql)
(the bounded-allocation columns). Both follow the same RLS-deny-all posture.

## Setup

```sh
# 1. Install dependencies
npm install

# 2. Create your testnet API keys at https://testnet.binance.vision/
#    Permissions: enable spot trading + account read.

# 3. Copy the env template and fill in your keys
cp .env.example .env
#   edit .env with your BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET

# 4. (Optional but recommended) Set up Supabase persistence and apply the
#    migrations in order (SQL Editor → New query → Run):
#    - 0001_ath_atl_cache.sql     (ATH/ATL cache)
#    - 0002_decisions.sql         (decision journal)
#    - 0003_executions.sql        (execution journal — virtual portfolio)
#    - 0004_extend_decisions.sql  (bounded-allocation columns)
#    - add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to .env
#    Without these, `npm start` still runs; `npm run decide` still decides and
#    paper-trades but won't journal (the portfolio stays at 100% cash).

# 5. (For the decision layer) Add your Anthropic API key to .env:
#    - ANTHROPIC_API_KEY=sk-ant-...   (required for `npm run decide`)
#    - ANTHROPIC_MODEL is optional (defaults to claude-haiku-4-5)

# 6. (Optional) Tune the economic brain in .env:
#    - STARTING_CAPITAL_USD (default 500), FEE_PERCENT (default 0.1)
```

## Run

```sh
npm start         # brick 1-2: build + print the market context
npm run decide    # bricks 3-4: one wake-up — decide, bound to caps, paper-trade
```

`npm start` prints a formatted summary per pair, your testnet balances, then the
raw JSON of the full context. `npm run decide` runs a full cycle: it prints the
AI's proposed allocation and reasoning, then the **virtual portfolio**, the
**risk-wrapper** result (proposed vs applied), and the **dry-run movements** it
would make (journaled as modeled fills — no real order).

## Type check & tests

```sh
npm run typecheck
npm test          # money invariants (e.g. cash floor holds after fees, any rebalance)
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
- `decision` — `defaultModel` (overridden by `ANTHROPIC_MODEL`), `maxTokens`,
  `recentDecisionsToLoad`, delay bounds (`minDelayMinutes` / `maxDelayMinutes`),
  and `allocationTolerancePercent`.
- `execution` — `startingCapitalUsd` (env `STARTING_CAPITAL_USD`), `feePercent`
  (env `FEE_PERCENT`), the per-class `caps` (big / small / `minCashPercent`), and
  `coinClass` (tag a coin `big`/`small`; unlisted defaults to `small`).

The set of balance-tracked assets — and the AI's allocation universe — are both
derived from `tradablePairs` via `tradableAssets()`; there's no separate asset
list to maintain. The core code never needs to be touched to add a pair or tune
an indicator.

## Project layout

```
src/
├── index.ts                 # brick 1-2 entry — build + print market context
├── decide.ts                # brick 3 entry — one decision wake-up
├── config/index.ts          # pairs, timeframes, indicators, cache + decision tuning
├── exchanges/binance.ts     # public mainnet + authenticated testnet clients
├── market/
│   ├── klines.ts            # candle + ticker fetch
│   ├── indicators.ts        # RSI / SMA / EMA snapshot
│   └── levels.ts            # month / year / ATH-ATL (isolated extremesOf)
├── account/balances.ts      # testnet balances, filtered to tradable assets
├── money.ts                 # exact-decimal helpers (decimal.js) — money, never float
├── persistence/
│   ├── supabase.ts          # service-role client factory (null if unset)
│   ├── athAtlCache.ts       # ATH/ATL seed / maintain / fallback logic
│   ├── decisions.ts         # load recent + insert decision rows (resilient)
│   └── executions.ts        # execution journal: load ledger + insert modeled fills
├── portfolio/
│   └── derive.ts            # derive the virtual portfolio + weighted-avg P&L from the journal
├── risk/
│   └── clamp.ts             # risk wrapper: bound allocation to caps (surplus → cash)
├── execution/
│   ├── movements.ts         # dry-run movement sizing + modeled fills
│   └── print.ts             # portfolio / clamp / movements output
├── context/
│   ├── build.ts             # assembles MarketContext
│   └── print.ts             # human-readable context output
└── decision/
    ├── schema.ts            # structured-output schema + business validation
    ├── prompt.ts            # frozen mandate v2 (caps + portfolio) + per-run user prompt
    ├── context.ts           # decision context: portfolio in place of testnet balances
    ├── llm.ts               # Anthropic client, structured call, token/latency capture
    ├── gitSha.ts            # commit SHA for traceability (env → git → null)
    ├── decide.ts            # orchestrator: derive → decide → clamp → movements → journal
    └── print.ts             # human-readable decision output

supabase/
└── migrations/
    ├── 0001_ath_atl_cache.sql     # versioned cache table + RLS
    ├── 0002_decisions.sql         # decision journal table + RLS
    ├── 0003_executions.sql        # execution journal (virtual portfolio source of truth)
    └── 0004_extend_decisions.sql  # bounded-allocation columns on decisions
```

## Coming next (not in this brick)

- **PR B — real execution.** Place the movements as real testnet orders, fill
  the `exchange_*` columns with the real fill, and validate against the
  exchange's filters (min-notional, lot size) before placing.
- Scheduler: wake the bot on a cadence (using `applied_delay_minutes`) and send
  real alerts (Telegram). For now an alert is just a critical log line.
- More persistence: portfolio snapshots, bot state.
