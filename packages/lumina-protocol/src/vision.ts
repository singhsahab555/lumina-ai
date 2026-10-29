// Camera-frame reader for the grid, in plain TypeScript (no OpenCV):
//
//   RGBA → luma → adaptive threshold → connected components → finder rings
//   → pick 3 plain + 1 marked finder → homography from the finder centres
//   → 8-color: sample RGB, calibrate from the border, classify → 3 planes
//   → 2-color (or 8-color plane 0 fallback): local-mean luma threshold
//   → packets → CRC.
//
// A finder is a dark ring whose hole contains a separate dark core: 3×3
// modules for the plain finders, a 1×1 dot for the marked BR one. The core
// centroid is the finder centre, which is accurate even under perspective
// because the core is small. The CRC is the final judge: every plausible
// corner assignment (including a mirrored one) is tried until one passes.

import { BORDER_MODULES, BORDER_SIDE, COLOR_PLANES, DATA_MODULES, GRID_SIZE, modulesToPacket, type Colors, type Modules } from './grid.ts';
import { decodePacket, type DecodedPacket } from './packet.ts';
import { applyHomography, solveHomography, type Homography, type Point } from './homography.ts';
import type { RgbaImage } from './raster.ts';

export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Finder {
  center: Point;
  /** sqrt(ring area) in pixels, ≈ 4.9 modules. */
  size: number;
  marked: boolean;
}

export interface FrameRead {
  /** Grid outline (TL, TR, BR, BL) in image pixels, for overlays. */
  quad: Point[] | null;
  modules: Modules | null;
  /** First valid packet, for 2-color callers. */
  packet: DecodedPacket | null;
  /** Every CRC-valid packet in the frame: up to 3 for an 8-color symbol. */
  packets: DecodedPacket[];
  /** Mode the calibration border showed (2 unless it was seen in colour). */
  colors: Colors;
  finders: Finder[];
  /** Module space → image mapping that produced a CRC-valid packet, for the next frame. */
  homography: Homography | null;
}

// Finder centres in module space (continuous: module m spans [m, m + 1]).
const C0 = 3.5;
const C1 = GRID_SIZE - 3.5;
const FINDER_CENTERS: Point[] = [
  { x: C0, y: C0 },
  { x: C1, y: C0 },
  { x: C0, y: C1 },
  { x: C1, y: C1 },
];

export function toGray(img: RgbaImage): GrayImage {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  return { width: img.width, height: img.height, data: out };
}

const MIN_CONTRAST = 12;

/** Bradley-style adaptive threshold: 1 where a pixel is darker than its neighbourhood. */
function binarize(g: GrayImage): Uint8Array {
  const { width: w, height: h, data } = g;
  const iw = w + 1;
  const integral = new Uint32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x];
      integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + row;
    }
  }
  const r = Math.max(4, Math.round(Math.min(w, h) / 16));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * iw + x1] - integral[y0 * iw + x1] - integral[y1 * iw + x0] + integral[y0 * iw + x0];
      const count = (x1 - x0) * (y1 - y0);
      // 12% darker than the local mean and at least MIN_CONTRAST levels, so
      // sensor noise in flat dark areas does not turn into speckle blobs.
      const v = data[y * w + x] * count;
      if (v * 100 < sum * 88 && sum - v > MIN_CONTRAST * count) out[y * w + x] = 1;
    }
  }
  return out;
}

interface Blob {
  area: number;
  cx: number;
  cy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 4-connected component labelling (two-pass, union-find). Label 0 = light. */
function components(bin: Uint8Array, w: number, h: number): { labels: Int32Array; blobs: Blob[] } {
  const labels = new Int32Array(w * h);
  const parent = new Int32Array((w * h) / 2 + 2);
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bin[i]) continue;
      const left = x > 0 ? labels[i - 1] : 0;
      const up = y > 0 ? labels[i - w] : 0;
      if (!left && !up) {
        parent[next] = next;
        labels[i] = next++;
      } else if (left && up && left !== up) {
        const a = find(left);
        const b = find(up);
        const root = a < b ? a : b;
        parent[a] = parent[b] = root;
        labels[i] = root;
      } else {
        labels[i] = left || up;
      }
    }
  }

  const compact = new Int32Array(next);
  const blobs: Blob[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!labels[i]) continue;
      const root = find(labels[i]);
      let id = compact[root];
      if (!id) {
        blobs.push({ area: 0, cx: 0, cy: 0, minX: x, maxX: x, minY: y, maxY: y });
        id = compact[root] = blobs.length;
      }
      labels[i] = id;
      const b = blobs[id - 1];
      b.area++;
      b.cx += x;
      b.cy += y;
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
    }
  }
  for (const b of blobs) {
    b.cx = b.cx / b.area + 0.5;
    b.cy = b.cy / b.area + 0.5;
  }
  return { labels, blobs };
}

