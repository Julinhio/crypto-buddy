/**
 * THE STATISTICS OF PROTOCOL v1.3 — written here, no library, each one tested against a case
 * whose answer is known in closed form (`src/test/benchExposure.ts`).
 *
 *   neweyWest          OLS slope with HAC standard errors, Bartlett kernel, lag = horizon − 1
 *                      (point 5: overlapping horizons);
 *   politisWhite       the automatic mean block length of the STATIONARY bootstrap,
 *                      Politis & White (2004) with the Patton, Politis & White (2009)
 *                      correction (point 11);
 *   stationaryBootstrap  Politis & Romano (1994), circular, geometric blocks, seeded (point 11);
 *   mulberry32         the seeded generator. A fixed seed must give the same 10 000 draws on any
 *                      machine, which `Math.random` cannot promise.
 */

// ── SEEDED GENERATOR ─────────────────────────────────────────────────────────────────

/** Mulberry32: a 32-bit seed, a deterministic stream of uniforms in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── NEWEY-WEST ───────────────────────────────────────────────────────────────────────

export interface RegressionResult {
  n: number;
  intercept: number;
  slope: number;
  /** HAC standard error of the slope. */
  slopeSe: number;
  tStat: number;
  /** Plain OLS standard error, for comparison only. */
  slopeSeOls: number;
  lag: number;
  /** Pearson correlation of x and y. */
  correlation: number;
}

/**
 * y = a + b·x + e, with Newey-West (Bartlett) HAC variance at `lag`.
 *
 *   V = (X'X)⁻¹ S (X'X)⁻¹,   S = Σ_{l=-L..L} w_l Σ_t (x_t e_t)(x_{t-l} e_{t-l})',
 *   w_l = 1 − |l| / (L + 1)
 */
export function neweyWest(x: readonly number[], y: readonly number[], lag: number): RegressionResult {
  const n = x.length;
  if (n !== y.length) throw new Error('neweyWest: x and y differ in length');
  if (n < 3) throw new Error('neweyWest: fewer than three observations');
  if (!(Number.isInteger(lag) && lag >= 0 && lag < n)) throw new Error(`neweyWest: invalid lag ${lag}`);

  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (x[i]! - mx) ** 2;
    sxy += (x[i]! - mx) * (y[i]! - my);
    syy += (y[i]! - my) ** 2;
  }
  if (sxx <= 0) throw new Error('neweyWest: x has no variance');
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const e = x.map((xi, i) => y[i]! - intercept - slope * xi);

  // X'X for [1, x]
  let sx = 0;
  let sx2 = 0;
  for (const xi of x) {
    sx += xi;
    sx2 += xi * xi;
  }
  const det = n * sx2 - sx * sx;
  const inv = [
    [sx2 / det, -sx / det],
    [-sx / det, n / det],
  ];

  // S, 2×2, from the scores u_t = [e_t, x_t e_t]
  const S = [
    [0, 0],
    [0, 0],
  ];
  for (let l = 0; l <= lag; l += 1) {
    const w = l === 0 ? 1 : 1 - l / (lag + 1);
    const G = [
      [0, 0],
      [0, 0],
    ];
    for (let t = l; t < n; t += 1) {
      const a0 = e[t]!;
      const a1 = x[t]! * e[t]!;
      const b0 = e[t - l]!;
      const b1 = x[t - l]! * e[t - l]!;
      G[0]![0]! += a0 * b0;
      G[0]![1]! += a0 * b1;
      G[1]![0]! += a1 * b0;
      G[1]![1]! += a1 * b1;
    }
    for (let i = 0; i < 2; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        S[i]![j]! += l === 0 ? G[i]![j]! : w * (G[i]![j]! + G[j]![i]!);
      }
    }
  }
  // V = inv · S · inv, we need V[1][1]
  const m = [
    [inv[0]![0]! * S[0]![0]! + inv[0]![1]! * S[1]![0]!, inv[0]![0]! * S[0]![1]! + inv[0]![1]! * S[1]![1]!],
    [inv[1]![0]! * S[0]![0]! + inv[1]![1]! * S[1]![0]!, inv[1]![0]! * S[0]![1]! + inv[1]![1]! * S[1]![1]!],
  ];
  const v11 = m[1]![0]! * inv[0]![1]! + m[1]![1]! * inv[1]![1]!;
  const slopeSe = Math.sqrt(Math.max(v11, 0));
  const sse = e.reduce((s, v) => s + v * v, 0);
  const slopeSeOls = Math.sqrt(sse / (n - 2) / sxx);

  return {
    n,
    intercept,
    slope,
    slopeSe,
    tStat: slope / slopeSe,
    slopeSeOls,
    lag,
    correlation: sxy / Math.sqrt(sxx * syy),
  };
}

