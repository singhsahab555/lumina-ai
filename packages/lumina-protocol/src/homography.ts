// 3×3 projective transform from four point correspondences.

export interface Point {
  x: number;
  y: number;
}

/** Row-major [h0..h7], h8 = 1. */
export type Homography = Float64Array;

/** Solves H with H(src[i]) = dst[i]. Returns null for degenerate input. */
export function solveHomography(src: readonly Point[], dst: readonly Point[]): Homography | null {
  // 8 equations, 8 unknowns: Gaussian elimination with partial pivoting.
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-10) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k];
    }
  }
  return Float64Array.from({ length: 9 }, (_, i) => (i === 8 ? 1 : a[i][8] / a[i][i]));
}

export function applyHomography(h: Homography, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}