export function findFinders(g: GrayImage): Finder[] {
  const { width: w, height: h } = g;
  const { labels, blobs } = components(binarize(g), w, h);
  const finders: Finder[] = [];
  for (let id = 1; id <= blobs.length; id++) {
    const ring = blobs[id - 1];
    const bw = ring.maxX - ring.minX + 1;
    const bh = ring.maxY - ring.minY + 1;
    if (ring.area < 24 || bw < 5 || bh < 5) continue;
    // The dark surround of the screen also "rings" the quiet zone; it touches the frame edge.
    if (ring.minX === 0 || ring.minY === 0 || ring.maxX === w - 1 || ring.maxY === h - 1) continue;
    const ix = Math.floor(ring.cx);
    const iy = Math.floor(ring.cy);
    if (labels[iy * w + ix] === id) continue; // centroid on the blob itself: not a ring

    // The core is the dark blob sitting in the ring's hole, at its centroid.
    let coreId = 0;
    for (let dy = -1; dy <= 1 && !coreId; dy++) {
      for (let dx = -1; dx <= 1 && !coreId; dx++) {
        const x = ix + dx;
        const y = iy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const l = labels[y * w + x];
        if (l && l !== id) coreId = l;
      }
    }
    if (!coreId) continue;
    const core = blobs[coreId - 1];
    if (core.minX <= ring.minX || core.maxX >= ring.maxX || core.minY <= ring.minY || core.maxY >= ring.maxY) continue;
    if (core.maxX - core.minX + 1 > 0.7 * bw || core.maxY - core.minY + 1 > 0.7 * bh) continue;
    if (Math.hypot(core.cx - ring.cx, core.cy - ring.cy) > 0.08 * Math.max(bw, bh) + 1.5) continue;

    const ratio = core.area / ring.area; // ideal 9/24 plain, 1/24 marked
    const marked = ratio >= 0.012 && ratio < 0.16;
    if (!marked && (ratio < 0.18 || ratio > 0.8)) continue;
    finders.push({ center: { x: core.cx, y: core.cy }, size: Math.sqrt(ring.area), marked });
  }
  return finders.sort((a, b) => b.size - a.size);
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Candidate [TL, TR, BL, BR] finder centre sets, most plausible first. */
function* cornerSets(finders: Finder[]): Generator<Point[]> {
  const partners = (br: Finder) => finders.filter((f) => !f.marked && f.size > br.size * 0.4 && f.size < br.size * 2.5);
  // Dark data can join into a grid-sized "ring"; a real BR finder has 3 plain
  // finders of similar size, so only those candidates take one of the slots.
  const marked = finders.filter((f) => f.marked && partners(f).length >= 3).slice(0, 3);
  for (const br of marked) {
    const plain = partners(br).slice(0, 4);
    for (let i = 0; i < plain.length; i++) {
      for (let j = i + 1; j < plain.length; j++) {
        for (let k = j + 1; k < plain.length; k++) {
          const trio = [plain[i], plain[j], plain[k]].sort((a, b) => dist(b.center, br.center) - dist(a.center, br.center));
          const tl = trio[0].center;
          let tr = trio[1].center;
          let bl = trio[2].center;
          const side = dist(tl, tr) / br.size;
          if (side < 4 || side > 30) continue;
          if (cross(tl, tr, bl) < 0) [tr, bl] = [bl, tr];
          yield [tl, tr, bl, br.center];
          yield [tl, bl, tr, br.center]; // mirrored view (e.g. a selfie camera)
        }
      }
    }
  }
}

function bilinear(g: GrayImage, x: number, y: number): number {
  const { width: w, height: h, data } = g;
  x -= 0.5;
  y -= 0.5;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return -1;
  const x0 = Math.min(Math.floor(x), w - 2);
  const y0 = Math.min(Math.floor(y), h - 2);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const top = data[i] + (data[i + 1] - data[i]) * fx;
  const bottom = data[i + w] + (data[i + w + 1] - data[i + w]) * fx;
  return top + (bottom - top) * fy;
}

const SAMPLE_OFFSETS = [
  [0, 0],
  [0.2, 0],
  [-0.2, 0],
  [0, 0.2],
  [0, -0.2],
];
const LOCAL_RADIUS = 4;

function sampleLuma(g: GrayImage, hm: Homography): Float32Array | null {
  const n = GRID_SIZE;
  const values = new Float32Array(n * n);
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      let sum = 0;
      for (const [ox, oy] of SAMPLE_OFFSETS) {
        const p = applyHomography(hm, mx + 0.5 + ox, my + 0.5 + oy);
        const v = bilinear(g, p.x, p.y);
        if (v < 0) return null;
        sum += v;
      }
      values[my * n + mx] = sum / SAMPLE_OFFSETS.length;
    }
  }
  return values;
}

