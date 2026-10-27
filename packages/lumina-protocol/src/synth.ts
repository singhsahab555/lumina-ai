// Synthetic "phone camera looking at the transmitter" frames, for tests and
// the fake-camera browser e2e. Renders the grid (plus quiet zone) under a
// perspective warp with blur, sensor noise, a brightness gradient and a dark
// surround. Not exported from the package index: test tooling only.

import { GRID_SIZE, type Modules } from './grid.ts';
import { applyHomography, solveHomography, type Point } from './homography.ts';
import { mulberry32 } from './prng.ts';
import type { GrayImage } from './vision.ts';

export const QUIET = 4;

export interface CameraSim {
  width: number;
  height: number;
  /** Where the raster's outer corners (quiet zone included) land: TL, TR, BR, BL. */
  corners: Point[];
  background?: number;
  dark?: number;
  light?: number;
  /** Fractional brightness drop from left to right edge. */
  gradient?: number;
  /** Uniform noise amplitude (± luma levels). */
  noise?: number;
  /** Box-blur radius in pixels. */
  blur?: number;
  seed?: number;
}

export function simulateCamera(modules: Modules, sim: CameraSim): GrayImage {
  const { width: w, height: h, corners } = sim;
  const { background = 30, dark = 35, light = 215, gradient = 0, noise = 0, blur = 0, seed = 1 } = sim;
  const side = GRID_SIZE + QUIET * 2;
  const toRaster = solveHomography(corners, [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ]);
  if (!toRaster) throw new Error('degenerate corners');

  let px: Float32Array = new Float32Array(w * h);
  const ss = [0.25, 0.75];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (const sy of ss) {
        for (const sx of ss) {
          const p = applyHomography(toRaster, x + sx, y + sy);
          if (p.x < 0 || p.y < 0 || p.x >= side || p.y >= side) {
            acc += background;
            continue;
          }
          const mx = Math.floor(p.x) - QUIET;
          const my = Math.floor(p.y) - QUIET;
          const on = mx >= 0 && my >= 0 && mx < GRID_SIZE && my < GRID_SIZE && modules[my * GRID_SIZE + mx];
          acc += on ? dark : light;
        }
      }
      px[y * w + x] = (acc / 4) * (1 - (gradient * x) / w);
    }
  }

  if (blur > 0) px = boxBlur(boxBlur(px, w, h, blur, 1, w), w, h, blur, w, 1);

  const rng = mulberry32(seed);
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(px[i] + (rng() * 2 - 1) * noise)));
  return { width: w, height: h, data };
}

// 1-D box blur along one axis: `step` is the stride between taps, `lines`
// counts how many independent lines there are.
function boxBlur(src: Float32Array, w: number, h: number, r: number, step: number, lineStride: number): Float32Array {
  const out = new Float32Array(src.length);
  const len = step === 1 ? w : h;
  const lines = step === 1 ? h : w;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    for (let i = 0; i < len; i++) {
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(len - 1, i + r); k++) {
        sum += src[base + k * step];
        n++;
      }
      out[base + i * step] = sum / n;
    }
  }
  return out;
}

/** Corners for a grid of `px` pixels per side centred at (cx, cy), rotated and keystoned. */
export function placeGrid(cx: number, cy: number, sidePx: number, rotateDeg = 0, keystone = 0): Point[] {
  const a = (rotateDeg * Math.PI) / 180;
  const half = sidePx / 2;
  // keystone > 0 makes the top edge narrower, like a phone tilted back.
  const local = [
    [-half * (1 - keystone), -half],
    [half * (1 - keystone), -half],
    [half * (1 + keystone), half],
    [-half * (1 + keystone), half],
  ];
  return local.map(([x, y]) => ({ x: cx + x * Math.cos(a) - y * Math.sin(a), y: cy + x * Math.sin(a) + y * Math.cos(a) }));
}
