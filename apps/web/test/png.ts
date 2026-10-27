// Minimal PNG reader for test fixtures: 8-bit RGB/RGBA, non-interlaced.

import { inflateSync } from 'node:zlib';
import type { RgbaImage } from '@lumina/protocol';

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function readPng(file: Uint8Array): RgbaImage {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let off = 8; off < file.length; ) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...file.subarray(off + 4, off + 8));
    const body = file.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      const [depth, color, , , interlace] = body.subarray(8);
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error('unsupported PNG');
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    off += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const pred = [0, a, b, (a + b) >>> 1, paeth(a, b, c)][filter];
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set(px.subarray(i * channels, i * channels + 3), i * 4);
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
