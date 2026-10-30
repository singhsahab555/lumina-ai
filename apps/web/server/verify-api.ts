// Plant-side verifier helper. Runs inside the Vite dev and preview servers on
// the receiver laptop (never in the static GitHub Pages build) and talks only
// to the plant network's Ollama (OLLAMA_URL, VERIFIER_MODEL in .env). No
// internet: the model, the policy and the checks all stay inside the plant.
//
//   GET  /api/verify   -> { ready, model }
//   POST /api/verify   { bundle } -> NDJSON stream of
//        { type: 'start', model } | { type: 'tick', ms } | { type: 'call', event }
//        | { type: 'done', verdict } | { type: 'error', message }

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { OllamaChatModel, validateBundle, verifyBundle, type SitePolicy } from '@lumina/agents';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const POLICY = new URL('../../../packages/lumina-agents/fixtures/site-policy.json', import.meta.url);

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function handler(env: Record<string, string>) {
  const policy = JSON.parse(readFileSync(POLICY, 'utf8')) as SitePolicy;
  const model = new OllamaChatModel({ baseUrl: env.OLLAMA_URL || undefined, model: env.VERIFIER_MODEL || undefined });

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/api/verify') return next();
    const ready = await model.available();

    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ready, model: model.id }));
      return;
    }
    if (req.method !== 'POST' || !ready) {
      res.statusCode = ready ? 405 : 503;
      res.end();
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (msg: unknown) => res.write(JSON.stringify(msg) + '\n');
    const parsed = validateBundle((JSON.parse(await readBody(req)) as { bundle: unknown }).bundle);
    if (!parsed.ok) {
      send({ type: 'error', message: `invalid bundle: ${parsed.errors.slice(0, 3).join('; ')}` });
      res.end();
      return;
    }
    const started = Date.now();
    const ticker = setInterval(() => send({ type: 'tick', ms: Date.now() - started }), 5000);
    send({ type: 'start', model: model.id });
    try {
      const verdict = await verifyBundle(parsed.bundle, policy, model, { onTrace: (event) => send({ type: 'call', event }) });
      send({ type: 'done', verdict });
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearInterval(ticker);
      res.end();
    }
  };
}

export function verifyApi(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: 'lumina-verify-api',
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
