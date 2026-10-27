// The worker's state machine, fed synthetic camera frames: two transfers on
// screen at once must not mix, and the file must come out SHA-verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { LTEncoder, MAX_BLOCK_SIZE, encodePacket, packetToModules, sealEnvelope, type GrayImage } from '@lumina/protocol';
import { placeGrid, simulateCamera } from '@lumina/protocol/synth';
import { ReceiverSession, unpack } from '../src/lib/receiver.ts';

const toRgba = (g: GrayImage) => {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i++) data.set([g.data[i], g.data[i], g.data[i], 255], i * 4);
  return { width: g.width, height: g.height, data };
};

function transfer(name: string, text: string, sessionId: number) {
  const file = new TextEncoder().encode(text);
  return { file, enc: new LTEncoder(deflateRawSync(sealEnvelope(name, file)), MAX_BLOCK_SIZE, sessionId) };
}

const shot = (enc: LTEncoder, seed: number) =>
  toRgba(
    simulateCamera(packetToModules(encodePacket(enc.config, enc.droplet(seed))), {
      width: 960,
      height: 540,
      corners: placeGrid(480, 270, 460, seed * 2, 0.05),
      blur: 1,
      noise: 6,
      seed,
    }),
  );

test('interleaved sessions decode independently into verified files', async () => {
  let text = '';
  for (let i = 0; text.length < 4000; i++) text += `[${i}] P-07B vib ${(2 + (i % 7) / 3).toFixed(2)} mm/s seed ${(i * 2654435761) >>> 0}\n`;
  const a = transfer('a.txt', text, 1);
  const b = transfer('b.txt', 'stray frame from an older transfer\n', 2);
  const rx = new ReceiverSession();
  let payload: Uint8Array | null = null;
  for (let seed = 0; seed < a.enc.k * 3 && !payload; seed++) {
    if (seed % 4 === 2) rx.push(shot(b.enc, seed)); // the other session leaks in
    payload = rx.push(shot(a.enc, seed)).payload;
  }
  assert.ok(payload, `not done: ${JSON.stringify(rx.stats())}`);
  assert.equal(rx.stats().sessionId, 1);
  const got = await unpack(payload);
  assert.equal(got.name, 'a.txt');
  assert.equal(got.verified, true);
  assert.deepEqual(got.bytes, a.file);
});

test('unpack flags a corrupted payload instead of returning it as verified', async () => {
  const env = sealEnvelope('x.txt', new TextEncoder().encode('setpoint 6.2 bar'));
  env[env.length - 1] ^= 1;
  const got = await unpack(deflateRawSync(env));
  assert.equal(got.verified, false);
});
