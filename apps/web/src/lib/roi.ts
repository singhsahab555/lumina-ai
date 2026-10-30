// Region of interest from SAM 3.1. Without one, every camera frame is
// downscaled to MAX_SIDE before decoding, so a far screen that fills a small
// part of a 1080p webcam view loses pixels per module. With one, the decoder
// reads only the screen, at native camera resolution.

import type { Point } from '@lumina/protocol';
import type { SamMatch } from '@lumina/agents';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Crop {
  /** Source rectangle in video pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Size of the image handed to the decoder. */
  dw: number;
  dh: number;
}

// SAM boxes the monitor; the grid sits inside it, but the bezel can clip
// finders when the box is tight, so pad it.
const MARGIN = 0.12;

/** SAM's box (in the still it was sent) as a padded rect in video pixels. */
export function roiFromMatch(m: SamMatch, videoW: number, videoH: number): Rect {
  const kx = videoW / m.width;
  const ky = videoH / m.height;
  const w = (m.box.x2 - m.box.x1) * kx;
  const h = (m.box.y2 - m.box.y1) * ky;
  const x = Math.max(0, m.box.x1 * kx - w * MARGIN);
  const y = Math.max(0, m.box.y1 * ky - h * MARGIN);
  return {
    x,
    y,
    w: Math.min(videoW, m.box.x2 * kx + w * MARGIN) - x,
    h: Math.min(videoH, m.box.y2 * ky + h * MARGIN) - y,
  };
}

export function cropFor(videoW: number, videoH: number, maxSide: number, roi: Rect | null): Crop {
  const r = roi ?? { x: 0, y: 0, w: videoW, h: videoH };
  const sx = Math.round(r.x);
  const sy = Math.round(r.y);
  const sw = Math.max(1, Math.min(videoW - sx, Math.round(r.w)));
  const sh = Math.max(1, Math.min(videoH - sy, Math.round(r.h)));
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  return { sx, sy, sw, sh, dw: Math.round(sw * scale), dh: Math.round(sh * scale) };
}

/** Maps a point found in the decoder image back to video pixels. */
export const toVideo = (p: Point, c: Crop): Point => ({ x: c.sx + (p.x * c.sw) / c.dw, y: c.sy + (p.y * c.sh) / c.dh });
