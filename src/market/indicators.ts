import { RSI, SMA, EMA } from 'technicalindicators';
import type { Candle } from './klines.js';
import type { IndicatorConfig } from '../config/index.js';

export interface IndicatorSnapshot {
  rsi: { period: number; value: number | null };
  sma: Record<number, number | null>;
  ema: Record<number, number | null>;
}

function lastOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = values[values.length - 1];
  return v ?? null;
}

export function computeIndicators(
  candles: Candle[],
  cfg: IndicatorConfig,
): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);

  const rsiValue = lastOrNull(
    RSI.calculate({ values: closes, period: cfg.rsiPeriod }),
  );

  const sma: Record<number, number | null> = {};
  for (const period of cfg.smaPeriods) {
    sma[period] = lastOrNull(SMA.calculate({ values: closes, period }));
  }

  const ema: Record<number, number | null> = {};
  for (const period of cfg.emaPeriods) {
    ema[period] = lastOrNull(EMA.calculate({ values: closes, period }));
  }

  return {
    rsi: { period: cfg.rsiPeriod, value: rsiValue },
    sma,
    ema,
  };
}
