import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LTEncoder,
  LTDecoder,
  encodePacket,
  decodePacket,
  mulberry32,
  packetToModules,
  modulesToPacket,
  rasterize,
  sampleAxisAligned,
  GRID_SIZE,
  MAX_BLOCK_SIZE,
  FRAME_CAPACITY_BYTES,
  type RgbaImage,
} from '../src/index.ts';

function randomBytes(n: number, seed = 1): Uint8Array {
  const rng = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
}

// Pastes the raster into a larger noisy dark canvas, like a screenshot of the app.
function embed(src: RgbaImage, width: number, height: number, ox: number, oy: number, noise: number): RgbaImage {
  const rng = mulberry32(77);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 12;
    data[i + 3] = 255;
  }
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      const d = ((y + oy) * width + x + ox) * 4;
      for (let c = 0; c < 3; c++) data[d + c] = src.data[s + c] + (rng() - 0.5) * 2 * noise;
    }
  }
  return { width, height, data };
}

test('frame capacity fits a max-size packet', () => {
  assert.equal(FRAME_CAPACITY_BYTES, (GRID_SIZE * GRID_SIZE - 4 * 64) / 8);
  assert.equal(MAX_BLOCK_SIZE, 460);
});

test('packet survives modules round-trip', () => {
  const enc = new LTEncoder(randomBytes(5000), MAX_BLOCK_SIZE, 9);
  const pkt = encodePacket(enc.config, enc.droplet(enc.k + 1));
  const parsed = decodePacket(modulesToPacket(packetToModules(pkt)));
  assert.ok(parsed);
  assert.equal(parsed.droplet.seed, enc.k + 1);
});

test('whitening keeps an all-zero packet visually balanced', () => {
  const modules = packetToModules(new Uint8Array(FRAME_CAPACITY_BYTES));
  const dark = modules.reduce((a, b) => a + b, 0) / modules.length;
  assert.ok(dark > 0.4 && dark < 0.6, `dark ratio ${dark}`);
});

test('file decodes from scaled, offset, noisy screenshots of every frame', () => {
  const data = randomBytes(3000, 4);
  const enc = new LTEncoder(data, MAX_BLOCK_SIZE, 0xc0ffee);
  const dec = new LTDecoder(enc.config);
  for (let i = 0; i < enc.k; i++) {
    const raster = rasterize(packetToModules(encodePacket(enc.config, enc.next())), 5);
    const shot = embed(raster, raster.width + 90, raster.height + 40, 37, 11, 40);
    const modules = sampleAxisAligned(shot);
    assert.ok(modules);
    const parsed = decodePacket(modulesToPacket(modules));
    assert.ok(parsed, `frame ${i} failed CRC`);
    dec.add(parsed.droplet);
  }
  assert.deepEqual(dec.result(), data);
});

test('a single flipped module is rejected by the CRC', () => {
  const enc = new LTEncoder(randomBytes(800), 256, 3);
  const modules = packetToModules(encodePacket(enc.config, enc.next()));
  modules[GRID_SIZE * 10 + 20] ^= 1;
  assert.equal(decodePacket(modulesToPacket(modules)), null);
});