/** Samples the module grid through H (module space → image). Null if it leaves the frame. */
export function sampleModules(g: GrayImage, hm: Homography): Modules | null {
  const values = sampleLuma(g, hm);
  return values && localMeanThreshold(values);
}

// Inverse-squared-distance weights of the 4 border sides (top, right,
// bottom, left) for module (x, y), normalised to sum to 1.
function sideWeights(x: number, y: number, out: Float32Array): void {
  const n = GRID_SIZE;
  out[0] = 1 / (y + 1) ** 2;
  out[1] = 1 / (n - x) ** 2;
  out[2] = 1 / (n - y) ** 2;
  out[3] = 1 / (x + 1) ** 2;
  const total = out[0] + out[1] + out[2] + out[3];
  for (let k = 0; k < 4; k++) out[k] /= total;
}

/**
 * Plane-0 threshold learned from the border: odd slots are plane-0 dark in
 * both modes, so per side the cut sits between the darkest even slot and the
 * brightest odd one (green vs magenta in 8-color, white vs black in 2-color).
 * Tighter than the local mean when 8-color luma levels are uneven.
 */
function borderThreshold(values: Float32Array): Modules | null {
  const slots = new Float32Array(32);
  const counts = new Uint16Array(32);
  for (let i = 0; i < BORDER_MODULES.length; i++) {
    const s = Math.floor(i / BORDER_SIDE) * 8 + (i & 7);
    slots[s] += values[BORDER_MODULES[i]];
    counts[s]++;
  }
  const cut = new Float32Array(4);
  for (let side = 0; side < 4; side++) {
    let lightMin = Infinity;
    let darkMax = -Infinity;
    for (let slot = 0; slot < 8; slot++) {
      const v = slots[side * 8 + slot] / counts[side * 8 + slot];
      if (slot & 1) darkMax = Math.max(darkMax, v);
      else lightMin = Math.min(lightMin, v);
    }
    if (lightMin - darkMax < 8) return null;
    cut[side] = (lightMin + darkMax) / 2;
  }
  const modules = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const w = new Float32Array(4);
  for (let d = 0; d < DATA_MODULES.length; d++) {
    const pos = DATA_MODULES[d];
    const x = pos % GRID_SIZE;
    sideWeights(x, (pos - x) / GRID_SIZE, w);
    modules[pos] = values[pos] < w[0] * cut[0] + w[1] * cut[1] + w[2] * cut[2] + w[3] * cut[3] ? 1 : 0;
  }
  return modules;
}

