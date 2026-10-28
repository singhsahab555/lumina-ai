// Robust Soliton degree distribution (Luby, 2002).
// c and delta are the standard tuning knobs. With peeling alone,
// c=0.05/delta=0.5 gave ~26% median repair-only overhead at K=200. The
// decoder now falls back to Gaussian elimination and lt.ts shifts repair
// degrees (+2, floor K/4), which brings it to ~2 extra droplets (LOG Day 4).

import type { Rng } from './prng.ts';

export interface SolitonParams {
  c: number;
  delta: number;
}

export const DEFAULT_SOLITON: SolitonParams = { c: 0.05, delta: 0.5 };

export function robustSolitonCdf(k: number, params: SolitonParams = DEFAULT_SOLITON): Float64Array {
  const { c, delta } = params;
  const weights = new Float64Array(k + 1);

  // Ideal soliton
  weights[1] = 1 / k;
  for (let d = 2; d <= k; d++) weights[d] = 1 / (d * (d - 1));

  // Robust spike
  const r = c * Math.log(k / delta) * Math.sqrt(k);
  const pivot = Math.max(1, Math.min(k, Math.floor(k / r)));
  for (let d = 1; d < pivot; d++) weights[d] += r / (d * k);
  weights[pivot] += (r * Math.log(r / delta)) / k;

  let total = 0;
  for (let d = 1; d <= k; d++) total += weights[d];

  const cdf = new Float64Array(k + 1);
  let acc = 0;
  for (let d = 1; d <= k; d++) {
    acc += weights[d] / total;
    cdf[d] = acc;
  }
  cdf[k] = 1;
  return cdf;
}

export function sampleDegree(cdf: Float64Array, rng: Rng): number {
  const u = rng();
  let lo = 1;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sampleIndices(k: number, degree: number, rng: Rng): number[] {
  if (degree * 2 > k) {
    // Dense: partial Fisher-Yates
    const pool = Array.from({ length: k }, (_, i) => i);
    for (let i = 0; i < degree; i++) {
      const j = i + Math.floor(rng() * (k - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, degree);
  }
  // Sparse: rejection sampling
  const picked = new Set<number>();
  while (picked.size < degree) picked.add(Math.floor(rng() * k));
  return [...picked];
}
