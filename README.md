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
4. An **execution layer — the economic brain** — the bot runs its own virtual
   portfolio valued at real prices, shows it to the AI, bounds the AI's
   allocation to hard risk caps, and computes the movements to get there.
5. A **real testnet execution layer (PR B)** — between computing a movement and
   journaling it, the bot now **places the real order on the Binance testnet** to
   prove the movement is technically executable (filters OK, full technical path),
   and traces **four distinct states**: what we *wanted*, what we *submitted*,
   what the exchange *accepted*, and what actually *executed*. The testnet result
   never touches the accounting — the ledger stays driven by our own calculation
   at real prices.

The testnet is a **plumbing probe, not an accounting source of truth**: its
prices decouple from the real market, its basket is inflated and it resets
monthly. We book at real (mainnet) prices; the testnet only tells us whether an
order is executable.

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

**Movements.** The cycle computes the buys/sells to move from the current book to
the bounded allocation, sized on equity at real prices. These movements are the
**sovereign intention** — they decide *how much*, at real prices. The execution
layer (PR B, below) is what turns each into a real testnet order.

### Applying the migrations

Paste each into the Supabase **SQL Editor** and **Run**, in order:
[`0003_executions.sql`](supabase/migrations/0003_executions.sql) (the execution
journal) and
[`0004_extend_decisions.sql`](supabase/migrations/0004_extend_decisions.sql)
(the bounded-allocation columns). Both follow the same RLS-deny-all posture.

## Real testnet execution (PR B — the plumbing to the exchange)

Between computing a movement and journaling it, the bot now **places the real
order on the Binance testnet**. The goal is not to make money on the testnet
(its prices are bogus) — it's to **prove the order is executable** before real
money: that it passes the exchange's filters and the full technical path.

**The invariant is non-negotiable: the testnet never touches the accounting.**
The sovereign ledger is booked at **real (mainnet) prices** from our own
calculation, exactly as before. A testnet rejection, partial fill, or zero fill
is *information*, traced but never booked.

**Four states, made distinct and traceable.** The journal used to conflate them;
now each is a separate, reconcilable fact:

1. **Wanted** — the sovereign movement, sized at real prices (the intention).
2. **Submitted** — what we managed to send to the testnet.
3. **Accepted** — what the exchange validated (filters OK).
4. **Executed** — what actually filled (full / partial / nothing).

**Two events per movement, append-only, never rewritten** (see migration 0005):

- An **`intent`** row — the **sovereign booking** (state 1). It carries the
  `ledger_*` deltas and is the *only* row that moves the virtual portfolio. It is
  written **before** the exchange call. Its `validation_status` records the
  **authoritative** validation against the **real (mainnet)** filters:
  `executed` (passed → booked), `rejected` (a *crumb* below the actionable
  threshold → not booked), or `failed` (an unexpected block → not booked).
- An **`execution`** row — the **testnet trace** (states 2-3-4). It is written
  **after** the exchange responds, carries `ledger_* = 0` (never affects the
  book), and links back to its intent via `intent_execution_id`.

**Quantity.** We start from the sovereign quantity (computed at real prices) and
only **snap it to the symbol's lot step** (`LOT_SIZE`). We *never* recompute a
quantity from testnet prices — the sovereign world decides *how much*, the
exchange only says whether that quantity is admissible. The tiny lot-rounding
drift is an accepted operating tolerance.

**Validation that has authority.** A movement is validated against the **real
mainnet filters** (`LOT_SIZE`, and `NOTIONAL` min **and max**) using our
**sovereign price** as the economic reference. This — and only this — gates the
sovereign booking. The filters are read straight from the exchange's
`exchangeInfo` (the authoritative source), not a derived abstraction. A movement
above `maxNotional` is a clean **block** (not booked, no order) — never split.

**Crumbs are a clean no-op.** A movement too small to clear the real min-notional
(or that snaps to nothing) is **skipped**: logged, journaled as a non-booked
intent, **no order, no error, no escalation**. The portfolio is left intact and
the slight gap to target is carried to the next cycle — never forced into a retry
loop.

**Order type: marketable LIMIT, IOC.** We place a `LIMIT` (not a `MARKET`: a
limit gives a clean, book-independent filter check) priced to **cross the testnet
spread**, with `timeInForce: 'IOC'` (Immediate-Or-Cancel). It fills immediately
against resting liquidity and cancels any remainder on the spot — so we always
get an execution trace (full / partial / zero) and never leave a dangling order.
The submitted price is derived from the **testnet** book (its
`PERCENT_PRICE_BY_SIDE` band references the testnet price), while accounting uses
the mainnet price.

**Write order / crash safety.** Intent (durable) → order → trace. A crash between
the writes is unambiguous and replayable: an intent with no trace means
"wanted/booked, execution unknown", and the next cycle re-sizes from the
already-updated book, so a movement is never double-booked and there is never a
silent hole. The journal stays append-only and immutable.

### Applying the migration

