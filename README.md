# crypto-buddy

Autonomous crypto trading bot — work in progress.

This first brick is a **read-only market data engine**. It connects to
Binance, builds a structured "market context" object for a configurable list
of pairs, and prints it to the console for visual inspection. No LLM call,
no orders, no trading logic yet.

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
- Pulls a long-term weekly series (default: 1000 × 1w) to compute true
  ATH / ATL across the deepest history available.
- Computes a snapshot of indicators in code: RSI(14), SMA(50), SMA(200),
  EMA(21) — via `technicalindicators`.
- Computes price levels: month high/low, year high/low, ATH/ATL.

It also reads the authenticated **Binance testnet** account, keeping only the
**relevant balances** — the quote currency (USDT) and the base assets of
tradable pairs. The testnet seeds hundreds of unrelated assets; everything
outside that allowlist is filtered out. Reference-watchlist assets are never
balance-tracked.

Market data comes from mainnet on purpose (the testnet has synthetic
prices); only the account side is sandboxed.

Everything is assembled into one `MarketContext` object, printed in a
human-readable summary plus raw JSON.

## Setup

```sh
# 1. Install dependencies
npm install

# 2. Create your testnet API keys at https://testnet.binance.vision/
#    Permissions: enable spot trading + account read.

# 3. Copy the env template and fill in your keys
cp .env.example .env
#   edit .env with your BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET
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
- `longTermTimeframe` / `longTermLimit` — series used for ATH/ATL only.
- `indicators` — RSI period, list of SMA periods, list of EMA periods.

The set of balance-tracked assets is derived from `tradablePairs` via
`tradableAssets()` — no separate asset list to maintain. The core code never
needs to be touched to add a pair or tune an indicator.

## Project layout

```
src/
├── index.ts                 # entry point
├── config/index.ts          # tradable/reference pairs, timeframes, indicators
├── exchanges/binance.ts     # public mainnet + authenticated testnet clients
├── market/
│   ├── klines.ts            # candle + ticker fetch
│   ├── indicators.ts        # RSI / SMA / EMA snapshot
│   └── levels.ts            # month / year / ATH-ATL (isolated)
├── account/balances.ts      # testnet balances, filtered to tradable assets
└── context/
    ├── build.ts             # assembles MarketContext
    └── print.ts             # human-readable console output
```

## Coming next (not in this brick)

- Persistence layer: cache the long-term series + cached ATH/ATL, refresh
  incrementally instead of re-fetching every run.
- LLM decision step: send `MarketContext` + portfolio target spec to a model.
- Execution layer: place orders on testnet to reach the target allocation,
  with hard-coded risk guardrails.
