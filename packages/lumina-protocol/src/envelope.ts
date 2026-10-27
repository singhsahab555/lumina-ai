// File envelope carried inside the (deflated) LT payload, so the receiver
// learns the file name and can prove the bytes it rebuilt are the bytes sent.
//
//  offset size field
//   0      4   magic 'LUMF'
//   4      1   version
//   5     32   SHA-256 of the file
//  37      1   name length n (UTF-8 bytes)
//  38      n   name
//  38+n    *   file bytes

import { sha256 } from './sha256.ts';

const MAGIC = [0x4c, 0x55, 0x4d, 0x46];
export const ENVELOPE_VERSION = 1;
const FIXED = 38;

export interface OpenedEnvelope {
  name: string;
  file: Uint8Array;
  /** SHA-256 the sender declared. */
  expectedSha256: Uint8Array;
  /** SHA-256 of the bytes actually received. */
  sha256: Uint8Array;
  verified: boolean;
}

export function sealEnvelope(name: string, file: Uint8Array): Uint8Array {
  let nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > 255) nameBytes = nameBytes.subarray(0, 255);
  const out = new Uint8Array(FIXED + nameBytes.length + file.length);
  out.set(MAGIC, 0);
  out[4] = ENVELOPE_VERSION;
  out.set(sha256(file), 5);
  out[37] = nameBytes.length;
  out.set(nameBytes, FIXED);
  out.set(file, FIXED + nameBytes.length);
  return out;
}

/** Throws on a malformed envelope; a hash mismatch is reported, not thrown. */
export function openEnvelope(bytes: Uint8Array): OpenedEnvelope {
  if (bytes.length < FIXED || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error('not a Lumina file envelope');
  if (bytes[4] !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${bytes[4]}`);
  const n = bytes[37];
  if (bytes.length < FIXED + n) throw new Error('truncated envelope');
  const name = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(FIXED, FIXED + n));
  const file = bytes.slice(FIXED + n);
  const expectedSha256 = bytes.slice(5, 37);
  const actual = sha256(file);
  return { name, file, expectedSha256, sha256: actual, verified: actual.every((b, i) => b === expectedSha256[i]) };
}
