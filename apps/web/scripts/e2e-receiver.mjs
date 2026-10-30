// Browser end-to-end for the receiver, with no physical camera, run once per
// colour mode under identical conditions so throughput is comparable:
//  1. encode a file exactly like the transmitter (envelope → deflate → LT →
//     grid), render each symbol as a tilted, blurred, noisy colour "phone
//     camera" frame (crosstalk + warm cast), and write a 4:2:0 Y4M video;
//  2. launch Edge/Chrome with that video as a fake webcam, open #rx, press
//     Start, and wait for the SHA-256 verified badge;
//  3. download the file and compare it byte for byte with the original.
// Like a real 60 fps camera watching a 30 sym/s screen, each symbol appears
// twice and every 5th frame is torn between two symbols.
// Usage: npm run build && npm run e2e

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { sealEnvelope, mulberry32 } from '@lumina/protocol';
import { placeGrid, simulateCameraRgb } from '@lumina/protocol/synth';
import { Transmitter } from '../src/lib/transmitter.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const media = fileURLToPath(new URL('../../../docs/media/', import.meta.url));
const W = 960;
const H = 540;
const MODES = [2, 8, 'auto'];

// 30 KB of incompressible "raw vibration capture", so K is large enough to
// measure throughput rather than start-up latency.
const NAME = 'p07b-vibration-raw.bin';
const rng = mulberry32(0x707b);
const original = Buffer.from(Uint8Array.from({ length: 30_000 }, () => (rng() * 256) | 0));
const payload = deflateRawSync(sealEnvelope(NAME, original));

function writeVideo(mode) {
  const tx = new Transmitter(payload, 0x1ee7, mode);
  const perSymbol = mode === 2 ? 1 : mode === 8 ? 3 : 2.5;
  // Long enough never to loop: a real transmitter never repeats a droplet.
  const count = Math.ceil((tx.k / perSymbol) * 3) + 2;
  const shots = [];
  for (let i = 0; i < count; i++) {
    const s = tx.next();
    shots.push(
      simulateCameraRgb(s.modules, s.colors, {
        width: W,
        height: H,
        corners: placeGrid(480 + Math.sin(i / 7) * 20, 270 + Math.cos(i / 9) * 12, 470, 4 + Math.sin(i / 5) * 3, 0.07),
        blur: 1,
        noise: 7,
        gradient: 0.25,
        crosstalk: 0.08,
        tint: [1, 0.95, 0.85],
        seed: i + 1,
      }).data,
    );
  }
  const video = join(tmpdir(), `lumina-e2e-camera-${mode}.y4m`);
  const fd = openSync(video, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
  const y = new Uint8Array(W * H);
  const cb = new Uint8Array((W / 2) * (H / 2));
  const cr = new Uint8Array((W / 2) * (H / 2));
  let frames = 0;
  for (let s = 0; s < count; s++) {
    for (let rep = 0; rep < 2; rep++) {
      const torn = frames % 5 === 4 && s + 1 < count;
      const top = shots[s];
      const bottom = torn ? shots[s + 1] : top;
      cb.fill(0);
      cr.fill(0);
      for (let py = 0; py < H; py++) {
        const src = py < H / 2 ? top : bottom;
        for (let px = 0; px < W; px++) {
          const p = (py * W + px) * 4;
          const r = src[p];
          const g = src[p + 1];
          const b = src[p + 2];
          y[py * W + px] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          const c = (py >> 1) * (W / 2) + (px >> 1);
          cb[c] += (128 - 0.168736 * r - 0.331264 * g + 0.5 * b) / 4;
          cr[c] += (128 + 0.5 * r - 0.418688 * g - 0.081312 * b) / 4;
        }
      }
      writeSync(fd, 'FRAME\n');
      writeSync(fd, y);
      writeSync(fd, cb);
      writeSync(fd, cr);
      frames++;
    }
  }
  closeSync(fd);
  console.log(`[${mode}] fake camera: ${frames} frames, ${count} symbols, K=${tx.k}`);
  return video;
}

async function run(mode, video, server) {
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL ?? 'msedge',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    await context.grantPermissions(['camera']);
    const page = await context.newPage();
    await page.goto(`${server.resolvedUrls.local[0]}#rx`);
    await page.getByTestId('rx-start').click();
    await page.getByTestId('rx-valid').waitFor({ timeout: 15000 });
    if (mode === 8) await page.screenshot({ path: `${media}day4-receiver-scanning.png` });
    await page.getByTestId('rx-verified').waitFor({ timeout: 90000 });
    const elapsed = parseFloat(await page.getByTestId('rx-elapsed').innerText());
    const dpf = await page.getByTestId('rx-dpf').innerText();
    const colors = await page.getByTestId('rx-colors').innerText();
    const counters = await Promise.all(['rx-frames', 'rx-located', 'rx-valid', 'rx-unique', 'rx-decode'].map((id) => page.getByTestId(id).innerText()));
    console.log(`[${mode}] frames read / located / valid / unique droplets / decode: ${counters.join(' / ')}`);
    if (mode === 8) await page.screenshot({ path: `${media}day4-receiver-done.png` });

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('rx-download').click()]);
    const got = readFileSync(await download.path());
    const same = Buffer.compare(got, original) === 0 && download.suggestedFilename() === NAME;
    const kbps = original.length / 1024 / elapsed;
    console.log(`[${mode}] verified byte-exact ${same} in ${elapsed.toFixed(1)} s over light → ${kbps.toFixed(1)} KB/s (droplets/frame ${dpf}, colors seen ${colors})`);

    // Return channel: the receiver signs an ack and beams it on its own screen.
    await page.getByTestId('ack-beam').click();
    await page.getByTestId('ack-beaming').waitFor({ timeout: 10000 });
    console.log(`[${mode}] ack beaming, plant key ${await page.getByTestId('ack-key').innerText()}`);
    if (mode === 8) await page.screenshot({ path: `${media}day7-ack-beaming.png` });
    return { same, kbps };
  } finally {
    await browser.close();
  }
}

await mkdir(media, { recursive: true });
const videos = MODES.map(writeVideo);
const server = await preview({ root, preview: { port: 4174, strictPort: true } });
try {
  const results = [];
  for (let i = 0; i < MODES.length; i++) results.push(await run(MODES[i], videos[i], server));
  const [two, eight] = results;
  console.log(`8-color / 2-color throughput: ${(eight.kbps / two.kbps).toFixed(2)}×`);
  if (results.some((r) => !r.same)) process.exitCode = 1;
} finally {
  server.httpServer.close();
}
