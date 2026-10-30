// Plant-side verifier model via Ollama on the plant network (Llama 3.1 8B by
// default): the only model on the air-gapped side. No API key, no internet.

import { ModelHttpError, type ChatMessage, type ChatModel, type ChatRequest, type ChatResponse } from './types.ts';

export const OLLAMA_URL = 'http://localhost:11434';
export const VERIFIER_MODEL = 'llama3.1:8b';

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return { role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((t) => ({ function: { name: t.name, arguments: t.arguments } })) };
  }
  return { role: m.role, content: m.content };
}

export class OllamaChatModel implements ChatModel {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: OllamaConfig = {}) {
    this.baseUrl = cfg.baseUrl ?? OLLAMA_URL;
    this.model = cfg.model ?? VERIFIER_MODEL;
    this.doFetch = cfg.fetch ?? globalThis.fetch.bind(globalThis);
    this.id = `ollama:${this.model}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = { model: this.model, messages: req.messages.map(toWire), stream: false };
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    if (req.jsonSchema) body.format = req.jsonSchema.schema;
    if (req.temperature !== undefined) body.options = { temperature: req.temperature };

    const res = await this.doFetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ModelHttpError(res.status, await res.text());
    const json = (await res.json()) as {
      message: { content: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
    };
    return {
      content: json.message.content ?? '',
      toolCalls: (json.message.tool_calls ?? []).map((t, i) => ({ id: `call_${i}`, name: t.function.name, arguments: t.function.arguments ?? {} })),
    };
  }

  /** True when Ollama is up and the model is pulled. */
  async available(): Promise<boolean> {
    try {
      const res = await this.doFetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return false;
      const { models } = (await res.json()) as { models: { name: string }[] };
      return models.some((m) => m.name === this.model || m.name.startsWith(`${this.model}:`));
    } catch {
      return false;
    }
  }
}
