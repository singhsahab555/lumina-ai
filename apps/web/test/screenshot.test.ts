// Decodes the sample file from real browser screenshots of the transmitter
// canvas (captured by scripts/capture.mjs), proving the on-screen frames carry
// valid packets end to end: pixels → modules → CRC → LT → inflate → envelope
// → SHA-256 → bytes. Both the axis-aligned sampler and the camera path
// (finders + homography) must read every shot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { LTDecoder, decodePacket, modulesToPacket, openEnvelope, readFrame, sampleAxisAligned } from '@lumina/protocol';
import { readPng } from './png.ts';

const dir = new URL('./fixtures/frames/', import.meta.url);
const shots = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
const original = readFileSync(new URL('../public/samples/pump-station-log.txt', import.meta.url));

function decodeShot(name: string) {
  const modules = sampleAxisAligned(readPng(readFileSync(new URL(name, dir))));
  assert.ok(modules, `${name}: no grid found`);
  return decodePacket(modulesToPacket(modules));
}

test('every screenshot decodes to a CRC-valid packet', () => {
  assert.ok(shots.length > 0, 'no fixtures; run npm run capture');
  for (const name of shots) assert.ok(decodeShot(name), `${name} failed CRC`);
});

test('the camera path (finders + homography) reads every screenshot too', () => {
  for (const name of shots) assert.ok(readFrame(readPng(readFileSync(new URL(name, dir)))).packet, `${name}: camera path failed`);
});

test('sample file is recovered byte-exact from screenshots', () => {
  let decoder: LTDecoder | null = null;
  for (const name of shots) {
    const packet = decodeShot(name)!;
    decoder ??= new LTDecoder(packet.config);
    decoder.add(packet.droplet);
  }
  assert.ok(decoder?.done);
  const env = openEnvelope(inflateRawSync(decoder.result()));
  assert.equal(env.name, 'pump-station-log.txt');
  assert.equal(env.verified, true);
  assert.deepEqual(Buffer.from(env.file), original);
});
