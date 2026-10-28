// Synthetic "phone camera looking at the transmitter" frames, for tests and
// the fake-camera browser e2e. Renders the grid (plus quiet zone) under a
// perspective warp with blur, sensor noise, a brightness gradient and a dark
// surround; the RGB variant adds colour crosstalk and a white-balance cast.
// Not exported from the package index: test tooling only.

import { GRID_SIZE, type Colors, type Modules } from './grid.ts';
import { applyHomography, solveHomography, type Point } from './homography.ts';
import { moduleRgb } from './palette.ts';
import { mulberry32 } from './prng.ts';
import type { RgbaImage } from './raster.ts';
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
  /** Uniform noise amplitude (± levels, per channel). */
  noise?: number;
  /** Box-blur radius in pixels. */
  blur?: number;
  seed?: number;
}

export interface ColorCameraSim extends CameraSim {
  /** Fraction of each channel leaking into each of the other two (sensor/display crosstalk). */
  crosstalk?: number;
  /** Per-channel gain, e.g. [1, 0.95, 0.8] for a warm white balance. */
  tint?: readonly [number, number, number];
}

// Renders `channels` planes; shade(v) gives each module value's channel levels.
function render(modules: Modules, sim: CameraSim, channels: number, shade: (v: number) => number[]): Float32Array[] {
  const { width: w, height: h, corners } = sim;
  const { background = 30, gradient = 0, blur = 0 } = sim;
  const side = GRID_SIZE + QUIET * 2;
  const toRaster = solveHomography(corners, [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ]);
  if (!toRaster) throw new Error('degenerate corners');

  const levels = Array.from({ length: 8 }, (_, v) => shade(v));
  const quiet = shade(0);
  let planes: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(w * h));
  const ss = [0.25, 0.75];
  const acc = new Float32Array(channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      acc.fill(0);
      for (const sy of ss) {
        for (const sx of ss) {
          const p = applyHomography(toRaster, x + sx, y + sy);
          if (p.x < 0 || p.y < 0 || p.x >= side || p.y >= side) {
            for (let c = 0; c < channels; c++) acc[c] += background;
            continue;
          }
          const mx = Math.floor(p.x) - QUIET;
          const my = Math.floor(p.y) - QUIET;
          const inGrid = mx >= 0 && my >= 0 && mx < GRID_SIZE && my < GRID_SIZE;
          const lv = inGrid ? levels[modules[my * GRID_SIZE + mx]] : quiet;
          for (let c = 0; c < channels; c++) acc[c] += lv[c];
        }
      }
      const fade = 1 - (gradient * x) / w;
      for (let c = 0; c < channels; c++) planes[c][y * w + x] = (acc[c] / 4) * fade;
    }
  }
  if (blur > 0) planes = planes.map((px) => boxBlur(boxBlur(px, w, h, blur, 1, w), w, h, blur, w, 1));
  return planes;
}

export function simulateCamera(modules: Modules, sim: CameraSim): GrayImage {
  const { dark = 35, light = 215, noise = 0, seed = 1 } = sim;
  const [px] = render(modules, sim, 1, (v) => [v ? dark : light]);
  const rng = mulberry32(seed);
  const data = new Uint8Array(px.length);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(px[i] + (rng() * 2 - 1) * noise)));
  return { width: sim.width, height: sim.height, data };
}

/** Colour camera; `colors` says how module values map to screen colours. */
export function simulateCameraRgb(modules: Modules, colors: Colors, sim: ColorCameraSim): RgbaImage {
  const { dark = 35, light = 215, noise = 0, seed = 1, crosstalk = 0, tint = [1, 1, 1] } = sim;
  const shade = (v: number) => {
    const s = moduleRgb(v, colors).map((c) => c / 255);
    return [0, 1, 2].map((c) => {
      const mixed = s[c] * (1 - 2 * crosstalk) + (s[(c + 1) % 3] + s[(c + 2) % 3]) * crosstalk;
      return (dark + (light - dark) * mixed) * tint[c];
    });
  };
  const planes = render(modules, sim, 3, shade);
  const rng = mulberry32(seed);
  const n = sim.width * sim.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(planes[c][i] + (rng() * 2 - 1) * noise);
    data[i * 4 + 3] = 255;
  }
  return { width: sim.width, height: sim.height, data };
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