function localMeanThreshold(values: Float32Array): Modules {
  const n = GRID_SIZE;
  // Whitened data is ~50% dark, so the local mean is a good per-module
  // threshold that follows glare and vignetting across the screen.
  const pn = n + 1;
  const prefix = new Float64Array(pn * pn);
  for (let y = 0; y < n; y++) {
    let row = 0;
    for (let x = 0; x < n; x++) {
      row += values[y * n + x];
      prefix[(y + 1) * pn + x + 1] = prefix[y * pn + x + 1] + row;
    }
  }
  const modules = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    const y0 = Math.max(0, y - LOCAL_RADIUS);
    const y1 = Math.min(n, y + LOCAL_RADIUS + 1);
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(0, x - LOCAL_RADIUS);
      const x1 = Math.min(n, x + LOCAL_RADIUS + 1);
      const mean = (prefix[y1 * pn + x1] - prefix[y0 * pn + x1] - prefix[y1 * pn + x0] + prefix[y0 * pn + x0]) / ((x1 - x0) * (y1 - y0));
      modules[y * n + x] = values[y * n + x] < mean ? 1 : 0;
    }
  }
  return modules;
}

/** Like sampleModules but keeps RGB: 3 floats per module. */
function sampleRgb(img: RgbaImage, hm: Homography): Float32Array | null {
  const { width: w, height: h, data } = img;
  const n = GRID_SIZE;
  const out = new Float32Array(n * n * 3);
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      let r = 0;
      let gr = 0;
      let b = 0;
      for (const [ox, oy] of SAMPLE_OFFSETS) {
        const p = applyHomography(hm, mx + 0.5 + ox, my + 0.5 + oy);
        const x = p.x - 0.5;
        const y = p.y - 0.5;
        if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
        const x0 = Math.min(Math.floor(x), w - 2);
        const y0 = Math.min(Math.floor(y), h - 2);
        const fx = x - x0;
        const fy = y - y0;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const i = (y0 * w + x0) * 4;
        const j = i + w * 4;
        r += data[i] * w00 + data[i + 4] * w10 + data[j] * w01 + data[j + 4] * w11;
        gr += data[i + 1] * w00 + data[i + 5] * w10 + data[j + 1] * w01 + data[j + 5] * w11;
        b += data[i + 2] * w00 + data[i + 6] * w10 + data[j + 2] * w01 + data[j + 6] * w11;
      }
      const o = (my * n + mx) * 3;
      out[o] = r / SAMPLE_OFFSETS.length;
      out[o + 1] = gr / SAMPLE_OFFSETS.length;
      out[o + 2] = b / SAMPLE_OFFSETS.length;
    }
  }
  return out;
}

// Mean chroma of the 6 coloured slots, relative to the white-black range,
// above which the border reads as an 8-color palette (2-color borders: ~0).
const MIN_CHROMA = 0.3;

/**
 * The palette as this screen renders it and this camera sees it, measured
 * per border side (4 sides × 8 slots × RGB). Null when the border is grey.
 */