Paste [`0005_executions_testnet_orders.sql`](supabase/migrations/0005_executions_testnet_orders.sql)
into the Supabase **SQL Editor** and **Run**. It adds the `event_type`
discriminator (defaulting existing PR A rows to booked `intent`s, so the
portfolio derives identically) and the testnet-trace columns. RLS is already
enabled on the table — nothing else to do.

## Scheduler (heartbeat — PR 1: the core)

So far the cycle only runs on a manual `npm run decide`. The scheduler makes the
bot autonomous. The deploy host (Railway) provides a **fixed cron that beats
every 5 min** (the cron wiring lands in a later deploy PR); this PR builds the
**state in the database** and the logic that decides, at each beat, whether to
actually run a cycle — robust to crashes and overlaps. It's also the **run-lock**
that closes the PR #2 ATH/ATL cache race (one run touches the cache at a time).

**The 5-min cron is dumb; the state is a small state machine with a lock.** Each
beat (`npm run beat`): read the state, and run a real cycle only if it's due **and**
no live lock exists. Before working, the beat **claims the run atomically** — the
guard against ever deciding twice in parallel.

- **State model** — a singleton `bot_state` row (next check, the run-lock
  `run_token` + `locked_until`, liveness, last success, the backoff counter, the
  overheating counter, an alert flag for later) plus an append-only `scheduler_runs`
  history, same spirit as `executions`.
- **Atomic claim** — a single conditional `UPDATE` (`claim_due_run`) is the
  compare-and-set: Postgres takes a row lock, two overlapping beats serialize, and
  the loser re-evaluates its `WHERE` against the now-locked row → 0 rows. No
  double-run. Comparison uses the **database's `now()`**, never the app clock.
- **The lock expires** — a run that crashes mid-cycle has its lock expire, and a
  later beat reclaims it (self-healing). The lock TTL (`lockTtlSeconds`, 10 min)
  must exceed the **worst-case cycle** (`maxCycleSeconds`, 5 min) — otherwise a
  slow-but-alive run could lose its lock to a parallel beat and run a *second
  concurrent cycle* (the fencing token stops state corruption, **not** double
  execution). We make the cycle *provably* bounded, not just "probably short":
  besides the per-call ccxt/Anthropic timeouts, `decide()` is wrapped in a **hard
  timeout = maxCycleSeconds** (a timeout → technical error → backoff), and `beat.ts`
  **force-exits** the one-shot process so a timed-out cycle can't keep running and
  act after the lock is released. With `lockTtlSeconds > maxCycleSeconds` asserted
  at startup, the lock cannot expire while a cycle is still alive.
- **Reschedule last, and always** — order is: claim → run cycle → journal (the PR B
  behaviour) → write the new `next_check_at` → release the lock, ideally in one
  transaction (`finish_run`). Never reschedule before the work, so a crash can't
  jump the schedule forward. And reschedule for **every** outcome so the bot never
  goes dark: a decided cycle → the LLM's bounded delay (15–240); a soft skip → a
  fixed ~30 min; a hard error → capped exponential backoff (15, 30, 60, 120, 240)
  reset on success.
- **No catch-up** — if many beats were missed (the bot was down), run **one** fresh
  cycle on the current market; missed beats are only logged.
- **Fail loud on infra** — for a cron-launched bot the **exit code is the first line
  of monitoring** (before the external watchdog). An infra/config fault (RPC error,
  unconfigured Supabase) **throws** so the beat exits non-zero; `null`/`false` are
  reserved for genuine results (not-claimed / fencing). A `finish_run` failure right
  after the cycle is safe: the lock was already written, so a later beat reclaims it
  once it expires — visible outage, no lost recovery.

