// Local red-team helper for the connected sender, next to /api/pack: Muse
// Glimmer 30B on NVIDIA NIM attacks a packed bundle against its source
// document before it is beamed. Dev/preview servers only; the key stays in .env.
//
//   GET  /api/redteam  -> { ready, model }
//   POST /api/redteam  { bundle, title, text } -> NDJSON stream of
//        { type: 'start', model } | { type: 'tick', ms } | { type: 'call', event }
//        | { type: 'done', report } | { type: 'error', message }

import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { redTeamBundle, redTeamFromEnv, validateBundle } from '@lumina/agents';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function handler(env: Record<string, string>) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/api/redteam') return next();
    const model = redTeamFromEnv(env);

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

    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (msg: unknown) => res.write(JSON.stringify(msg) + '\n');
    const { bundle, title, text } = JSON.parse(await readBody(req)) as { bundle: unknown; title: string; text: string };
    const parsed = validateBundle(bundle);
    if (!parsed.ok) {
      send({ type: 'error', message: `invalid bundle: ${parsed.errors.slice(0, 3).join('; ')}` });
      res.end();
      return;
    }
    const started = Date.now();
    const ticker = setInterval(() => send({ type: 'tick', ms: Date.now() - started }), 5000);
    send({ type: 'start', model: model.id });
    try {
      const report = await redTeamBundle(parsed.bundle, { title, text }, model, { onTrace: (event) => send({ type: 'call', event }) });
      send({ type: 'done', report });
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearInterval(ticker);
      res.end();
    }
  };
}

export function redTeamApi(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: 'lumina-redteam-api',
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
