// Camera-frame reader for the 2-color grid, in plain TypeScript (no OpenCV):
//
//   RGBA → luma → adaptive threshold → connected components → finder rings
//   → pick 3 plain + 1 marked finder → homography from the finder centres
//   → sample 64×64 modules → local-mean threshold → packet → CRC.
//
// A finder is a dark ring whose hole contains a separate dark core: 3×3
// modules for the plain finders, a 1×1 dot for the marked BR one. The core
// centroid is the finder centre, which is accurate even under perspective
// because the core is small. The CRC is the final judge: every plausible
// corner assignment (including a mirrored one) is tried until one passes.

import { GRID_SIZE, modulesToPacket, type Modules } from './grid.ts';
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
  packet: DecodedPacket | null;
  finders: Finder[];
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
  const marked = finders.filter((f) => f.marked).slice(0, 3);
  for (const br of marked) {
    const plain = finders.filter((f) => !f.marked && f.size > br.size * 0.4 && f.size < br.size * 2.5).slice(0, 4);
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

/** Samples the module grid through H (module space → image). Null if it leaves the frame. */
export function sampleModules(g: GrayImage, hm: Homography): Modules | null {
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

const MAX_ATTEMPTS = 8;

/** Locates, samples and CRC-checks one camera frame. Never throws on bad input. */
export function readFrame(img: RgbaImage | GrayImage): FrameRead {
  const g = 'data' in img && img.data.length === img.width * img.height ? (img as GrayImage) : toGray(img as RgbaImage);
  const finders = findFinders(g);
  let first: FrameRead | null = null;
  let attempts = 0;
  for (const centers of cornerSets(finders)) {
    if (attempts++ >= MAX_ATTEMPTS) break;
    const hm = solveHomography(FINDER_CENTERS, centers);
    if (!hm) continue;
    const quad = [
      [0, 0],
      [GRID_SIZE, 0],
      [GRID_SIZE, GRID_SIZE],
      [0, GRID_SIZE],
    ].map(([x, y]) => applyHomography(hm, x, y));
    const modules = sampleModules(g, hm);
    const packet = modules ? decodePacket(modulesToPacket(modules)) : null;
    if (packet) return { quad, modules, packet, finders };
    first ??= { quad, modules, packet: null, finders };
  }
  return first ?? { quad: null, modules: null, packet: null, finders };
}
