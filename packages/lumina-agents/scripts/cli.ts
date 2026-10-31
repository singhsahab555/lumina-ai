// Smoke-test the Meta model integration from a terminal.
//
//   npm run cli -- status
//   npm run cli -- pack   <document.txt> [out.json]      Muse Spark (MODEL_API_KEY, else BASETEN_API_KEY), else Muse Glimmer 30B on NVIDIA NIM
//   npm run cli -- verify <bundle.json>  [policy.json] [--record run.json]
//                                                        plant verifier via Ollama (OLLAMA_URL, VERIFIER_MODEL); --record saves the run for replay
//   npm run cli -- redteam <bundle.json> <source.txt> [--record run.json]
//                                                        Muse Glimmer 30B on NVIDIA NIM attacks the bundle before it is beamed
//
// Config comes from the repo-root .env (see .env.example).

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  BASETEN_SPARK_MODEL,
  OllamaChatModel,
  packWorkOrder,
  packerFromEnv,
  redTeamBundle,
  redTeamFromEnv,
  sha256Hex,
  validateBundle,
  verifyBundle,
  type SitePolicy,
  type TraceEvent,
} from '../src/index.ts';

const env = process.env;
const DEFAULT_POLICY = new URL('../fixtures/site-policy.json', import.meta.url);

const packer = () => {
  const model = packerFromEnv(env);
  if (!model) throw new Error('none of MODEL_API_KEY, BASETEN_API_KEY, NVIDIA_API_KEY is set (copy .env.example to .env)');
  return model;
};
const verifier = () => new OllamaChatModel({ baseUrl: env.OLLAMA_URL, model: env.VERIFIER_MODEL });

function printTrace(trace: TraceEvent[]): void {
  for (const t of trace) {
    console.log(`  ${t.ok ? 'ok ' : 'ERR'} ${t.model} ${t.op} ${t.ms} ms  in ${t.inputBytes} B  out ${t.outputBytes} B${t.note ? `  (${t.note})` : ''}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--record');
  const record = flag >= 0 ? args.splice(flag, 2)[1] : undefined;
  const [cmd, a, b] = args;
  if (cmd === 'status') {
    console.log(`Meta Model API key: ${env.MODEL_API_KEY ? 'set' : 'missing'}  (${env.SPARK_MODEL ?? 'muse-spark-1.3'})`);
    console.log(`Baseten key: ${env.BASETEN_API_KEY ? 'set' : 'missing'}  (${env.BASETEN_MODEL ?? BASETEN_SPARK_MODEL})`);
    console.log(`NVIDIA NIM key: ${env.NVIDIA_API_KEY ? 'set' : 'missing'}  (${env.NVIDIA_MODEL ?? 'meta/muse-glimmer-30b'})`);
    const g = verifier();
    console.log(`Packer in use: ${packerFromEnv(env)?.id ?? 'none'}`);
    console.log(`Red-team in use: ${redTeamFromEnv(env)?.id ?? 'none (grounding checks only)'}`);
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
    const g = verifier();
    const v = await verifyBundle(parsed.bundle, policy, (await g.available()) ? g : null);
    if (record) {
      // The web receiver replays this where no plant helper is reachable, but only for this exact bundle.
      const bundleSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify(parsed.bundle)));
      writeFileSync(record, JSON.stringify({ date: new Date().toISOString(), bundleSha256, verdict: v }, null, 2) + '\n');
    }
    printTrace(v.trace);
    console.log(`DECISION: ${v.decision.toUpperCase()}${v.modelOverruled ? '  (model approved, policy overruled)' : ''}`);
    for (const f of v.findings) console.log(`  [${f.severity}] ${f.code} ${f.path}: ${f.message}`);
    for (const r of v.model?.reasons ?? []) console.log(`  model: ${r}`);
    for (const n of v.notes) console.log(`  note: ${n}`);
  } else if (cmd === 'redteam' && a && b) {
    const parsed = validateBundle(JSON.parse(readFileSync(a, 'utf8')));
    if (!parsed.ok) throw new Error(`invalid bundle:\n  ${parsed.errors.join('\n  ')}`);
    const r = await redTeamBundle(parsed.bundle, { title: basename(b), text: readFileSync(b, 'utf8') }, redTeamFromEnv(env));
    if (record) {
      // Replayed by the web packer panel, only for this exact bundle.
      const bundleSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify(parsed.bundle)));
      writeFileSync(record, JSON.stringify({ date: new Date().toISOString(), bundleSha256, report: r }, null, 2) + '\n');
    }
    printTrace(r.trace);
    console.log(`RED-TEAM: ${r.verdict.toUpperCase()}`);
    for (const c of r.grounding) console.log(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.code} ${c.path}: ${c.message}`);
    for (const i of r.issues) console.log(`  model: step ${i.step ?? '-'} ${i.kind}: ${i.detail}`);
    for (const n of r.notes) console.log(`  note: ${n}`);
  } else {
    console.log('usage: cli status | pack <doc> [out.json] | verify <bundle.json> [policy.json] [--record run.json] | redteam <bundle.json> <source.txt> [--record run.json]');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
