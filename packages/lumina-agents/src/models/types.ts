// Provider-neutral chat interface. Spark (Meta Model API, OpenAI-compatible)
// and Glimmer (Ollama) both adapt to it, and tests use a scripted fake.

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Constrain the reply to this JSON Schema (structured output). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
}

export interface ChatModel {
  /** e.g. "meta:muse-spark-1.3" or "ollama:muse-glimmer" */
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** One model call, as shown in the UI's model-trace panel. */
export interface TraceEvent {
  model: string;
  op: string;
  ms: number;
  inputBytes: number;
  outputBytes: number;
  ok: boolean;
  note?: string;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

export async function tracedChat(model: ChatModel, op: string, req: ChatRequest, trace: TraceEvent[]): Promise<ChatResponse> {
  const started = performance.now();
  const inputBytes = byteLength(JSON.stringify(req.messages));
  try {
    const res = await model.chat(req);
    trace.push({
      model: model.id,
      op,
      ms: Math.round(performance.now() - started),
      inputBytes,
      outputBytes: byteLength(res.content) + byteLength(JSON.stringify(res.toolCalls)),
      ok: true,
      note: res.toolCalls.length ? `tools: ${res.toolCalls.map((t) => t.name).join(', ')}` : undefined,
    });
    return res;
  } catch (e) {
    trace.push({ model: model.id, op, ms: Math.round(performance.now() - started), inputBytes, outputBytes: 0, ok: false, note: String(e) });
    throw e;
  }
}

export class ModelHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}
