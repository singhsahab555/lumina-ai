// Connected side: Muse Spark distils a long maintenance document into a small,
// schema-valid work-order bundle that is then beamed over light.
//
// Lossy by design: the bundle is a semantic summary. Provenance fields
// (kind, source title/bytes/SHA-256) and the site, when the sender knows it, are
// set here, never taken from the model. The hash identifies the source, not the bundle.

import { BUNDLE_SCHEMA_ID, PARAMETER_KEYS, WORK_ORDER_JSON_SCHEMA, validateBundle, type WorkOrderBundle } from './schema.ts';
import { tracedChat, type ChatMessage, type ChatModel, type TraceEvent } from './models/types.ts';
import { sha256Hex, utf8 } from './util.ts';

const SYSTEM_PROMPT = `You convert industrial maintenance logs and manuals into a work-order bundle for an air-gapped control system.
Rules:
- Use only facts stated in the document. Never invent assets, steps, or setpoint values.
- asset_id is the single asset the work order acts on.
- One step per action, in the document's order. Keep instructions short and imperative.
- When a step changes a value, fill setpoint using one of: ${PARAMETER_KEYS.join(', ')}. Otherwise setpoint is null.
- summary: at most 3 sentences on what happened and why the work is needed.
- Leave source as {"title":"","bytes":0,"sha256":""}; it is filled in by software.
Reply with one JSON object of exactly this shape (example values; every key is required):
{"schema":"${BUNDLE_SCHEMA_ID}","kind":"neural-summary","work_order_id":"WO-2026-0001","site":"Example Site","asset_id":"P-01A",
"summary":"...","steps":[{"order":1,"instruction":"Isolate P-01A.","setpoint":null},
{"order":2,"instruction":"Set vibration alarm to 6.0 mm/s.","setpoint":{"parameter":"vibration_alarm","value":6.0,"unit":"mm/s"}}],
"source":{"title":"","bytes":0,"sha256":""}}`;

export interface PackResult {
  bundle: WorkOrderBundle;
  json: string;
  sourceBytes: number;
  bundleBytes: number;
  attempts: number;
  trace: TraceEvent[];
}

export class PackError extends Error {
  readonly errors: string[];
  readonly trace: TraceEvent[];
  constructor(errors: string[], trace: TraceEvent[]) {
    super(`bundle failed validation: ${errors.slice(0, 5).join('; ')}`);
    this.errors = errors;
    this.trace = trace;
  }
}

function parseJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  try {
    return JSON.parse(start >= 0 ? text.slice(start, end + 1) : text);
  } catch {
    return null;
  }
}

export async function packWorkOrder(
  model: ChatModel,
  source: { title: string; text: string },
  opts: { maxAttempts?: number; site?: string; onTrace?: (event: TraceEvent) => void } = {},
): Promise<PackResult> {
  const trace: TraceEvent[] = [];
  const sourceBytes = utf8(source.text);
  const provenance = { title: source.title, bytes: sourceBytes.length, sha256: await sha256Hex(sourceBytes) };
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Document "${source.title}":\n\n${source.text}` },
  ];

  let errors: string[] = [];
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await tracedChat(model, `pack#${attempt}`, {
      messages,
      jsonSchema: { name: 'WorkOrderBundle', schema: WORK_ORDER_JSON_SCHEMA as unknown as Record<string, unknown> },
      temperature: 0,
    }, trace);

    const parsed = parseJson(res.content);
    const report = () => opts.onTrace?.(trace[trace.length - 1]);
    if (parsed && typeof parsed === 'object') {
      Object.assign(parsed, { schema: BUNDLE_SCHEMA_ID, kind: 'neural-summary', source: provenance }, opts.site ? { site: opts.site } : {});
    }
    const result = validateBundle(parsed);
    if (result.ok) {
      report();
      const json = JSON.stringify(result.bundle);
      return { bundle: result.bundle, json, sourceBytes: sourceBytes.length, bundleBytes: utf8(json).length, attempts: attempt, trace };
    }
    errors = result.errors;
    trace[trace.length - 1].note = `invalid: ${errors.slice(0, 3).join('; ')}`;
    report();
    messages.push(
      { role: 'assistant', content: res.content },
      { role: 'user', content: `That bundle is invalid:\n- ${errors.join('\n- ')}\nReturn the corrected bundle only.` },
    );
  }
  throw new PackError(errors, trace);
}
