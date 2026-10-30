// Local packer helper for the connected sender. Runs inside the Vite dev and
// preview servers only (never in the static GitHub Pages build), so the model
// key stays in the repo-root .env on this laptop and the browser only talks to
// its own origin. A browser cannot call NVIDIA NIM directly: no CORS, and the
// key would be readable by anyone who opens the page.
//
//   GET  /api/pack   -> { ready, model }
//   POST /api/pack   { title, text } -> NDJSON stream of
//        { type: 'start', model } | { type: 'tick', ms } | { type: 'attempt', event }
//        | { type: 'done', result } | { type: 'error', message, trace }

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { PackError, packWorkOrder, packerFromEnv, type SitePolicy } from '@lumina/agents';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DEFAULT_POLICY = new URL('../../../packages/lumina-agents/fixtures/site-policy.json', import.meta.url);

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function handler(env: Record<string, string>) {
  const site = env.LUMINA_SITE || (JSON.parse(readFileSync(DEFAULT_POLICY, 'utf8')) as SitePolicy).site;

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/api/pack') return next();
    const model = packerFromEnv(env);

    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ready: model !== null, model: model?.id ?? null }));
      return;
    }
    if (req.method !== 'POST' || !model) {
      res.statusCode = model ? 405 : 503;
      res.end();
      return;
    }

    const { title, text } = JSON.parse(await readBody(req)) as { title: string; text: string };
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (msg: unknown) => res.write(JSON.stringify(msg) + '\n');
    const started = Date.now();
    // A model call takes minutes; ticks keep proxies and the browser from idling out.
    const ticker = setInterval(() => send({ type: 'tick', ms: Date.now() - started }), 5000);
    send({ type: 'start', model: model.id });
    try {
      const result = await packWorkOrder(model, { title, text }, { site, onTrace: (event) => send({ type: 'attempt', event }) });
      send({ type: 'done', result });
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e), trace: e instanceof PackError ? e.trace : [] });
    } finally {
      clearInterval(ticker);
      res.end();
    }
  };
}

export function packApi(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: 'lumina-pack-api',
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
