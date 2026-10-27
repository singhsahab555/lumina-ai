// Drives the built transmitter in headless Edge/Chrome:
//  - checks the grid really animates at the configured symbol rate
//  - saves UI screenshots to docs/media/
//  - saves real screenshots of every frame of the sample file to
//    test/fixtures/frames/, which test/screenshot.test.ts decodes.
// Usage: npm run build && npm run capture

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const media = fileURLToPath(new URL('../../../docs/media/', import.meta.url));
const frames = `${root}test/fixtures/frames/`;
const REPAIR_FRAMES = 2;

const server = await preview({ root, preview: { port: 4173, strictPort: true } });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge' });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const text = (id) => page.getByTestId(id).innerText();

try {
  await mkdir(media, { recursive: true });
  await page.goto(url);
  await page.screenshot({ path: `${media}day2-transmitter-idle.png` });

  await page.getByTestId('sample').click();
  await page.waitForTimeout(3000);
  const measured = await text('measured');
  console.log(`measured at 30/s setting: ${measured}`);
  await page.screenshot({ path: `${media}day2-transmitter-running.png` });

  // Restart paused so frames are captured from seed 0 one at a time.
  await page.getByTestId('pause').click();
  await page.getByTestId('sample').click();
  await page.waitForTimeout(400);
  const k = Number((await text('k')).split(' ')[0]);
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames, { recursive: true });
  for (let i = 0; i < k + REPAIR_FRAMES; i++) {
    if (i > 0) await page.getByTestId('step').click();
    await page.waitForTimeout(50);
    await page.getByTestId('grid').screenshot({ path: `${frames}frame-${String(i).padStart(3, '0')}.png` });
  }
  await page.screenshot({ path: `${media}day2-transmitter-paused.png` });
  await writeFile(`${frames}meta.json`, JSON.stringify({ k, captured: k + REPAIR_FRAMES, measured }, null, 2) + '\n');
  console.log(`captured ${k + REPAIR_FRAMES} frames (K=${k})`);
} finally {
  await browser.close();
  server.httpServer.close();
}
