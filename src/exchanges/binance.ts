import { binance } from 'ccxt';

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
    options: {
      defaultType: 'spot',
    },
  });

  client.setSandboxMode(true);
  return client;
}
