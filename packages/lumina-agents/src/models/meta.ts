// Meta Model API (https://api.meta.ai/v1), connected side only.
// Chat completions are OpenAI-compatible; structured output uses
// response_format.json_schema with strict: true. Docs: dev.meta.ai/docs.

import { ModelHttpError, type ChatMessage, type ChatModel, type ChatRequest, type ChatResponse } from './types.ts';

export const META_BASE_URL = 'https://api.meta.ai/v1';
export const SPARK_MODEL = 'muse-spark-1.3';
export const SAM_MODEL = 'sam-3.1';
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const NVIDIA_GLIMMER_MODEL = 'meta/muse-glimmer-30b';
export const BASETEN_BASE_URL = 'https://inference.baseten.co/v1';
export const BASETEN_SPARK_MODEL = 'meta-models/muse-spark-open';

/**
 * Packer model for the connected sender, first key wins: Muse Spark on the Meta
 * Model API, Muse Spark Open on Baseten, then Meta's open-weight Muse Glimmer 30B
 * on NVIDIA NIM. All speak the same wire format. Null when no key is set.
 */
export function packerFromEnv(env: Record<string, string | undefined>): MetaChatModel | null {
  if (env.MODEL_API_KEY) return new MetaChatModel({ apiKey: env.MODEL_API_KEY, baseUrl: env.META_BASE_URL, model: env.SPARK_MODEL });
  if (env.BASETEN_API_KEY) {
    // Baseten has JSON mode but not strict json_schema; validateBundle() re-checks anyway.
    return new MetaChatModel({
      apiKey: env.BASETEN_API_KEY,
      baseUrl: env.BASETEN_BASE_URL || BASETEN_BASE_URL,
      model: env.BASETEN_MODEL || BASETEN_SPARK_MODEL,
      provider: 'baseten',
      stream: true,
      jsonMode: 'object',
    });
  }
  return redTeamFromEnv(env);
}

/**
 * Red-team model for the connected sender: Muse Glimmer 30B on NVIDIA NIM, a
 * different model from the Spark packer, so the reviewer doesn't share the
 * packer's blind spots. Null without NVIDIA_API_KEY.
 */
export function redTeamFromEnv(env: Record<string, string | undefined>): MetaChatModel | null {
  if (!env.NVIDIA_API_KEY) return null;
  return new MetaChatModel({
    apiKey: env.NVIDIA_API_KEY,
    baseUrl: env.NVIDIA_BASE_URL || NVIDIA_BASE_URL,
    model: env.NVIDIA_MODEL || NVIDIA_GLIMMER_MODEL,
    provider: 'nvidia',
    stream: true,
  });
}

export interface MetaConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Trace label prefix; 'nvidia' when the same wire format goes to NVIDIA NIM. */
  provider?: string;
  /** Stream the reply (SSE). NVIDIA NIM's gateway 504s on long non-streamed reasoning replies. */
  stream?: boolean;
  /** 'schema' sends the strict json_schema; 'object' asks only for a JSON object, for providers without strict mode. */
  jsonMode?: 'schema' | 'object';
  fetch?: typeof fetch;
}

type WireToolCall = { id: string; function: { name: string; arguments: string } };

function fromWire(content: string | null, toolCalls: WireToolCall[] | undefined): ChatResponse {
  return {
    content: content ?? '',
    toolCalls: (toolCalls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: JSON.parse(t.function.arguments || '{}') })),
  };
}

/** Reads a chat-completions SSE stream. reasoning_content deltas are dropped; content and tool-call deltas are joined. */
async function readStream(res: Response): Promise<ChatResponse> {
  let content = '';
  const calls: WireToolCall[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split('\n');
    buf = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return fromWire(content, calls);
      const delta = (JSON.parse(data) as {
        choices: { delta: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      }).choices[0]?.delta;
      if (!delta) continue;
      content += delta.content ?? '';
      for (const t of delta.tool_calls ?? []) {
        const call = (calls[t.index] ??= { id: '', function: { name: '', arguments: '' } });
        if (t.id) call.id = t.id;
        call.function.name += t.function?.name ?? '';
        call.function.arguments += t.function?.arguments ?? '';
      }
    }
  }
  return fromWire(content, calls);
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
  private readonly stream: boolean;
  private readonly jsonMode: 'schema' | 'object';
  private readonly doFetch: typeof fetch;

  constructor(cfg: MetaConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl ?? META_BASE_URL;
    this.model = cfg.model ?? SPARK_MODEL;
    this.stream = cfg.stream ?? false;
    this.jsonMode = cfg.jsonMode ?? 'schema';
    this.doFetch = cfg.fetch ?? globalThis.fetch.bind(globalThis);
    this.id = `${cfg.provider ?? 'meta'}:${this.model}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = { model: this.model, messages: req.messages.map(toWire) };
    if (this.stream) body.stream = true;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    if (req.jsonSchema) {
      body.response_format =
        this.jsonMode === 'object' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { ...req.jsonSchema, strict: true } };
    }

    const res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ModelHttpError(res.status, await res.text());
    if (this.stream) return readStream(res);
    const json = (await res.json()) as { choices: { message: { content: string | null; tool_calls?: WireToolCall[] } }[] };
    const msg = json.choices[0].message;
    return fromWire(msg.content, msg.tool_calls);
  }
}

// SAM 3.1 goes through the Responses API: a text prompt plus an image, and
// the reply is special-token text with one box and one mask per match. The
// output grammar is on dev.meta.ai "reading segmentation output"; sam.ts parses it.
// `metadata` values are strings: include_confidence 'true', mask_encoding 'one_bit'.
export function samSegmentRequest(prompt: string, imageUrl: string, metadata?: Record<string, string>): Record<string, unknown> {
  return {
    model: SAM_MODEL,
    stream: true,
    ...(metadata && { metadata }),
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
export async function samSegmentRaw(cfg: MetaConfig, prompt: string, imageUrl: string, metadata?: Record<string, string>): Promise<string> {
  const doFetch = cfg.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch(`${cfg.baseUrl ?? META_BASE_URL}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...samSegmentRequest(prompt, imageUrl, metadata), ...(cfg.model && { model: cfg.model }) }),
  });
  if (!res.ok) throw new ModelHttpError(res.status, await res.text());
  let out = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    const event = JSON.parse(data) as { type?: string; delta?: string };
    if (event.type === 'response.completed') break;
    if (event.type === 'response.output_text.delta' && event.delta) out += event.delta;
  }
  return out;
}
