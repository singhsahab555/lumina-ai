import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LTEncoder, LTDecoder, encodePacket, decodePacket, mulberry32 } from '../src/index.ts';

function randomBytes(n: number, seed = 1): Uint8Array {
  const rng = mulberry32(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
}

test('clean systematic pass decodes with zero overhead', () => {
  const data = randomBytes(10_000);
  const enc = new LTEncoder(data, 256, 42);
  const dec = new LTDecoder(enc.config);
  for (let i = 0; i < enc.k; i++) dec.add(enc.next());
  assert.equal(dec.received, enc.k);
  assert.deepEqual(dec.result(), data);
});

test('recovers from 30% random frame loss via fountain repair droplets', () => {
  const data = randomBytes(100_000, 7);
  const enc = new LTEncoder(data, 512, 1234);
  const dec = new LTDecoder(enc.config);
  const loss = mulberry32(99);
  let sent = 0;
  while (!dec.done && sent < enc.k * 5) {
    const d = enc.next();
    sent++;
    if (loss() < 0.3) continue;
    dec.add(d);
  }
  assert.ok(dec.done, `not done after ${sent} frames (K=${enc.k})`);
  assert.deepEqual(dec.result(), data);
});

test('decodes from repair droplets only (receiver missed the whole systematic pass)', () => {
  const data = randomBytes(50_000, 3);
  const enc = new LTEncoder(data, 256, 5);
  const dec = new LTDecoder(enc.config);
  let seed = enc.k;
  while (!dec.done && seed < enc.k * 4) dec.add(enc.droplet(seed++));
  assert.ok(dec.done);
  const overhead = dec.received / enc.k - 1;
  assert.ok(overhead < 0.6, `overhead ${(overhead * 100).toFixed(1)}%`);
  assert.deepEqual(dec.result(), data);
});

test('packet round-trips and rejects corruption', () => {
  const enc = new LTEncoder(randomBytes(1000), 128, 0xdeadbeef);
  const pkt = encodePacket(enc.config, enc.droplet(enc.k + 3));
  const parsed = decodePacket(pkt);
  assert.ok(parsed);
  assert.deepEqual(parsed.config, enc.config);
  assert.equal(parsed.droplet.seed, enc.k + 3);

  pkt[20] ^= 0x01;
  assert.equal(decodePacket(pkt), null);
});

test('handles payload smaller than one block', () => {
  const data = new TextEncoder().encode('hello lumina');
  const enc = new LTEncoder(data, 256, 1);
  const dec = new LTDecoder(enc.config);
  dec.add(enc.next());
  assert.deepEqual(dec.result(), data);
});
