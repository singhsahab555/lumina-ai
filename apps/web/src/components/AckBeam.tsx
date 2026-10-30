import { useCallback, useEffect, useRef, useState } from 'react';
import { sealEnvelope } from '@lumina/protocol';
import type { Verdict } from '@lumina/agents';
import { GridCanvas, type GridCanvasHandle } from './GridCanvas.tsx';
import { deflateRaw } from '../lib/deflate.ts';
import { Transmitter, randomSessionId } from '../lib/transmitter.ts';
import { startScheduler } from '../lib/scheduler.ts';
import { keyFingerprint, fromB64url, plantKey, signAck, type AckBody, type AckTelemetry, type SignedAck } from '../lib/ack.ts';
import type { ReceivedFile } from '../lib/receiver.ts';

// Plant side of the return channel: sign an ack for the file that just
// arrived and beam it back on this screen, with the same codec the order came
// in on. Nothing here touches a network.

export interface PlantDecision {
  verdict: Verdict;
  decidedBy: string;
  workOrderId: string;
}

const RATES = [5, 10, 20] as const;

export function AckBeam({ file, decision, telemetry }: { file: ReceivedFile; decision: PlantDecision | null; telemetry: AckTelemetry }) {
  const grid = useRef<GridCanvasHandle>(null);
  const tx = useRef<Transmitter | null>(null);
  const [ack, setAck] = useState<{ signed: SignedAck; bytes: number; persistent: boolean } | null>(null);
  const [rate, setRate] = useState<number>(10);
  const [error, setError] = useState<string | null>(null);
  const rateRef = useRef(rate);
  rateRef.current = rate;

  const emit = useCallback(() => {
    const s = tx.current?.next();
    if (s) grid.current?.draw(s.modules, s.colors);
  }, []);

  useEffect(() => (ack ? startScheduler(() => rateRef.current, () => true, emit, () => {}) : undefined), [ack, emit]);

  const beam = async () => {
    try {
      setError(null);
      const { keys, persistent } = await plantKey();
      const v = decision?.verdict;
      const body: AckBody = {
        file_name: file.name,
        file_sha256: file.sha256,
        file_bytes: file.bytes.length,
        work_order_id: decision?.workOrderId ?? null,
        decision: v ? v.decision : 'received',
        decided_by: decision?.decidedBy ?? 'none (not a work order)',
        findings: (v?.findings ?? []).map((f) => ({ code: f.code, path: f.path })),
        telemetry,
        issued_at: new Date().toISOString(),
      };
      const signed = await signAck(body, keys);
      const bytes = new TextEncoder().encode(JSON.stringify(signed, null, 1));
      const name = `ack-${(body.work_order_id ?? file.name).replace(/[^\w.-]+/g, '_')}.json`;
      tx.current = new Transmitter(await deflateRaw(sealEnvelope(name, bytes)), randomSessionId(), 'auto');
      setAck({ signed, bytes: bytes.length, persistent });
    } catch (e) {
      // crypto.subtle exists only on secure pages, the same rule as the camera.
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  };

  // Drawn once the canvas exists.
  useEffect(() => {
    if (ack) emit();
  }, [ack, emit]);

  if (!ack) {
    return (
      <div className="flex aspect-video flex-col items-center justify-center gap-3 p-6 text-center text-sm text-zinc-400">
        Transfer complete. Camera off.
        <button className="rounded-lg bg-yellow-400 px-4 py-2 font-medium text-black" onClick={() => void beam()} data-testid="ack-beam">
          Beam signed ack back
        </button>
        <span className="max-w-sm text-xs text-zinc-500">
          Signs the SHA-256 of this file{decision ? `, the ${decision.verdict.decision.toUpperCase()} decision` : ''} and receive telemetry with this device's
          key, then shows it here for the sender's webcam.
        </span>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 bg-zinc-950 p-3" data-testid="ack-beaming">
      <GridCanvas ref={grid} className="mx-auto w-full max-w-[min(70vh,640px)] bg-white" />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <span>
          Return channel · signed ack · {ack.bytes} B · {ack.signed.body.decision.toUpperCase()}
        </span>
        <div className="flex gap-1 rounded-lg bg-zinc-800 p-0.5">
          {RATES.map((r) => (
            <button key={r} className={`rounded-md px-2 py-0.5 ${rate === r ? 'bg-yellow-400 text-black' : ''}`} onClick={() => setRate(r)}>
              {r}/s
            </button>
          ))}
        </div>
      </div>
      <div className="text-xs text-zinc-400">
        Plant key <span className="font-mono text-zinc-200" data-testid="ack-key">{keyFingerprint(fromB64url(ack.signed.key))}</span>
        {!ack.persistent && <span className="text-amber-400"> · storage blocked: new key each page load</span>}
        <div className="text-zinc-500">The sender confirms this fingerprint once, the first time it sees this device.</div>
      </div>
    </div>
  );
}