Replay safety (why we're fine on testnet without `clientOrderId`): PR B books the
intent *before* placing the order and derives the portfolio from the append-only
journal, so a reclaimed run re-sizes from the already-booked state and never
repeats a movement. The only residue is a duplicate testnet order without a trace
— harmless on fake money. Fine idempotency keys stay a guard for real money.

### Applying the migration

Paste [`0006_scheduler.sql`](supabase/migrations/0006_scheduler.sql) into the
Supabase **SQL Editor** and **Run**. It creates `bot_state` (seeded singleton) and
`scheduler_runs`, plus the `record_heartbeat` / `claim_due_run` / `finish_run`
functions. RLS deny-all on both tables, and `EXECUTE` on the functions is revoked
from `public` and granted to `service_role` only (the backend's key) — so
anon/authenticated can't even invoke them.

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
#    - 0001_ath_atl_cache.sql              (ATH/ATL cache)
#    - 0002_decisions.sql                  (decision journal)
#    - 0003_executions.sql                 (execution journal — virtual portfolio)
#    - 0004_extend_decisions.sql           (bounded-allocation columns)
#    - 0005_executions_testnet_orders.sql  (four-state testnet execution journal)
#    - 0006_scheduler.sql                  (scheduler state machine + run-lock)
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
npm run decide    # bricks 3-4: one wake-up — decide, bound to caps, execute
npm run beat      # scheduler: one heartbeat — run a cycle only if it's due
```

`npm start` prints a formatted summary per pair, your testnet balances, then the
raw JSON of the full context. `npm run decide` runs a full cycle: it prints the
AI's proposed allocation and reasoning, then the **virtual portfolio**, the
**risk-wrapper** result (proposed vs applied), and the **real testnet execution**
— per movement, what was booked and what the testnet did (the four states).
`npm run beat` is the scheduler entry point: it records liveness, and **only when a
cycle is due and unlocked** does it atomically claim the run, call `decide()`, and
reschedule; otherwise it's a cheap no-op. The Railway cron will call it every 5 min.

> ⚠️ `npm run decide` (and a *due* `npm run beat`) **places real orders on the
> Binance testnet** (fake money, but a real exchange round-trip) and **calls the
> Anthropic API** (cost). The sovereign accounting is never affected by the testnet
> result.

## Type check & tests

```sh
npm run typecheck
npm test          # money invariants (cash floor, snapping) + scheduler policy
                  # (due/lock, atomic-claim guard, reschedule, backoff, overheating)
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
- `scheduler` — `beatIntervalMinutes` (the cron cadence), `maxCycleSeconds`
  (worst-case cycle budget), `lockTtlSeconds` (run-lock TTL, **must exceed**
  `maxCycleSeconds`), and `softSkipDelayMinutes`. Backoff reuses the `decision`
  delay bounds (15 / 240).

The set of balance-tracked assets — and the AI's allocation universe — are both
derived from `tradablePairs` via `tradableAssets()`; there's no separate asset
list to maintain. The core code never needs to be touched to add a pair or tune
an indicator.

## Project layout

```
src/
├── index.ts                 # brick 1-2 entry — build + print market context
├── decide.ts                # brick 3 entry — one decision wake-up
├── beat.ts                  # scheduler entry — one heartbeat (run a cycle if due)
├── config/index.ts          # pairs, timeframes, indicators, cache + decision + scheduler tuning
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
│   ├── executions.ts        # execution journal: derive ledger (booked intents) + insert rows
│   └── schedulerState.ts    # bot_state + scheduler_runs RPCs (heartbeat / claim / finish)
├── scheduler/
│   ├── policy.ts            # PURE logic: due/lock, missed beats, backoff, delays, overheating
│   └── heartbeat.ts         # one beat: liveness → atomic claim → cycle → reschedule → release
├── portfolio/
│   └── derive.ts            # derive the virtual portfolio + weighted-avg P&L from the journal
├── risk/
│   └── clamp.ts             # risk wrapper: bound allocation to caps (surplus → cash)
├── execution/
│   ├── movements.ts         # movement sizing + the intent / rejected-intent / trace row builders
│   ├── symbolRules.ts       # authoritative exchange filters: load + snap qty/price + validate
│   ├── testnetOrder.ts      # place a marketable LIMIT IOC on the testnet, normalize the result
│   ├── execute.ts           # per-movement: snap → validate → book intent → order → trace
│   └── print.ts             # portfolio / clamp / four-state execution output
├── context/
│   ├── build.ts             # assembles MarketContext
│   └── print.ts             # human-readable context output
└── decision/
    ├── schema.ts            # structured-output schema + business validation
    ├── prompt.ts            # frozen mandate v2 (caps + portfolio) + per-run user prompt
    ├── context.ts           # decision context: portfolio in place of testnet balances
    ├── llm.ts               # Anthropic client, structured call, token/latency capture
    ├── gitSha.ts            # commit SHA for traceability (env → git → null)
    ├── decide.ts            # orchestrator: derive → decide → clamp → movements → execute
    └── print.ts             # human-readable decision output

supabase/
└── migrations/
    ├── 0001_ath_atl_cache.sql              # versioned cache table + RLS
    ├── 0002_decisions.sql                  # decision journal table + RLS
    ├── 0003_executions.sql                 # execution journal (virtual portfolio source of truth)
    ├── 0004_extend_decisions.sql           # bounded-allocation columns on decisions
    ├── 0005_executions_testnet_orders.sql  # four-state testnet execution (intent + execution rows)
    └── 0006_scheduler.sql                  # bot_state + scheduler_runs + claim/finish functions
```

## Coming next (not in this brick)

- **Scheduler, next PRs.** This PR is the heartbeat core (state machine + atomic
  claim + reschedule). Still to come: **alerting** (Telegram on a stale heartbeat /
  overheating / repeated failures — the counters and `alert_sent` flag are already
  maintained), an **external watchdog**, and the **Railway deploy** that wires the
  5-min cron to `npm run beat`.
- **Real money.** Mutate the ledger from the *real* fills (the step PR B
  deliberately stops short of: here the accounting stays driven by our own
  calculation at real prices, and the testnet only proves executability). This is
  also when fine idempotency (a `clientOrderId` per order) graduates from
  nice-to-have to required.
- The false-`hold` prompt fix (a small standalone PR), and a dashboard.
