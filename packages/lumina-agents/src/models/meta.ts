// Meta Model API (https://api.meta.ai/v1), connected side only.
// Chat completions are OpenAI-compatible; structured output uses
// response_format.json_schema with strict: true. Docs: dev.meta.ai/docs.

import { ModelHttpError, type ChatMessage, type ChatModel, type ChatRequest, type ChatResponse } from './types.ts';

export const META_BASE_URL = 'https://api.meta.ai/v1';
export const SPARK_MODEL = 'muse-spark-1.3';
export const SAM_MODEL = 'sam-3.1';

export interface MetaConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
    };
  }
  return { role: m.role, content: m.content };
}

export class MetaChatModel implements ChatModel {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: MetaConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl ?? META_BASE_URL;
    this.model = cfg.model ?? SPARK_MODEL;
    this.doFetch = cfg.fetch ?? globalThis.fetch.bind(globalThis);
    this.id = `meta:${this.model}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = { model: this.model, messages: req.messages.map(toWire) };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    if (req.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { ...req.jsonSchema, strict: true } };

    const res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ModelHttpError(res.status, await res.text());
    const json = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    const msg = json.choices[0].message;
    return {
      content: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: JSON.parse(t.function.arguments || '{}') })),
    };
  }
}

// SAM 3.1 goes through the Responses API: a text prompt plus an image, and
// the reply is special-token text with one box and one mask per match. The
// output grammar is on dev.meta.ai "reading segmentation output"; the parser
// lands on Day 7 together with the return channel.
export function samSegmentRequest(prompt: string, imageUrl: string): Record<string, unknown> {
  return {
    model: SAM_MODEL,
    stream: true,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageUrl },
        ],
      },
    ],
  };
}

/** Collects the streamed output text of a SAM 3.1 call (raw special-token text). */
export async function samSegmentRaw(cfg: MetaConfig, prompt: string, imageUrl: string): Promise<string> {
  const doFetch = cfg.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch(`${cfg.baseUrl ?? META_BASE_URL}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(samSegmentRequest(prompt, imageUrl)),
  });
  if (!res.ok) throw new ModelHttpError(res.status, await res.text());
  let out = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    const event = JSON.parse(data) as { type?: string; delta?: string };
    if (event.type === 'response.output_text.delta' && event.delta) out += event.delta;
  }
  return out;
}
