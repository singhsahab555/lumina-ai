// Drives the built transmitter in headless Edge/Chrome:
//  - checks the grid really animates at the configured symbol rate
//  - saves UI screenshots to docs/media/
//  - saves real screenshots of every symbol of the sample file, 2-color to
//    test/fixtures/frames/ and 8-color to test/fixtures/frames8/, which
//    test/screenshot.test.ts decodes.
// Usage: npm run build && npm run capture

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const media = fileURLToPath(new URL('../../../docs/media/', import.meta.url));
const fixtures = `${root}test/fixtures/`;
const REPAIR_FRAMES = 2;

const server = await preview({ root, preview: { port: 4173, strictPort: true } });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge' });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const text = (id) => page.getByTestId(id).innerText();

try {
  await mkdir(media, { recursive: true });
  await page.goto(url);
  await page.getByTestId('sample').click();
  await page.waitForTimeout(3000);
  const measured = await text('measured');
  console.log(`measured at 30/s setting (Auto colors): ${measured}`);
  await page.getByTestId('mode-8').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${media}day4-transmitter-8color.png` });

  // Restart paused so symbols are captured from seed 0 one at a time.
  await page.getByTestId('pause').click();
  for (const [colors, dir] of [
    [2, 'frames'],
    [8, 'frames8'],
  ]) {
    await page.getByTestId(`mode-${colors}`).click();
    await page.getByTestId('sample').click();
    await page.waitForTimeout(400);
    const k = Number((await text('k')).split(' ')[0]);
    const count = Math.ceil(k / (colors === 8 ? 3 : 1)) + REPAIR_FRAMES;
    const out = `${fixtures}${dir}/`;
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    for (let i = 0; i < count; i++) {
      if (i > 0) await page.getByTestId('step').click();
      await page.waitForTimeout(50);
      await page.getByTestId('grid').screenshot({ path: `${out}frame-${String(i).padStart(3, '0')}.png` });
    }
    await writeFile(`${out}meta.json`, JSON.stringify({ colors, k, captured: count, measured }, null, 2) + '\n');
    console.log(`captured ${count} ${colors}-color symbols (K=${k})`);
  }
} finally {
  await browser.close();
  server.httpServer.close();
}
