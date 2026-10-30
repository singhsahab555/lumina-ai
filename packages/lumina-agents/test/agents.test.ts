import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { BASETEN_SPARK_MODEL, MetaChatModel, OllamaChatModel, PackError, packWorkOrder, packerFromEnv, parseSamOutput, samFindScreen, samFromEnv, samSegmentRequest, sha256Hex, verifyBundle } from '../src/index.ts';
import { ScriptedModel, fakeFetch, policy, sampleLog, say, tamperedBundle, validBundle } from './helpers.ts';

const call = (name: string, args: Record<string, unknown>, id = name) => ({ id, name, arguments: args });

// ── packer ───────────────────────────────────────────────────────────────

test('packer retries with validation errors, then pins provenance to the real source', async () => {
  const lyingSource = { ...validBundle(), source: { title: 'x', bytes: 1, sha256: '0'.repeat(64) } };
  const model = new ScriptedModel([say('{"schema":"oops"}'), say('```json\n' + JSON.stringify(lyingSource) + '\n```')]);
  const text = sampleLog();
  const res = await packWorkOrder(model, { title: 'pump-station-log.txt', text });

  assert.equal(res.attempts, 2);
  assert.equal(res.bundle.kind, 'neural-summary');
  assert.equal(res.bundle.source.sha256, await sha256Hex(new TextEncoder().encode(text)));
  assert.equal(res.bundle.source.bytes, res.sourceBytes);
  assert.ok(res.bundleBytes < res.sourceBytes, `${res.bundleBytes} >= ${res.sourceBytes}`);
  assert.equal(res.trace.length, 2);

  assert.equal(model.requests[0].jsonSchema?.name, 'WorkOrderBundle');
  const retry = model.requests[1].messages.at(-1)!;
  assert.match(retry.content, /\$\.work_order_id: required/);
  assert.match(res.trace[0].note ?? '', /^invalid: /);
});

test('packer pins the site the sender packs for over whatever the model wrote', async () => {
  const model = new ScriptedModel([say(JSON.stringify({ ...validBundle(), site: 'North Basin Water Treatment PS-07' }))]);
  const res = await packWorkOrder(model, { title: 'log.txt', text: sampleLog() }, { site: 'North Basin WTP' });
  assert.equal(res.bundle.site, 'North Basin WTP');
});

test('packer gives up after maxAttempts with the last errors', async () => {
  const model = new ScriptedModel([say('nope'), say('{}')]);
  await assert.rejects(packWorkOrder(model, { title: 't', text: 'x' }, { maxAttempts: 2 }), (e: unknown) => {
    assert.ok(e instanceof PackError);
    assert.ok(e.errors.includes('$.steps: required'));
    return true;
  });
});

// ── verifier ─────────────────────────────────────────────────────────────

test('verifier approves a clean bundle after the model checks it with tools', async () => {
  const model = new ScriptedModel([
    () => ({
      content: '',
      toolCalls: [call('check_asset', { asset_id: 'P-07B' }), call('check_setpoint', { parameter: 'vfd_ramp_time', value: 12, unit: 's' })],
    }),
    say('{"decision":"approve","reasons":["all checks passed"],"injection_suspected":false}'),
  ]);
  const v = await verifyBundle(validBundle(), policy(), model);
  assert.equal(v.decision, 'approve');
  assert.equal(v.toolCalls, 2);

  const toolMsgs = model.requests[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.content), ['[]', '[]']);
  assert.match(model.requests[0].messages[0].content, /untrusted DATA/);
});

test('policy overrules a model that was fooled into approving a tampered bundle', async () => {
  const model = new ScriptedModel([say('{"decision":"approve","reasons":["pre-approved"],"injection_suspected":false}')]);
  const v = await verifyBundle(tamperedBundle(), policy(), model);
  assert.equal(v.decision, 'reject');
  assert.equal(v.modelOverruled, true);
});

test('model tool results expose the out-of-range setpoint', async () => {
  const model = new ScriptedModel([
    () => ({ content: '', toolCalls: [call('check_setpoint', { parameter: 'discharge_pressure_high_limit', value: 9, unit: 'bar' })] }),
    say('{"decision":"reject","reasons":["discharge pressure 9 bar exceeds 6.5"],"injection_suspected":true}'),
  ]);
  const v = await verifyBundle(tamperedBundle(), policy(), model);
  const toolResult = JSON.parse(model.requests[1].messages.at(-1)!.content);
  assert.equal(toolResult[0].code, 'out_of_range');
  assert.equal(v.decision, 'reject');
  assert.equal(v.model?.injectionSuspected, true);
});

