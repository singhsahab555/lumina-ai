// SAM 3.1 helper for the connected side's return-channel camera. Like
// pack-api.ts it runs in the Vite dev/preview server only, so MODEL_API_KEY
// stays in the repo-root .env. SAM 3.1 is served only by the Meta Model API;
// without that key the endpoint reports not-ready and the receiver falls back
// to finding the grid over the whole frame.
//
//   GET  /api/sam   -> { ready, model }
//   POST /api/sam   { image: dataUrl, prompt? } -> ScreenFind

import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { samFindScreen, samFromEnv } from '@lumina/agents';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
// A 1280 px JPEG still is ~150 KB as a data URL.
const MAX_BODY = 4 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('image too large');
  }
  return body;
}

function handler(env: Record<string, string>) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/api/sam') return next();
    const cfg = samFromEnv(env);
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET') {
      res.end(JSON.stringify({ ready: cfg !== null, model: cfg?.model ?? null }));
      return;
    }
    if (req.method !== 'POST' || !cfg) {
      res.statusCode = cfg ? 405 : 503;
      res.end();
      return;
    }
    try {
      const { image, prompt } = JSON.parse(await readBody(req)) as { image: string; prompt?: string };
      if (!image?.startsWith('data:image/')) throw new Error('image must be a data:image/ URL');
      res.end(JSON.stringify(await samFindScreen(cfg, image, prompt)));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };
}

export function samApi(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: 'lumina-sam-api',
    configResolved(config) {
      env = loadEnv(config.mode, REPO_ROOT, '');
    },
    configureServer(server) {
      server.middlewares.use(handler(env));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler(env));
    },
  };
}
