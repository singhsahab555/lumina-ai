import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_PLANES,
  LTDecoder,
  LTEncoder,
  MAX_BLOCK_SIZE,
  PALETTE,
  decodePacket,
  encodePacket,
  modulesToPacket,
  mulberry32,
  packetToModules,
  packetsToColorModules,
  readFrame,
  toGray,
  type Colors,
} from '../src/index.ts';
import { placeGrid, simulateCameraRgb, type ColorCameraSim } from '../src/synth.ts';

function randomBytes(n: number, seed = 1): Uint8Array {
  const rng = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
}

const encoder = new LTEncoder(randomBytes(20_000, 2), MAX_BLOCK_SIZE, 0xbada55);
const packet = (seed: number) => encodePacket(encoder.config, encoder.droplet(seed));
const symbol8 = (s: number) => packetsToColorModules([0, 1, 2].map((p) => packet(s * COLOR_PLANES + p)));

const W = 1280;
const H = 720;
const phone: Partial<ColorCameraSim> = { blur: 1, noise: 8, crosstalk: 0.1, tint: [1, 0.93, 0.8], gradient: 0.3 };
const shoot = (modules: Uint8Array, colors: Colors, sim: Partial<ColorCameraSim>) =>
  simulateCameraRgb(modules, colors, { width: W, height: H, corners: placeGrid(640, 360, 540, 9, 0.06), ...phone, ...sim });

test('palette bit p is plane p, and plane 0 splits by luma', () => {
  const luma = ([r, g, b]: readonly number[]) => 0.299 * r + 0.587 * g + 0.114 * b;
  assert.deepEqual(PALETTE[0], [255, 255, 255]);
  assert.deepEqual(PALETTE[7], [0, 0, 0]);
  const on = PALETTE.filter((_, v) => !(v & 1)).map(luma);
  const off = PALETTE.filter((_, v) => v & 1).map(luma);
  assert.ok(Math.min(...on) > Math.max(...off) + 40);
});

test('every plane of an 8-color grid round-trips through modules', () => {
  const modules = symbol8(4);
  for (let p = 0; p < COLOR_PLANES; p++) assert.equal(decodePacket(modulesToPacket(modules, p))?.droplet.seed, 12 + p);
});

test('8-color camera frame (crosstalk, colour cast, gradient, tilt) yields all 3 planes', () => {
  for (const [i, sim] of [
    [1, {}],
    [2, { corners: placeGrid(620, 360, 480, 33, 0.1), blur: 2 }],
    [3, { corners: placeGrid(400, 300, 72 * 6, -6, 0.04) }],
  ] as const) {
    const r = readFrame(shoot(symbol8(i), 8, { seed: i, ...sim }));
    assert.equal(r.colors, 8, `case ${i}`);
    assert.deepEqual(
      r.packets.map((p) => p.droplet.seed).sort((a, b) => a - b),
      [0, 1, 2].map((p) => i * 3 + p),
      `case ${i}`,
    );
  }
});

test('the receiver auto-detects 2-color frames from the border', () => {
  const r = readFrame(shoot(packetToModules(packet(7)), 2, {}));
  assert.equal(r.colors, 2);
  assert.deepEqual(
    r.packets.map((p) => p.droplet.seed),
    [7],
  );
});

test('8 → 2 fallback: a camera that loses colour still reads plane 0 by luma', () => {
  const r = readFrame(toGray(shoot(symbol8(5), 8, { crosstalk: 0.03 })));
  assert.equal(r.packet?.droplet.seed, 15);
});

test('8-color needs at most half the symbols of 2-color for the same file', () => {
  // Same camera, every third symbol lost; count symbols until the decode completes.
  const data = randomBytes(9000, 8);
  const symbolsFor = (colors: Colors) => {
    const enc = new LTEncoder(data, MAX_BLOCK_SIZE, colors);
    const planes = colors === 8 ? COLOR_PLANES : 1;
    const dec = new LTDecoder(enc.config);
    let shown = 0;
    for (let s = 0; !dec.done && s < enc.k * 3; s++) {
      shown++;
      if (s % 3 === 2) continue;
      const pkts = Array.from({ length: planes }, (_, p) => encodePacket(enc.config, enc.droplet(s * planes + p)));
      const modules = colors === 8 ? packetsToColorModules(pkts) : packetToModules(pkts[0]);
      const img = simulateCameraRgb(modules, colors, { width: 800, height: 600, corners: placeGrid(400, 300, 470, s * 7, 0.05), ...phone, seed: s });
      for (const p of readFrame(img).packets) dec.add(p.droplet);
    }
    assert.ok(dec.done, `${colors}-color did not finish`);
    assert.deepEqual(dec.result(), data);
    return shown;
  };
  const two = symbolsFor(2);
  const eight = symbolsFor(8);
  assert.ok(two >= 2 * eight, `2-color ${two} symbols vs 8-color ${eight}`);
});
