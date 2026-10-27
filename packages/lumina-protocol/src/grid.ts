// 2-color optical grid: one packet per symbol, 1 bit per module.
//
//   ┌────────┬──────────────────────────────┬────────┐
//   │ finder │                              │ finder │   Each corner holds a 7×7
//   │  TL    │                              │  TR    │   finder plus a 1-module
//   ├────────┘                              └────────┤   light separator (8×8).
//   │                 data modules                   │
//   │        (row-major, skipping corners)           │   BR finder has a hollow
//   ├────────┐                              ┌────────┤   core with a centre dot,
//   │ finder │                              │ finder │   so the receiver can tell
//   │  BL    │                              │  BR*   │   rotation/mirroring apart.
//   └────────┴──────────────────────────────┴────────┘
//
// Data bits are XORed with a fixed whitening mask so zero-padded tails and
// headers never render as large solid areas, which cameras sample badly.
// Changing GRID_SIZE, the finder layout, or the mask breaks wire compatibility.

import { mulberry32 } from './prng.ts';
import { HEADER_SIZE, CRC_SIZE } from './packet.ts';

export const GRID_SIZE = 64;
export const FINDER_SIZE = 7;
const CORNER = FINDER_SIZE + 1;
const MASK_SEED = 0x4c554d49; // 'LUMI'

/** 1 = dark module, 0 = light module. Indexed [y * GRID_SIZE + x]. */
export type Modules = Uint8Array;

function inCorner(x: number, y: number): boolean {
  const nearX = x < CORNER || x >= GRID_SIZE - CORNER;
  const nearY = y < CORNER || y >= GRID_SIZE - CORNER;
  return nearX && nearY;
}

/** Data module positions (as y * GRID_SIZE + x) in bit order. */
export const DATA_MODULES: Uint32Array = (() => {
  const out: number[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) if (!inCorner(x, y)) out.push(y * GRID_SIZE + x);
  }
  return Uint32Array.from(out);
})();

export const FRAME_CAPACITY_BYTES = DATA_MODULES.length >>> 3;
/** Largest LT block size that fits one packet in one 2-color frame. */
export const MAX_BLOCK_SIZE = FRAME_CAPACITY_BYTES - HEADER_SIZE - CRC_SIZE;

const MASK: Uint8Array = (() => {
  const rng = mulberry32(MASK_SEED);
  return Uint8Array.from({ length: DATA_MODULES.length }, () => (rng() < 0.5 ? 1 : 0));
})();

// Module value inside a 7×7 finder at local (fx, fy).
function finderModule(fx: number, fy: number, marked: boolean): number {
  const ring = Math.max(Math.abs(fx - 3), Math.abs(fy - 3));
  if (ring === 3) return 1;
  if (ring === 2) return 0;
  if (!marked) return 1;
  return ring === 0 ? 1 : 0;
}

function drawFinders(modules: Modules): void {
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
        modules[(oy + fy) * GRID_SIZE + ox + fx] = finderModule(fx, fy, marked);
      }
    }
  }
}

/** Lays one encoded packet out as a module grid. */
export function packetToModules(packet: Uint8Array): Modules {
  if (packet.length > FRAME_CAPACITY_BYTES) {
    throw new Error(`packet ${packet.length} B exceeds frame capacity ${FRAME_CAPACITY_BYTES} B`);
  }
  const modules = new Uint8Array(GRID_SIZE * GRID_SIZE);
  drawFinders(modules);
  for (let i = 0; i < DATA_MODULES.length; i++) {
    const byte = i >>> 3;
    const bit = byte < packet.length ? (packet[byte] >>> (7 - (i & 7))) & 1 : 0;
    modules[DATA_MODULES[i]] = bit ^ MASK[i];
  }
  return modules;
}

/** Inverse of packetToModules. Feed the result to decodePacket, which checks the CRC. */
export function modulesToPacket(modules: Modules): Uint8Array {
  const out = new Uint8Array(FRAME_CAPACITY_BYTES);
  for (let i = 0; i < FRAME_CAPACITY_BYTES * 8; i++) {
    if (modules[DATA_MODULES[i]] ^ MASK[i]) out[i >>> 3] |= 0x80 >>> (i & 7);
  }
  return out;
}