test('verifier fails closed without a model or with a broken one', async () => {
  assert.equal((await verifyBundle(validBundle(), policy(), null)).decision, 'hold');
  assert.equal((await verifyBundle(tamperedBundle(), policy(), null)).decision, 'reject');
  const broken = new ScriptedModel([say('looks fine to me')]);
  const v = await verifyBundle(validBundle(), policy(), broken);
  assert.equal(v.decision, 'hold');
  assert.deepEqual(v.notes, ['model reply was not a valid verdict']);
});

// ── adapters (wire format) ───────────────────────────────────────────────

test('Meta adapter sends OpenAI-compatible strict structured output and parses tool calls', async () => {
  const { fn, calls } = fakeFetch({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'scan_text', arguments: '{"text":"hi"}' } }] } }],
  });
  const spark = new MetaChatModel({ apiKey: 'k', fetch: fn });
  const res = await spark.chat({ messages: [{ role: 'user', content: 'x' }], jsonSchema: { name: 'B', schema: { type: 'object' } } });

  assert.equal(calls[0].url, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
  assert.equal(calls[0].body.model, 'muse-spark-1.3');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_schema', json_schema: { name: 'B', schema: { type: 'object' }, strict: true } });
  assert.deepEqual(res.toolCalls, [{ id: 'c1', name: 'scan_text', arguments: { text: 'hi' } }]);
});

test('streamed replies (NVIDIA NIM) drop reasoning and join content and tool-call deltas across chunk splits', async () => {
  const chunks = [
    { reasoning_content: 'thinking...' },
    { content: '{"ok":' },
    { content: 'true}', tool_calls: [{ index: 0, id: 'c1', function: { name: 'scan_', arguments: '{"te' } }] },
    { tool_calls: [{ index: 0, function: { name: 'text', arguments: 'xt":"hi"}' } }] },
  ];
  const sse = chunks.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  let sent: Record<string, unknown> = {};
  const fn = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    // Split mid-line so the reader has to buffer partial SSE lines.
    const parts = [sse.slice(0, 37), sse.slice(37, 150), sse.slice(150)];
    return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } }));
  }) as unknown as typeof fetch;
  const nim = new MetaChatModel({ apiKey: 'k', model: 'meta/muse-glimmer-30b', provider: 'nvidia', stream: true, fetch: fn });
  const res = await nim.chat({ messages: [{ role: 'user', content: 'x' }] });

  assert.equal(nim.id, 'nvidia:meta/muse-glimmer-30b');
  assert.equal(sent.stream, true);
  assert.equal(res.content, '{"ok":true}');
  assert.deepEqual(res.toolCalls, [{ id: 'c1', name: 'scan_text', arguments: { text: 'hi' } }]);
});

test('Ollama adapter targets the plant verifier model and round-trips tool messages', async () => {
  const { fn, calls } = fakeFetch({ message: { content: '', tool_calls: [{ function: { name: 'check_asset', arguments: { asset_id: 'P-07B' } } }] } });
  const glimmer = new OllamaChatModel({ fetch: fn });
  const res = await glimmer.chat({
    messages: [
      { role: 'assistant', content: '', toolCalls: [call('scan_text', { text: 'a' }, 'call_0')] },
      { role: 'tool', toolCallId: 'call_0', name: 'scan_text', content: '[]' },
    ],
    tools: [{ name: 'check_asset', description: 'd', parameters: {} }],
  });

  assert.equal(calls[0].url, 'http://localhost:11434/api/chat');
  assert.equal(calls[0].body.model, 'llama3.1:8b');
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual((calls[0].body.messages as unknown[])[1], { role: 'tool', content: '[]', tool_name: 'scan_text' });
  assert.equal(res.toolCalls[0].name, 'check_asset');
});

