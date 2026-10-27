// Decode worker: keeps finder detection (~30 ms per 720p frame) off the UI thread.

import { ReceiverSession, unpack, type FrameReport, type ReceivedFile, type RxStats } from './receiver.ts';

export type RxRequest = { type: 'frame'; width: number; height: number; buffer: ArrayBuffer } | { type: 'reset' };
export type RxResponse =
  | { type: 'frame'; report: FrameReport; stats: RxStats; ms: number }
  | { type: 'file'; file: ReceivedFile }
  | { type: 'error'; message: string };

const ctx = self as unknown as {
  onmessage: (e: MessageEvent<RxRequest>) => void;
  postMessage(msg: RxResponse, transfer?: Transferable[]): void;
};

let rx = new ReceiverSession();

ctx.onmessage = async ({ data: msg }) => {
  if (msg.type === 'reset') {
    rx = new ReceiverSession();
    return;
  }
  const t0 = performance.now();
  const { report, payload } = rx.push({ width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) });
  ctx.postMessage({ type: 'frame', report, stats: rx.stats(), ms: Math.round(performance.now() - t0) });
  if (!payload) return;
  try {
    const file = await unpack(payload);
    ctx.postMessage({ type: 'file', file }, [file.bytes.buffer as ArrayBuffer]);
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
