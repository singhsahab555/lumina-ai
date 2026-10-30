// Return channel: the plant's signed ack, end to end through the same codec
// the order came in on, and the SAM 3.1 region that lets a webcam read a far
// screen at native resolution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readFrame, sealEnvelope, type RgbaImage } from '@lumina/protocol';
import { placeGrid, simulateCameraRgb } from '@lumina/protocol/synth';
import type { SamMatch } from '@lumina/agents';
import { ReceiverSession, unpack } from '../src/lib/receiver.ts';
import { Transmitter } from '../src/lib/transmitter.ts';
import { generatePlantKey, parseAck, signAck, verifyAck, type AckBody } from '../src/lib/ack.ts';
import { cropFor, roiFromMatch, toVideo } from '../src/lib/roi.ts';

const body = (over: Partial<AckBody> = {}): AckBody => ({
  file_name: 'ps07-work-order-tampered.json',
  file_sha256: 'ab'.repeat(32),
  file_bytes: 1813,
  work_order_id: 'WO-PS07-2026-0412',
  decision: 'reject',
  decided_by: 'deterministic policy gate, on this device, offline',
  findings: [
    { code: 'out_of_range', path: '$.steps[4].setpoint' },
    { code: 'injection_suspected', path: '$.steps[5].instruction' },
  ],
  telemetry: { seconds: 2.4, frames: 61, crcValid: 40, droplets: 12, k: 4 },
  issued_at: '2026-11-01T10:00:00.000Z',
  ...over,
});

const reparse = (o: unknown) => parseAck(new TextEncoder().encode(JSON.stringify(o)))!;

test('a signed ack verifies; a changed decision, a swapped key, or a non-ack file does not', async () => {
  const plant = await generatePlantKey();
  const ack = await signAck(body(), plant);
  const good = await verifyAck(reparse(ack));
  assert.equal(good.signatureOk, true);
  assert.match(good.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);

  // A compromised sender flips the plant's REJECT to APPROVE.
  const flipped = reparse({ ...ack, body: { ...ack.body, decision: 'approve', findings: [] } });
  assert.equal((await verifyAck(flipped)).signatureOk, false);

  // Another device signs its own approve and presents it: the signature holds, the fingerprint differs.
  const forger = await signAck(body({ decision: 'approve', findings: [] }), await generatePlantKey());
  const forged = await verifyAck(reparse(forger));
  assert.equal(forged.signatureOk, true);
  assert.notEqual(forged.fingerprint, good.fingerprint);

  // Splicing the real plant key onto the forged ack breaks the signature.
  assert.equal((await verifyAck(reparse({ ...forger, key: ack.key }))).signatureOk, false);

  assert.equal(parseAck(new TextEncoder().encode('{"schema":"lumina.work-order/v1"}')), null);
  assert.equal(parseAck(new TextEncoder().encode('not json')), null);
});

test('the ack crosses the light link back and verifies on the other side', async () => {
  const signed = await signAck(body(), await generatePlantKey());
  const bytes = new TextEncoder().encode(JSON.stringify(signed, null, 1));
  const tx = new Transmitter(deflateRawSync(sealEnvelope('ack-WO-PS07-2026-0412.json', bytes)), 7, 'auto');
  const rx = new ReceiverSession();
  let payload: Uint8Array | null = null;
  let symbols = 0;
  while (!payload && symbols < 20) {
    const s = tx.next();
    symbols++;
    // A laptop webcam looking at the plant screen: smaller, tilted, warm.
    const img = simulateCameraRgb(s.modules, s.colors, {
      width: 960,
      height: 540,
      corners: placeGrid(500, 280, 420, -4 + symbols, 0.06),
      blur: 1,
      noise: 6,
      crosstalk: 0.06,
      tint: [1, 0.95, 0.85],
      seed: 100 + symbols,
    });
    payload = rx.push(img).payload;
  }
  assert.ok(payload, `not done: ${JSON.stringify(rx.stats())}`);
  assert.ok(bytes.length < 1500, `ack is ${bytes.length} B`);
  const got = await unpack(payload);
  assert.equal(got.verified, true);
  const ack = parseAck(got.bytes);
  assert.ok(ack);
  assert.equal((await verifyAck(ack)).signatureOk, true);
  assert.equal(ack.body.decision, 'reject');
});

// Crop and downscale like the browser's drawImage (area average).
function cropScale(img: RgbaImage, c: ReturnType<typeof cropFor>): RgbaImage {
  const out = new Uint8ClampedArray(c.dw * c.dh * 4);
  const fx = c.sw / c.dw;
  const fy = c.sh / c.dh;
  for (let y = 0; y < c.dh; y++) {
    for (let x = 0; x < c.dw; x++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let yy = Math.floor(c.sy + y * fy); yy < Math.floor(c.sy + (y + 1) * fy); yy++) {
        for (let xx = Math.floor(c.sx + x * fx); xx < Math.floor(c.sx + (x + 1) * fx); xx++) {
          const i = (yy * img.width + xx) * 4;
          sum[0] += img.data[i];
          sum[1] += img.data[i + 1];
          sum[2] += img.data[i + 2];
          n++;
        }
      }
      out.set([sum[0] / n, sum[1] / n, sum[2] / n, 255], (y * c.dw + x) * 4);
    }
  }
  return { width: c.dw, height: c.dh, data: out };
}

test('a SAM 3.1 region lets a 1080p webcam read a far screen the downscaled frame cannot', (t) => {
  // The plant screen across the room: ~3.4 camera px per module at 1080p,
  // ~2.3 after the usual downscale to 1280 px. The detector needs ~4.
  const W = 1920;
  const H = 1080;
  const tx = new Transmitter(new Uint8Array(4000).map((_, i) => (i * 37) & 255), 3, 2);
  let full = 0;
  let roi = 0;
  const trials = 6;
  for (let t = 0; t < trials; t++) {
    const s = tx.next();
    const corners = placeGrid(1300, 420, 250, 3 + t, 0.04);
    const img = simulateCameraRgb(s.modules, s.colors, { width: W, height: H, corners, blur: 1, noise: 5, seed: 40 + t });

    full += readFrame(cropScale(img, cropFor(W, H, 1280, null))).packets.length;

    // SAM answers on the 1280×720 still it was sent; the monitor box is a bit wider than the grid.
    const k = 1280 / W;
    const xs = corners.map((p) => p.x * k);
    const ys = corners.map((p) => p.y * k);
    const match: SamMatch = {
      frame: 0,
      id: 0,
      box: { x1: Math.min(...xs) - 20, y1: Math.min(...ys) - 15, x2: Math.max(...xs) + 20, y2: Math.max(...ys) + 25 },
      width: 1280,
      height: 720,
      confidence: 0.9,
      mask: null,
    };
    const crop = cropFor(W, H, 1280, roiFromMatch(match, W, H));
    assert.equal(crop.dw, crop.sw, 'the region is decoded at native resolution');
    const r = readFrame(cropScale(img, crop));
    roi += r.packets.length;
    if (r.quad) {
      // The quad maps back onto the screen in video coordinates.
      const back = toVideo(r.quad[0], crop);
      assert.ok(Math.hypot(back.x - corners[0].x, back.y - corners[0].y) < 40, JSON.stringify({ back, tl: corners[0] }));
    }
  }
  t.diagnostic(`packets read: whole frame ${full}, SAM region ${roi}, over ${trials} frames`);
  assert.ok(roi >= trials - 1, `with the SAM region: ${roi}/${trials} frames read`);
  assert.ok(full < roi, `whole frame: ${full}/${trials}, region: ${roi}/${trials}`);
});
