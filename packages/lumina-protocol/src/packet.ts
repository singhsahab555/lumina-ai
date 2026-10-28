// Wire format for one optical frame. Every frame is self-describing so the
// receiver can join mid-stream with no handshake.
//
//  offset size field
//   0      1   magic 0x4C ('L')
//   1      1   version
//   2      4   sessionId
//   6      4   totalLength (bytes of the payload being transferred)
//  10      2   blockSize
//  12      4   seed
//  16      N   droplet data (N == blockSize)
//  16+N    4   CRC-32 over bytes [0, 16+N)
//
// Corrupted frames fail the CRC and are simply dropped; the fountain code
// treats them as erasures, so no per-frame error correction is needed yet.

import type { Droplet, LTConfig } from './lt.ts';

export const MAGIC = 0x4c;
export const VERSION = 3;
export const HEADER_SIZE = 16;
export const CRC_SIZE = 4;

export function packetSize(blockSize: number): number {
  return HEADER_SIZE + blockSize + CRC_SIZE;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodePacket(config: LTConfig, droplet: Droplet): Uint8Array {
  const buf = new Uint8Array(packetSize(config.blockSize));
  const view = new DataView(buf.buffer);
  view.setUint8(0, MAGIC);
  view.setUint8(1, VERSION);
  view.setUint32(2, config.sessionId);
  view.setUint32(6, config.totalLength);
  view.setUint16(10, config.blockSize);
  view.setUint32(12, droplet.seed);
  buf.set(droplet.data, HEADER_SIZE);
  view.setUint32(HEADER_SIZE + config.blockSize, crc32(buf.subarray(0, HEADER_SIZE + config.blockSize)));
  return buf;
}

export interface DecodedPacket {
  config: LTConfig;
  droplet: Droplet;
}

/** Returns null for anything that is not a valid, uncorrupted frame. */
export function decodePacket(buf: Uint8Array): DecodedPacket | null {
  if (buf.length < HEADER_SIZE + CRC_SIZE) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint8(0) !== MAGIC || view.getUint8(1) !== VERSION) return null;

  const blockSize = view.getUint16(10);
  if (buf.length < packetSize(blockSize)) return null;
  const body = HEADER_SIZE + blockSize;
  if (view.getUint32(body) !== crc32(buf.subarray(0, body))) return null;

  return {
    config: {
      sessionId: view.getUint32(2),
      totalLength: view.getUint32(6),
      blockSize,
    },
    droplet: {
      seed: view.getUint32(12),
      data: buf.slice(HEADER_SIZE, body),
    },
  };
}
