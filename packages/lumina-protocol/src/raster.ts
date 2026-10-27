// Pixel-level helpers for the 2-color grid. rasterize() is what the
// transmitter puts on screen; sampleAxisAligned() reads a straight-on
// screenshot back into modules. Camera frames (perspective, blur) need the
// finder + homography path planned for Day 3; this is the lossless baseline.

import { GRID_SIZE, type Modules } from './grid.ts';

/** Structurally compatible with the DOM ImageData. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export const DARK_RGB = [0, 0, 0] as const;
export const LIGHT_RGB = [255, 255, 255] as const;

export function rasterize(modules: Modules, modulePx = 1, quietModules = 4): RgbaImage {
  const side = (GRID_SIZE + quietModules * 2) * modulePx;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let my = 0; my < GRID_SIZE; my++) {
    for (let mx = 0; mx < GRID_SIZE; mx++) {
      if (!modules[my * GRID_SIZE + mx]) continue;
      const x0 = (mx + quietModules) * modulePx;
      const y0 = (my + quietModules) * modulePx;
      for (let y = y0; y < y0 + modulePx; y++) {
        for (let x = x0; x < x0 + modulePx; x++) {
          const p = (y * side + x) * 4;
          data[p] = DARK_RGB[0];
          data[p + 1] = DARK_RGB[1];
          data[p + 2] = DARK_RGB[2];
        }
      }
    }
  }
  return { width: side, height: side, data };
}

function luma(img: RgbaImage, x: number, y: number): number {
  const p = (y * img.width + x) * 4;
  return 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
}

// Marks dark pixels connected to the image border: page chrome around the
// grid, which the light quiet zone separates from the grid itself.
function outsideMask(img: RgbaImage, threshold: number): Uint8Array {
  const { width, height } = img;
  const outside = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (!outside[i] && luma(img, x, y) < threshold) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return outside;
}

/**
 * Reads modules from an upright, unrotated screenshot at any scale/offset.
 * The four finders' outer rings are dark and sit exactly on the grid corners,
 * so the bounding box of dark pixels inside the quiet zone is the grid.
 * Returns null if no grid.
 */
export function sampleAxisAligned(img: RgbaImage): Modules | null {
  let lo = 255;
  let hi = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const l = luma(img, x, y);
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
  }
  if (hi - lo < 64) return null;
  const threshold = (lo + hi) / 2;

  const outside = outsideMask(img, threshold);
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (outside[y * img.width + x] || luma(img, x, y) >= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const cellW = (maxX - minX + 1) / GRID_SIZE;
  const cellH = (maxY - minY + 1) / GRID_SIZE;
  if (maxX < 0 || cellW < 1 || cellH < 1) return null;

  // Average the central half of each module to ride out anti-aliased edges.
  const rx = Math.max(0, Math.floor(cellW / 4));
  const ry = Math.max(0, Math.floor(cellH / 4));
  const modules = new Uint8Array(GRID_SIZE * GRID_SIZE);
  for (let my = 0; my < GRID_SIZE; my++) {
    for (let mx = 0; mx < GRID_SIZE; mx++) {
      const cx = Math.floor(minX + (mx + 0.5) * cellW);
      const cy = Math.floor(minY + (my + 0.5) * cellH);
      let sum = 0;
      let n = 0;
      for (let y = cy - ry; y <= cy + ry; y++) {
        for (let x = cx - rx; x <= cx + rx; x++) {
          sum += luma(img, x, y);
          n++;
        }
      }
      modules[my * GRID_SIZE + mx] = sum / n < threshold ? 1 : 0;
    }
  }
  return modules;
}