/** Pearson correlation. */
export function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  if (n !== b.length || n < 2) throw new Error('correlation: bad input');
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

// ── POLITIS-WHITE ────────────────────────────────────────────────────────────────────

/**
 * The lag-`i` cross product of a demeaned series, and its autocorrelation with denominators
 * over EXACTLY the observations the cross product uses: `eps[i..n-1]` and `eps[0..n-1-i]`.
 *
 * Not the slicing of the `arch` reference implementation, whose variance terms each drop one
 * endpoint (`eps[i]` and `eps[n-1-i]`) — a ratio that is then not a correlation and can exceed
 * 1 at lag 0 (Codex, PR #50, round 1). Bounded by Cauchy-Schwarz, equal to 1 at lag 0.
 */
export function laggedProducts(eps: readonly number[], i: number): { cross: number; acorr: number } {
  const n = eps.length;
  let cross = 0;
  let head = 0;
  let tail = 0;
  for (let t = i; t < n; t += 1) {
    cross += eps[t]! * eps[t - i]!;
    head += eps[t]! * eps[t]!;
    tail += eps[t - i]! * eps[t - i]!;
  }
  const denom = Math.sqrt(head * tail);
  return { cross, acorr: denom > 0 ? cross / denom : 0 };
}

export interface BlockLengthResult {
  /** The optimal mean block length for the stationary bootstrap, capped at `bMax`. */
  blockLength: number;
  /** m̂, the cutoff lag, or null when no window of K_n small autocorrelations was found. */
  cutoffLag: number | null;
  /** The lag window bandwidth M = 2·m̂ actually used. */
  bandwidth: number;
  bMax: number;
}

/**
 * Politis & White (2004), corrected by Patton, Politis & White (2009), stationary bootstrap.
 *
 *   m̂  = smallest lag after which K_n consecutive autocorrelations are all below
 *        c·√(log₁₀ n / n), c = 2, K_n = max(5, ⌊log₁₀ n⌋);
 *   M  = min(2·max(m̂, 1), m_max),   m_max = ⌈√n⌉ + K_n;
 *   λ  = flat-top window: 1 on |k/M| ≤ ½, 2(1 − |k/M|) on ½ < |k/M| ≤ 1;
 *   Ĝ  = Σ_{|k|≤M} λ(k/M) |k| γ̂(k),   ĝ = Σ_{|k|≤M} λ(k/M) γ̂(k);
 *   b  = (2 Ĝ² / D̂)^{1/3} n^{1/3},   D̂ = 2 ĝ²;   capped at b_max = ⌈min(3√n, n/3)⌉.
 *
 * For an AR(1) with coefficient φ this tends to ((2φ/(1−φ²))^{2/3}) n^{1/3}, the closed form
 * the test checks against.
 */
