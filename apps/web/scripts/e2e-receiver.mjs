// Browser end-to-end for the receiver, with no physical camera:
//  1. encode the 45-day sample log exactly like the transmitter (envelope →
//     deflate → LT → grid), render each symbol as a tilted, blurred, noisy
//     "phone camera" frame, and write them as a Y4M video;
//  2. launch Edge/Chrome with that video as a fake webcam, open #rx, press
//     Start, and wait for the SHA-256 verified badge;
//  3. download the file and compare it byte for byte with the original.
// Like a real 60 fps camera watching a 30 sym/s screen, each symbol appears
// twice and every 5th frame is torn between two symbols.
// Usage: npm run build && npm run e2e

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { LTEncoder, MAX_BLOCK_SIZE, encodePacket, packetToModules, sealEnvelope } from '@lumina/protocol';
import { placeGrid, simulateCamera } from '@lumina/protocol/synth';

const root = fileURLToPath(new URL('..', import.meta.url));
const media = fileURLToPath(new URL('../../../docs/media/', import.meta.url));
const NAME = 'ps07-shift-log-45d.txt';
const W = 960;
const H = 540;

const original = readFileSync(`${root}public/samples/${NAME}`);
const enc = new LTEncoder(deflateRawSync(sealEnvelope(NAME, original)), MAX_BLOCK_SIZE, 0x1ee7);
const symbols = Math.ceil(enc.k * 1.5);

const render = (seed, i) =>
  simulateCamera(packetToModules(encodePacket(enc.config, enc.droplet(seed))), {
    width: W,
    height: H,
    corners: placeGrid(480 + Math.sin(i / 7) * 20, 270 + Math.cos(i / 9) * 12, 470, 4 + Math.sin(i / 5) * 3, 0.07),
    blur: 1,
    noise: 7,
    gradient: 0.25,
    seed: i + 1,
  });

const video = join(tmpdir(), 'lumina-e2e-camera.y4m');
const fd = openSync(video, 'w');
writeSync(fd, `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
const chroma = new Uint8Array((W / 2) * (H / 2)).fill(128);
let frames = 0;
for (let s = 0; s < symbols; s++) {
  for (let rep = 0; rep < 2; rep++) {
    let y = render(s, frames).data;
    if (frames % 5 === 4 && s + 1 < symbols) {
      y = Uint8Array.from(y);
      y.set(render(s + 1, frames).data.subarray(W * (H / 2)), W * (H / 2));
    }
    writeSync(fd, 'FRAME\n');
    writeSync(fd, y);
    writeSync(fd, chroma);
    writeSync(fd, chroma);
    frames++;
  }
}
closeSync(fd);
console.log(`fake camera: ${frames} frames (${symbols} symbols, K=${enc.k}, ${original.length} B file) -> ${video}`);

const server = await preview({ root, preview: { port: 4174, strictPort: true } });
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  await context.grantPermissions(['camera']);
  const page = await context.newPage();
  await mkdir(media, { recursive: true });
  const t0 = Date.now();
  await page.goto(`${server.resolvedUrls.local[0]}#rx`);
  await page.getByTestId('rx-start').click();
  await page.getByTestId('rx-valid').waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${media}day3-receiver-scanning.png` });
  await page.getByTestId('rx-verified').waitFor({ timeout: 90000 });
  console.log(`verified after ${((Date.now() - t0) / 1000).toFixed(1)} s, rx sha ${await page.getByTestId('rx-sha').innerText()}`);
  await page.screenshot({ path: `${media}day3-receiver-done.png` });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('rx-download').click()]);
  const got = readFileSync(await download.path());
  const same = Buffer.compare(got, original) === 0;
  console.log(`download ${download.suggestedFilename()}: ${got.length} B, byte-exact ${same}, sha ${createHash('sha256').update(got).digest('hex')}`);
  if (!same || download.suggestedFilename() !== NAME) process.exitCode = 1;
} finally {
  await browser.close();
  server.httpServer.close();
}
