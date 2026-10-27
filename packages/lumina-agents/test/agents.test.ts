import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaChatModel, OllamaChatModel, PackError, packWorkOrder, samSegmentRequest, sha256Hex, verifyBundle } from '../src/index.ts';
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

test('Ollama adapter targets local Glimmer and round-trips tool messages', async () => {
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
  assert.equal(calls[0].body.model, 'muse-glimmer');
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual((calls[0].body.messages as unknown[])[1], { role: 'tool', content: '[]', tool_name: 'scan_text' });
  assert.equal(res.toolCalls[0].name, 'check_asset');
});

test('SAM 3.1 request follows the Responses API shape', () => {
  const req = samSegmentRequest('computer monitor', 'data:image/jpeg;base64,AAAA') as any;
  assert.equal(req.model, 'sam-3.1');
  assert.deepEqual(req.input[0].content.map((c: { type: string }) => c.type), ['input_text', 'input_image']);
});