export function politisWhite(series: readonly number[]): BlockLengthResult {
  const n = series.length;
  if (n < 10) throw new Error('politisWhite: fewer than ten observations');
  const mean = series.reduce((s, v) => s + v, 0) / n;
  const eps = series.map((v) => v - mean);
  const bMax = Math.ceil(Math.min(3 * Math.sqrt(n), n / 3));
  const kn = Math.max(5, Math.floor(Math.log10(n)));
  const mMax = Math.ceil(Math.sqrt(n)) + kn;
  const cv = 2 * Math.sqrt(Math.log10(n) / n);

  const acv: number[] = [];
  const absAcorr: number[] = [];
  let optM: number | null = null;
  for (let i = 0; i <= mMax; i += 1) {
    const { cross, acorr } = laggedProducts(eps, i);
    acv.push(cross / n);
    absAcorr.push(Math.abs(acorr));
    // m̂ is the smallest m whose NEXT K_n autocorrelations, lags m+1..m+K_n, are all small.
    // Lag m itself is not in the window — lag 0 is always 1 and would forbid m̂ = 0 (Codex,
    // PR #50, round 2: the `arch` slicing tests m..m+K_n−1, one lag back).
    if (i >= kn && optM == null) {
      let allSmall = true;
      for (let j = i - kn + 1; j <= i; j += 1) if (!(absAcorr[j]! < cv)) allSmall = false;
      if (allSmall) optM = i - kn;
    }
  }
  const M = Math.min(optM != null ? 2 * Math.max(optM, 1) : mMax, mMax);
  let G = 0;
  let g = acv[0]!;
  for (let k = 1; k <= M; k += 1) {
    const ratio = k / M;
    const lam = ratio <= 0.5 ? 1 : 2 * (1 - ratio);
    G += 2 * lam * k * acv[k]!;
    g += 2 * lam * acv[k]!;
  }
  const D = 2 * g * g;
  const b = Math.pow((2 * G * G) / D, 1 / 3) * Math.pow(n, 1 / 3);
  return { blockLength: Math.min(Number.isFinite(b) ? Math.max(b, 1) : 1, bMax), cutoffLag: optM, bandwidth: M, bMax };
}

// ── STATIONARY BOOTSTRAP ─────────────────────────────────────────────────────────────

export interface BootstrapResult {
  draws: number;
  seed: number;
  meanBlockLength: number;
  /** Mean of the original series. */
  estimate: number;
  /** 5th percentile of the bootstrap means: the one-sided 95 % lower bound. */
  lowerBound95: number;
  means: number[];
}

/**
 * Politis & Romano (1994). Each draw rebuilds a series of length n from blocks that start at
 * a uniform index and continue with probability 1 − 1/b, wrapping circularly. The statistic is
 * the mean, the lower bound its 5th bootstrap percentile.
 */
export function stationaryBootstrap(
  series: readonly number[],
  params: { meanBlockLength: number; draws: number; seed: number },
): BootstrapResult {
  const n = series.length;
  if (n < 2) throw new Error('stationaryBootstrap: fewer than two observations');
  if (!(params.meanBlockLength >= 1)) throw new Error('stationaryBootstrap: mean block length must be >= 1');
  const rand = mulberry32(params.seed);
  const p = 1 / params.meanBlockLength;
  const means: number[] = [];
  for (let d = 0; d < params.draws; d += 1) {
    let sum = 0;
    let idx = Math.floor(rand() * n);
    for (let t = 0; t < n; t += 1) {
      sum += series[idx]!;
      idx = rand() < p ? Math.floor(rand() * n) : (idx + 1) % n;
    }
    means.push(sum / n);
  }
  const sorted = [...means].sort((a, b) => a - b);
  const lower = sorted[Math.floor(0.05 * (params.draws - 1))]!;
  return {
    draws: params.draws,
    seed: params.seed,
    meanBlockLength: params.meanBlockLength,
    estimate: series.reduce((s, v) => s + v, 0) / n,
    lowerBound95: lower,
    means,
  };
}

/** Protocol v1.3, point 11. */
export const BOOTSTRAP_DRAWS = 10_000;
export const BOOTSTRAP_SEED = 20261101;