function calibrate(rgb: Float32Array): Float32Array | null {
  const sides = new Float32Array(4 * 24);
  const counts = new Uint16Array(4 * 8);
  for (let i = 0; i < BORDER_MODULES.length; i++) {
    const s = Math.floor(i / BORDER_SIDE) * 8 + (i & 7);
    const o = BORDER_MODULES[i] * 3;
    sides[s * 3] += rgb[o];
    sides[s * 3 + 1] += rgb[o + 1];
    sides[s * 3 + 2] += rgb[o + 2];
    counts[s]++;
  }
  for (let s = 0; s < 32; s++) for (let c = 0; c < 3; c++) sides[s * 3 + c] /= counts[s];

  const mean = (slot: number, c: number) =>
    (sides[slot * 3 + c] + sides[(8 + slot) * 3 + c] + sides[(16 + slot) * 3 + c] + sides[(24 + slot) * 3 + c]) / 4;
  const luma = (slot: number) => 0.299 * mean(slot, 0) + 0.587 * mean(slot, 1) + 0.114 * mean(slot, 2);
  const range = luma(0) - luma(7);
  if (range < 24) return null;
  let chroma = 0;
  for (let slot = 1; slot < 7; slot++) {
    const r = mean(slot, 0);
    const g = mean(slot, 1);
    const b = mean(slot, 2);
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  return chroma / 6 > MIN_CHROMA * range ? sides : null;
}

/**
 * Nearest-palette classification. Each module is compared with a blend of
 * the four side palettes, weighted by inverse squared distance to each side,
 * so it follows brightness gradients and colour casts across the screen.
 */
function classify(rgb: Float32Array, sides: Float32Array): Modules {
  const n = GRID_SIZE;
  const modules = new Uint8Array(n * n);
  const pal = new Float32Array(24);
  const w = new Float32Array(4);
  for (let d = 0; d < DATA_MODULES.length; d++) {
    const pos = DATA_MODULES[d];
    const x = pos % n;
    sideWeights(x, (pos - x) / n, w);
    for (let k = 0; k < 24; k++) pal[k] = sides[k] * w[0] + sides[24 + k] * w[1] + sides[48 + k] * w[2] + sides[72 + k] * w[3];
    const o = pos * 3;
    let best = 0;
    let bestD = Infinity;
    for (let v = 0; v < 8; v++) {
      const dr = rgb[o] - pal[v * 3];
      const dg = rgb[o + 1] - pal[v * 3 + 1];
      const db = rgb[o + 2] - pal[v * 3 + 2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestD) {
        bestD = dist;
        best = v;
      }
    }
    modules[pos] = best;
  }
  return modules;
}

interface GridRead {
  modules: Modules | null;
  packets: DecodedPacket[];
  colors: Colors;
}

function decodeGrid(gray: () => GrayImage, rgba: RgbaImage | null, hm: Homography): GridRead {
  let colorRead: GridRead | null = null;
  if (rgba) {
    const rgb = sampleRgb(rgba, hm);
    const sides = rgb && calibrate(rgb);
    if (rgb && sides) {
      const modules = classify(rgb, sides);
      const planes = Array.from({ length: COLOR_PLANES }, (_, p) => decodePacket(modulesToPacket(modules, p)));
      colorRead = { modules, packets: planes.filter((p) => p !== null), colors: 8 };
      if (planes[0]) return colorRead;
    }
  }
  // 2-color frames, and the fallback for plane 0 of an 8-color one: a luma
  // threshold separates G-on from G-off even when hue is unreliable.
  const values = sampleLuma(gray(), hm);
  let modules = values && localMeanThreshold(values);
  let p0 = modules ? decodePacket(modulesToPacket(modules)) : null;
  if (values && !p0) {
    const byBorder = borderThreshold(values);
    p0 = byBorder ? decodePacket(modulesToPacket(byBorder)) : null;
    if (p0) modules = byBorder;
  }
  if (colorRead) {
    if (p0) colorRead.packets.unshift(p0);
    return colorRead;
  }
  return { modules, packets: p0 ? [p0] : [], colors: 2 };
}

const MAX_ATTEMPTS = 8;

function outline(hm: Homography): Point[] {
  return [
    [0, 0],
    [GRID_SIZE, 0],
    [GRID_SIZE, GRID_SIZE],
    [0, GRID_SIZE],
  ].map(([x, y]) => applyHomography(hm, x, y));
}

/**
 * Locates, samples and CRC-checks one camera frame. Never throws on bad input.
 *
 * `prior` is the homography of the last valid frame. A camera held still sees
 * the grid in the same place, so sampling through it first skips the finder
 * search (threshold + components over every pixel, ~90% of the cost). The
 * CRC rejects a stale mapping, and then the full search runs as usual.
 */
export function readFrame(img: RgbaImage | GrayImage, prior: Homography | null = null): FrameRead {
  const isGray = img.data.length === img.width * img.height;
  let g: GrayImage | null = isGray ? (img as GrayImage) : null;
  const gray = () => (g ??= toGray(img as RgbaImage));
  const rgba = isGray ? null : (img as RgbaImage);
  if (prior) {
    const r = decodeGrid(gray, rgba, prior);
    if (r.packets.length) return { quad: outline(prior), ...r, packet: r.packets[0], finders: [], homography: prior };
  }
  const finders = findFinders(gray());
  let first: FrameRead | null = null;
  let attempts = 0;
  for (const centers of cornerSets(finders)) {
    if (attempts++ >= MAX_ATTEMPTS) break;
    const hm = solveHomography(FINDER_CENTERS, centers);
    if (!hm) continue;
    const r = decodeGrid(gray, rgba, hm);
    const read: FrameRead = { quad: outline(hm), ...r, packet: r.packets[0] ?? null, finders, homography: r.packets.length ? hm : null };
    if (read.packet) return read;
    first ??= read;
  }
  return first ?? { quad: null, modules: null, packet: null, packets: [], colors: 2, finders, homography: null };
}
