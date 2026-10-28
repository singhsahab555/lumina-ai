// Optical grid, wire format v2. 2-color mode: 1 bit per module, one packet
// per symbol. 8-color mode: 3 bits per module, one packet per bit-plane, so a
// symbol carries 3 independently CRC-checked droplets (see palette.ts).
//
//   ┌────────┬──────────────────────────────┬────────┐
//   │ finder │   calibration border (row 0) │ finder │   Each corner holds a 7×7
//   │  TL    │                              │  TR    │   finder plus a 1-module
//   ├────────┘                              └────────┤   light separator (8×8).
//   │                 data modules                   │
//   │        (row-major, skipping corners)           │   BR finder has a hollow
//   ├────────┐                              ┌────────┤   core with a centre dot,
//   │ finder │                              │ finder │   so the receiver can tell
//   │  BL    │                              │  BR*   │   rotation/mirroring apart.
//   └────────┴──────────────────────────────┴────────┘
//
// The edge rows/columns between finders are the calibration border. In
// 8-color mode it cycles through the palette (slot = walk index mod 8), so the
// receiver learns how this screen + camera render each colour; in 2-color
// mode it alternates dark/light.
//
// Data bits are XORed with a fixed whitening mask (one per plane) so
// zero-padded tails and headers never render as large solid areas, which
// cameras sample badly. Changing GRID_SIZE, the finder layout, the border or
// the masks breaks wire compatibility.

import { mulberry32 } from './prng.ts';
import { HEADER_SIZE, CRC_SIZE } from './packet.ts';

export const GRID_SIZE = 64;
export const FINDER_SIZE = 7;
const CORNER = FINDER_SIZE + 1;
const LAST = GRID_SIZE - 1;
const MASK_SEED = 0x4c554d49; // 'LUMI'
/** Bit-planes in an 8-color symbol. Plane 0 is the one 2-color mode uses. */
export const COLOR_PLANES = 3;

/**
 * Indexed [y * GRID_SIZE + x]. 2-color: 1 = dark, 0 = light. 8-color: a
 * palette index whose bit p is plane p's bit (1 = that channel dark).
 */
export type Modules = Uint8Array;
export type Colors = 2 | 8;

function inCorner(x: number, y: number): boolean {
  const nearX = x < CORNER || x >= GRID_SIZE - CORNER;
  const nearY = y < CORNER || y >= GRID_SIZE - CORNER;
  return nearX && nearY;
}

/** Calibration border positions in walk order: top →, right ↓, bottom ←, left ↑. */
export const BORDER_MODULES: Uint32Array = (() => {
  const out: number[] = [];
  for (let x = CORNER; x < GRID_SIZE - CORNER; x++) out.push(x);
  for (let y = CORNER; y < GRID_SIZE - CORNER; y++) out.push(y * GRID_SIZE + LAST);
  for (let x = GRID_SIZE - CORNER - 1; x >= CORNER; x--) out.push(LAST * GRID_SIZE + x);
  for (let y = GRID_SIZE - CORNER - 1; y >= CORNER; y--) out.push(y * GRID_SIZE);
  return Uint32Array.from(out);
})();
/** Border modules per side: side s holds walk indices [s * BORDER_SIDE, (s + 1) * BORDER_SIDE). */
export const BORDER_SIDE = BORDER_MODULES.length / 4;

/** Data module positions (as y * GRID_SIZE + x) in bit order. */
export const DATA_MODULES: Uint32Array = (() => {
  const out: number[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const edge = x === 0 || y === 0 || x === LAST || y === LAST;
      if (!inCorner(x, y) && !edge) out.push(y * GRID_SIZE + x);
    }
  }
  return Uint32Array.from(out);
})();

/** Bytes per bit-plane, i.e. one packet. */
export const FRAME_CAPACITY_BYTES = DATA_MODULES.length >>> 3;
/** Largest LT block size that fits one packet in one bit-plane. */
export const MAX_BLOCK_SIZE = FRAME_CAPACITY_BYTES - HEADER_SIZE - CRC_SIZE;

const MASKS: Uint8Array[] = Array.from({ length: COLOR_PLANES }, (_, p) => {
  const rng = mulberry32(MASK_SEED + p);
  return Uint8Array.from({ length: DATA_MODULES.length }, () => (rng() < 0.5 ? 1 : 0));
});

// Module value inside a 7×7 finder at local (fx, fy).
function finderModule(fx: number, fy: number, marked: boolean): number {
  const ring = Math.max(Math.abs(fx - 3), Math.abs(fy - 3));
  if (ring === 3) return 1;
  if (ring === 2) return 0;
  if (!marked) return 1;
  return ring === 0 ? 1 : 0;
}

function drawFinders(modules: Modules, dark: number): void {
  const far = GRID_SIZE - FINDER_SIZE;
  const origins: [number, number, boolean][] = [
    [0, 0, false],
    [far, 0, false],
    [0, far, false],
    [far, far, true],
  ];
  for (const [ox, oy, marked] of origins) {
    for (let fy = 0; fy < FINDER_SIZE; fy++) {
      for (let fx = 0; fx < FINDER_SIZE; fx++) {
        modules[(oy + fy) * GRID_SIZE + ox + fx] = finderModule(fx, fy, marked) * dark;
      }
    }
  }
}

function writePlane(modules: Modules, packet: Uint8Array, plane: number): void {
  if (packet.length > FRAME_CAPACITY_BYTES) {
    throw new Error(`packet ${packet.length} B exceeds frame capacity ${FRAME_CAPACITY_BYTES} B`);
  }
  const mask = MASKS[plane];
  for (let i = 0; i < DATA_MODULES.length; i++) {
    const byte = i >>> 3;
    const bit = byte < packet.length ? (packet[byte] >>> (7 - (i & 7))) & 1 : 0;
    modules[DATA_MODULES[i]] |= (bit ^ mask[i]) << plane;
  }
}

/** Lays one encoded packet out as a 2-color module grid. */
export function packetToModules(packet: Uint8Array): Modules {
  const modules = new Uint8Array(GRID_SIZE * GRID_SIZE);
  drawFinders(modules, 1);
  for (let i = 0; i < BORDER_MODULES.length; i++) modules[BORDER_MODULES[i]] = i & 1;
  writePlane(modules, packet, 0);
  return modules;
}

/** Lays COLOR_PLANES packets out as one 8-color grid of palette indices. */
export function packetsToColorModules(packets: Uint8Array[]): Modules {
  if (packets.length !== COLOR_PLANES) throw new Error(`an 8-color symbol needs ${COLOR_PLANES} packets`);
  const modules = new Uint8Array(GRID_SIZE * GRID_SIZE);
  drawFinders(modules, (1 << COLOR_PLANES) - 1);
  for (let i = 0; i < BORDER_MODULES.length; i++) modules[BORDER_MODULES[i]] = i & 7;
  packets.forEach((p, plane) => writePlane(modules, p, plane));
  return modules;
}

/**
 * Inverse of packetToModules (plane 0) or of one plane of
 * packetsToColorModules. Feed the result to decodePacket, which checks the CRC.
 */
export function modulesToPacket(modules: Modules, plane = 0): Uint8Array {
  const mask = MASKS[plane];
  const out = new Uint8Array(FRAME_CAPACITY_BYTES);
  for (let i = 0; i < FRAME_CAPACITY_BYTES * 8; i++) {
    if (((modules[DATA_MODULES[i]] >>> plane) & 1) ^ mask[i]) out[i >>> 3] |= 0x80 >>> (i & 7);
  }
  return out;
}
