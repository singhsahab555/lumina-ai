// 8-color palette: the corners of the RGB cube. Bit p of a palette index is
// bit-plane p, and a set bit means that channel is OFF (dark), matching the
// 2-color convention 1 = dark:
//
//   bit 0 → G off, bit 1 → R off, bit 2 → B off      0 = white, 7 = black
//
// G carries most of the luma, so plane 0 splits cleanly by brightness alone
// (white/yellow/cyan/green ≥ 150 vs magenta/red/blue/black ≤ 105). A camera
// that loses colour still reads plane 0 through the 2-color pipeline: that is
// the 8 → 2 fallback, with no back channel needed. Wire format.

import type { Colors } from './grid.ts';

export type Rgb = readonly [number, number, number];

export const PALETTE: readonly Rgb[] = Array.from({ length: 8 }, (_, v) => [v & 2 ? 0 : 255, v & 1 ? 0 : 255, v & 4 ? 0 : 255] as const);

export const DARK_RGB: Rgb = [0, 0, 0];
export const LIGHT_RGB: Rgb = [255, 255, 255];

/** On-screen colour of a module value in the given mode. */
export function moduleRgb(value: number, colors: Colors): Rgb {
  if (colors === 8) return PALETTE[value];
  return value ? DARK_RGB : LIGHT_RGB;
}
