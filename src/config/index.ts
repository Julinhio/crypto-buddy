/**
 * Central configuration for the market data engine.
 * Adding a pair = one line in `pairs`. Indicator periods and timeframes
 * live here so the core code never needs to be touched to tweak them.
 */

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w' | '1M';

export interface IndicatorConfig {
  rsiPeriod: number;
  smaPeriods: number[];
  emaPeriods: number[];
}

export interface AppConfig {
  pairs: string[];
  primaryTimeframe: Timeframe;
  primaryLimit: number;
  longTermTimeframe: Timeframe;
  longTermLimit: number;
  indicators: IndicatorConfig;
}

export const config: AppConfig = {
  pairs: ['BTC/USDT', 'ETH/USDT'],

  primaryTimeframe: '1d',
  primaryLimit: 500,

  longTermTimeframe: '1w',
  longTermLimit: 1000,

  indicators: {
    rsiPeriod: 14,
    smaPeriods: [50, 200],
    emaPeriods: [21],
  },
};
