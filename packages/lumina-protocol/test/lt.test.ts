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
  assert.ok(dec.inactivated > 0, 'Gaussian elimination should have finished the decode');
  assert.deepEqual(dec.result(), data);
});

test('inactivation decoding keeps repair-only overhead under 10%', () => {
  // 20 sessions per size; peeling alone needed ~26% median at K=200.
  for (const k of [50, 100, 200]) {
    const overheads: number[] = [];
    for (let s = 0; s < 20; s++) {
      const enc = new LTEncoder(randomBytes(k * 32, s + 11), 32, 1000 + s);
      const dec = new LTDecoder(enc.config);
      let seed = enc.k;
      while (!dec.done) dec.add(enc.droplet(seed++));
      overheads.push(dec.received / enc.k - 1);
    }
    overheads.sort((a, b) => a - b);
    const median = overheads[10];
    const mean = overheads.reduce((a, b) => a + b, 0) / overheads.length;
    assert.ok(median < 0.1 && mean < 0.1, `K=${k}: median ${(median * 100).toFixed(1)}%, mean ${(mean * 100).toFixed(1)}%`);
  }
});

test('mixed systematic + repair with heavy loss still decodes exactly', () => {
  const data = randomBytes(40_000, 21);
  const enc = new LTEncoder(data, 200, 77);
  const dec = new LTDecoder(enc.config);
  const loss = mulberry32(5);
  for (let seed = 0; !dec.done && seed < enc.k * 4; seed++) if (loss() >= 0.6) dec.add(enc.droplet(seed));
  assert.ok(dec.done);
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

test('1 MB file at 25% loss decodes incrementally with tiny overhead', () => {
  const data = randomBytes(1_000_000, 21);
  const enc = new LTEncoder(data, 436, 0x1a7e);
  const dec = new LTDecoder(enc.config);
  const loss = mulberry32(9);
  let seed = 0;
  const t0 = performance.now();
  while (!dec.done && seed < enc.k * 2) {
    const d = enc.droplet(seed++);
    if (loss() >= 0.25) dec.add(d);
  }
  assert.ok(dec.done);
  assert.ok(dec.received - enc.k <= 10, `overhead ${dec.received - enc.k} droplets`);
  // The Day 4 decoder re-ran full elimination and took seconds here; a generous bound.
  assert.ok(performance.now() - t0 < 5000);
  assert.deepEqual(dec.result(), data);
});
