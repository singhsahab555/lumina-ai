import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  LTDecoder,
  LTEncoder,
  MAX_BLOCK_SIZE,
  encodePacket,
  mulberry32,
  openEnvelope,
  packetToModules,
  readFrame,
  sealEnvelope,
  sha256,
  toHex,
  GRID_SIZE,
  type GrayImage,
} from '../src/index.ts';
import { placeGrid, simulateCamera, type CameraSim } from '../src/synth.ts';

function randomBytes(n: number, seed = 1): Uint8Array {
  const rng = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
}

const payload = randomBytes(3000, 9);
const encoder = new LTEncoder(payload, MAX_BLOCK_SIZE, 0xc0ffee);
const frame = (seed: number) => packetToModules(encodePacket(encoder.config, encoder.droplet(seed)));

const W = 1280;
const H = 720;
const camera = (seed: number, sim: Partial<CameraSim>) =>
  simulateCamera(frame(seed), { width: W, height: H, corners: placeGrid(640, 360, 560), blur: 1, noise: 6, ...sim });

function assertReads(img: GrayImage, seed: number, label: string) {
  const r = readFrame(img);
  assert.ok(r.packet, `${label}: no valid packet (${r.finders.length} finders, quad ${r.quad ? 'found' : 'none'})`);
  assert.equal(r.packet.droplet.seed, seed, label);
  assert.equal(r.packet.config.sessionId, 0xc0ffee, label);
}

test('reads a tilted, blurred, noisy, unevenly lit camera frame', () => {
  const t0 = performance.now();
  assertReads(camera(3, { corners: placeGrid(600, 380, 600, 12, 0.12), gradient: 0.35, blur: 2, noise: 10 }), 3, 'tilted');
  assert.ok(performance.now() - t0 < 2000);
});

test('handles every rotation and a mirrored view', () => {
  for (const deg of [0, 90, 180, 270, 33]) assertReads(camera(deg, { corners: placeGrid(640, 360, 520, deg, 0.05) }), deg, `${deg}°`);
  const mirrored = placeGrid(640, 360, 520, 8);
  assertReads(camera(7, { corners: [mirrored[1], mirrored[0], mirrored[3], mirrored[2]] }), 7, 'mirrored');
});

test('reads a small grid (~5 px per module) far from the camera', () => {
  assertReads(camera(11, { corners: placeGrid(400, 300, 72 * 5, -6, 0.04), blur: 1, noise: 6 }), 11, 'small');
});

test('frames torn between two symbols (rolling shutter) fail the CRC instead of decoding wrong', () => {
  const a = camera(1, {});
  const b = camera(2, {});
  a.data.set(b.data.subarray(W * (H / 2)), W * (H / 2));
  const r = readFrame(a);
  assert.ok(r.quad, 'grid should still be located');
  assert.equal(r.packet, null);
});

test('empty, flat and noise frames return nothing and do not throw', () => {
  const rng = mulberry32(5);
  for (const data of [new Uint8Array(W * H), new Uint8Array(W * H).fill(200), Uint8Array.from({ length: W * H }, () => rng() * 255)]) {
    assert.equal(readFrame({ width: W, height: H, data }).packet, null);
  }
});

test('camera frames carry a whole file end to end, with SHA-256 verification', () => {
  const file = new TextEncoder().encode('P-07B work order\n'.repeat(200));
  const env = sealEnvelope('wo-1027.txt', file);
  const enc = new LTEncoder(env, MAX_BLOCK_SIZE, 42);
  let dec: LTDecoder | null = null;
  // Drop every third frame, as a camera out of phase with the screen would.
  for (let seed = 0; seed < enc.k * 3 && !dec?.done; seed++) {
    if (seed % 3 === 1) continue;
    const modules = packetToModules(encodePacket(enc.config, enc.droplet(seed)));
    const corners = placeGrid(640 + (seed % 5) * 10, 360, 540, seed * 3 - 6, 0.06);
    const r = readFrame(simulateCamera(modules, { width: W, height: H, corners, blur: 1, noise: 8, seed }));
    if (!r.packet) continue;
    dec ??= new LTDecoder(r.packet.config);
    dec.add(r.packet.droplet);
  }
  assert.ok(dec?.done, 'decoder did not finish');
  const opened = openEnvelope(dec.result());
  assert.equal(opened.name, 'wo-1027.txt');
  assert.equal(opened.verified, true);
  assert.deepEqual(opened.file, file);
});

test('sha256 matches node:crypto', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const b = randomBytes(n, n + 1);
    assert.equal(toHex(sha256(b)), createHash('sha256').update(b).digest('hex'), `n=${n}`);
  }
});

test('envelope detects a tampered file', () => {
  const env = sealEnvelope('a.bin', randomBytes(100));
  env[env.length - 1] ^= 1;
  assert.equal(openEnvelope(env).verified, false);
  assert.throws(() => openEnvelope(new Uint8Array(10)));
});

test('grid constant sanity', () => assert.equal(GRID_SIZE, 64));