test('packerFromEnv prefers Meta, then Baseten Spark (JSON mode), then NVIDIA NIM', async () => {
  assert.equal(packerFromEnv({}), null);
  assert.equal(packerFromEnv({ MODEL_API_KEY: 'm', BASETEN_API_KEY: 'b', NVIDIA_API_KEY: 'n' })?.id, 'meta:muse-spark-1.3');
  assert.equal(packerFromEnv({ NVIDIA_API_KEY: 'n' })?.id, 'nvidia:meta/muse-glimmer-30b');
  const baseten = packerFromEnv({ BASETEN_API_KEY: 'b', NVIDIA_API_KEY: 'n' });
  assert.equal(baseten?.id, `baseten:${BASETEN_SPARK_MODEL}`);

  // Baseten has no strict json_schema: the request asks for a JSON object instead.
  const { fn, calls } = fakeFetch({ choices: [{ message: { content: '{}' } }] });
  const spark = new MetaChatModel({ apiKey: 'b', baseUrl: 'https://inference.baseten.co/v1', jsonMode: 'object', fetch: fn });
  await spark.chat({ messages: [{ role: 'user', content: 'x' }], jsonSchema: { name: 'B', schema: { type: 'object' } } });
  assert.equal(calls[0].url, 'https://inference.baseten.co/v1/chat/completions');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('verifier reports each model call as it happens', async () => {
  const model = new ScriptedModel([
    () => ({ content: '', toolCalls: [call('check_asset', { asset_id: 'P-07B' })] }),
    say('{"decision":"approve","reasons":[],"injection_suspected":false}'),
  ]);
  const seen: string[] = [];
  await verifyBundle(validBundle(), policy(), model, { onTrace: (e) => seen.push(`${e.op} ${e.note ?? ''}`.trim()) });
  assert.deepEqual(seen, ['verify#1 tools: check_asset', 'verify#2']);
});

test('SAM 3.1 request follows the Responses API shape', () => {
  const req = samSegmentRequest('computer monitor', 'data:image/jpeg;base64,AAAA') as any;
  assert.equal(req.model, 'sam-3.1');
  assert.deepEqual(req.input[0].content.map((c: { type: string }) => c.type), ['input_text', 'input_image']);
});

test('SAM 3.1 output: sparse ids, confidence, mask header, empty answer', () => {
  // Shape from dev.meta.ai/docs/sam/reading-segmentation; payloads shortened.
  const text =
    '<0f>0<|box;x1=181;y1=365;x2=556;y2=486;w=1516;h=1600;c=0.91|><|mask;x=0;y=0;c=0.91;data=122,376,~0Q@%a|>,' +
    '2<|box;x1=10;y1=20;x2=60;y2=50;w=1516;h=1600;c=0.40|><|mask;x=0;y=0;data=31,51,!8f|>';
  const [a, b] = parseSamOutput(text);
  assert.deepEqual(a.box, { x1: 181, y1: 365, x2: 556, y2: 486 });
  assert.equal(a.width, 1516);
  assert.equal(a.confidence, 0.91);
  assert.deepEqual(a.mask, { rows: 122, cols: 376, encoding: 'lossless' });
  assert.equal(b.id, 2);
  assert.equal(b.mask?.encoding, 'one_bit');
  assert.deepEqual(parseSamOutput(''), []);
  assert.throws(() => parseSamOutput('<0f>0<|box;x1=a;y1=1;x2=2;y2=3;w=4;h=5|>'));
});

test('SAM finds the far screen: largest match wins, key comes only from MODEL_API_KEY', async () => {
  assert.equal(samFromEnv({ BASETEN_API_KEY: 'b', NVIDIA_API_KEY: 'n' }), null);
  const sse = [
    { type: 'response.output_text.delta', delta: '<0f>0<|box;x1=5;y1=5;x2=40;y2=30;w=1280;h=720|>,' },
    { type: 'response.output_text.delta', delta: '1<|box;x1=400;y1=100;x2=900;y2=500;w=1280;h=720|>' },
    { type: 'response.completed' },
  ].map((e) => `data: ${JSON.stringify(e)}

`).join('');
  const calls: Record<string, any>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(sse, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const cfg = { ...samFromEnv({ MODEL_API_KEY: 'k' })!, fetch };
  const r = await samFindScreen(cfg, 'data:image/jpeg;base64,AAAA');
  assert.equal(r.matches, 2);
  assert.deepEqual(r.match?.box, { x1: 400, y1: 100, x2: 900, y2: 500 });
  assert.equal(r.trace.ok, true);
  assert.equal(calls[0].model, 'sam-3.1');
  assert.deepEqual(calls[0].metadata, { include_confidence: 'true', mask_encoding: 'one_bit' });

  const down = (async () => new Response('billing hold', { status: 402 })) as unknown as typeof globalThis.fetch;
  const failed = await samFindScreen({ ...cfg, fetch: down }, 'data:,');
  assert.equal(failed.match, null);
  assert.equal(failed.trace.note, 'HTTP 402');
});

test('demo samples: the packed PS-07 order holds, its tampered copy is rejected offline', async () => {
  const sample = (name: string) => JSON.parse(readFileSync(new URL(`../../../apps/web/public/samples/${name}`, import.meta.url), 'utf8'));
  assert.equal((await verifyBundle(sample('ps07-work-order.json'), policy(), null)).decision, 'hold');
  const v = await verifyBundle(sample('ps07-work-order-tampered.json'), policy(), null);
  assert.equal(v.decision, 'reject');
  assert.deepEqual(v.findings.map((f) => `${f.path} ${f.code}`), ['$.steps[4].setpoint out_of_range', '$.steps[5].instruction injection_suspected']);
});
