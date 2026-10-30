// Smoke-test the Meta model integration from a terminal.
//
//   npm run cli -- status
//   npm run cli -- pack   <document.txt> [out.json]      Muse Spark (MODEL_API_KEY), else Muse Glimmer 30B on NVIDIA NIM (NVIDIA_API_KEY)
//   npm run cli -- verify <bundle.json>  [policy.json]    Muse Glimmer via Ollama (offline)
//
// Config comes from the repo-root .env (see .env.example).

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  OllamaChatModel,
  packWorkOrder,
  packerFromEnv,
  validateBundle,
  verifyBundle,
  type SitePolicy,
  type TraceEvent,
} from '../src/index.ts';

const env = process.env;
const DEFAULT_POLICY = new URL('../fixtures/site-policy.json', import.meta.url);

const packer = () => {
  const model = packerFromEnv(env);
  if (!model) throw new Error('neither MODEL_API_KEY nor NVIDIA_API_KEY is set (copy .env.example to .env)');
  return model;
};
const glimmer = () => new OllamaChatModel({ baseUrl: env.OLLAMA_URL, model: env.GLIMMER_MODEL });

function printTrace(trace: TraceEvent[]): void {
  for (const t of trace) {
    console.log(`  ${t.ok ? 'ok ' : 'ERR'} ${t.model} ${t.op} ${t.ms} ms  in ${t.inputBytes} B  out ${t.outputBytes} B${t.note ? `  (${t.note})` : ''}`);
  }
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'status') {
    console.log(`Meta Model API key: ${env.MODEL_API_KEY ? 'set' : 'missing'}  (${env.SPARK_MODEL ?? 'muse-spark-1.3'})`);
    console.log(`NVIDIA NIM key: ${env.NVIDIA_API_KEY ? 'set' : 'missing'}  (${env.NVIDIA_MODEL ?? 'meta/muse-glimmer-30b'})`);
    const g = glimmer();
    console.log(`Ollama ${g.id}: ${(await g.available()) ? 'ready' : 'not available (ollama serve + ollama pull)'}`);
  } else if (cmd === 'pack' && a) {
    // The sender packs for a known site; default to the demo receiver's policy site.
    const site = env.LUMINA_SITE ?? (JSON.parse(readFileSync(DEFAULT_POLICY, 'utf8')) as SitePolicy).site;
    const res = await packWorkOrder(packer(), { title: basename(a), text: readFileSync(a, 'utf8') }, { site });
    printTrace(res.trace);
    console.log(`${res.sourceBytes} B source -> ${res.bundleBytes} B bundle (lossy semantic summary, ${res.attempts} attempt(s))`);
    if (b) {
      writeFileSync(b, JSON.stringify(res.bundle, null, 2) + '\n');
      // Run record next to the bundle: the web app replays it where no packer is reachable (GitHub Pages).
      const run = { date: new Date().toISOString(), sourceBytes: res.sourceBytes, bundleBytes: res.bundleBytes, attempts: res.attempts, trace: res.trace };
      writeFileSync(b.replace(/\.json$/, '.run.json'), JSON.stringify(run, null, 2) + '\n');
    } else console.log(JSON.stringify(res.bundle, null, 2));
  } else if (cmd === 'verify' && a) {
    const parsed = validateBundle(JSON.parse(readFileSync(a, 'utf8')));
    if (!parsed.ok) throw new Error(`invalid bundle:\n  ${parsed.errors.join('\n  ')}`);
    const policy = JSON.parse(readFileSync(b ?? DEFAULT_POLICY, 'utf8')) as SitePolicy;
    const g = glimmer();
    const v = await verifyBundle(parsed.bundle, policy, (await g.available()) ? g : null);
    printTrace(v.trace);
    console.log(`DECISION: ${v.decision.toUpperCase()}${v.modelOverruled ? '  (model approved, policy overruled)' : ''}`);
    for (const f of v.findings) console.log(`  [${f.severity}] ${f.code} ${f.path}: ${f.message}`);
    for (const r of v.model?.reasons ?? []) console.log(`  model: ${r}`);
    for (const n of v.notes) console.log(`  note: ${n}`);
  } else {
    console.log('usage: cli status | pack <doc> [out.json] | verify <bundle.json> [policy.json]');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
