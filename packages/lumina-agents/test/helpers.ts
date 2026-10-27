import { readFileSync } from 'node:fs';
import type { ChatModel, ChatRequest, ChatResponse, SitePolicy, WorkOrderBundle } from '../src/index.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

export const policy = (): SitePolicy => fixture('site-policy.json');
export const validBundle = (): WorkOrderBundle => fixture('bundle-valid.json');
export const tamperedBundle = (): WorkOrderBundle => fixture('bundle-tampered.json');
export const sampleLog = () => readFileSync(new URL('../../../apps/web/public/samples/pump-station-log.txt', import.meta.url), 'utf8');

/** Replays canned replies in order and records every request. */
export class ScriptedModel implements ChatModel {
  readonly id = 'test:scripted';
  readonly requests: ChatRequest[] = [];
  private readonly replies: ((req: ChatRequest) => ChatResponse)[];

  constructor(replies: ((req: ChatRequest) => ChatResponse)[]) {
    this.replies = replies;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    const next = this.replies.shift();
    if (!next) throw new Error('script exhausted');
    return next(req);
  }
}

export const say = (content: string) => (): ChatResponse => ({ content, toolCalls: [] });

/** fetch stub that records the request and answers with a JSON body. */
export function fakeFetch(reply: unknown) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
