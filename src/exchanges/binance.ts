import { binance } from 'ccxt';

// Per-request timeout (ms). Kept well under the scheduler's cycle budget
// (config.scheduler.maxCycleSeconds): a cycle whose external calls hung past its
// run-lock could be reclaimed by a parallel beat and double-book. ccxt does not
// auto-retry, so the worst wall-time per call is bounded by this single timeout.
const EXCHANGE_TIMEOUT_MS = 15_000;

/**
 * Two distinct ccxt instances by design:
 *
 *   - `publicMainnetClient()` hits api.binance.com (real market data, no key).
 *     This is what feeds prices, klines, indicators, and ATH/ATL.
 *
 *   - `testnetAccountClient()` hits testnet.binance.vision (synthetic prices,
 *     authenticated). This is ONLY for account-level reads (balances) and
 *     later for order placement. Its market data is NOT representative.
 *
 * Mixing the two here would defeat the whole point of the brick: we want
 * the bot to read the *real* market, while sandboxing the account side.
 */

export function publicMainnetClient(): binance {
  return new binance({
    enableRateLimit: true,
    timeout: EXCHANGE_TIMEOUT_MS,
    options: {
      defaultType: 'spot',
    },
  });
}

export function testnetAccountClient(): binance {
  const apiKey = process.env.BINANCE_TESTNET_API_KEY;
  const secret = process.env.BINANCE_TESTNET_API_SECRET;

  if (!apiKey || !secret) {
    throw new Error(
      'Missing Binance testnet credentials. ' +
        'Copy .env.example to .env and fill BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET.',
    );
  }

  const client = new binance({
    apiKey,
    secret,
    enableRateLimit: true,
    timeout: EXCHANGE_TIMEOUT_MS,
    options: {
      defaultType: 'spot',
    },
  });

  client.setSandboxMode(true);
  return client;
}
