import { useEffect, useRef, useState } from 'react';
import { validateBundle, verifyBundle, type SitePolicy, type TraceEvent, type Verdict, type WorkOrderBundle } from '@lumina/agents';
import { sha256, toHex } from '@lumina/protocol';
import sitePolicy from '../../../../packages/lumina-agents/fixtures/site-policy.json';
import { formatDuration } from './Stat.tsx';
import type { PlantDecision } from './AckBeam.tsx';

// Plant-side check of a received work-order bundle.
//  1. The deterministic policy gate runs right here, offline, on any device:
//     it alone can reject, and without a model the best outcome is HOLD.
//  2. The plant verifier model (Llama 3.1 8B on the plant network's Ollama,
//     via server/verify-api.ts) inspects it with tool calls. Where that helper
//     isn't reachable (GitHub Pages) a recorded real run is replayed, but only
//     for the exact bundle it was recorded on.

const policy = sitePolicy as SitePolicy;
const sampleUrl = (name: string) => `${import.meta.env.BASE_URL}samples/${name}`;

/** The received file as a work-order bundle, or null when it is any other file. */
export function parseBundle(bytes: Uint8Array): WorkOrderBundle | null {
  try {
    const r = validateBundle(JSON.parse(new TextDecoder().decode(bytes)));
    return r.ok ? r.bundle : null;
  } catch {
    return null;
  }
}

interface Recording {
  date: string;
  bundleSha256: string;
  verdict: Verdict;
}

type Model =
  | { kind: 'probing' }
  | { kind: 'live'; model: string }
  | { kind: 'recorded'; rec: Recording }
  | { kind: 'none' };

type Run =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'done'; verdict: Verdict; live: boolean }
  | { kind: 'error'; message: string };

const DECISION_STYLE = {
  approve: 'bg-emerald-900 text-emerald-200',
  hold: 'bg-amber-900 text-amber-200',
  reject: 'bg-red-900 text-red-200',
} as const;

const DECISION_TEXT = {
  approve: 'APPROVED: safe to stage on the HMI',
  hold: 'HOLD: policy checks passed, waiting for a verifier model',
  reject: 'REJECTED: do not apply',
} as const;

export function VerifierPanel({
  bundle,
  fileName,
  onDecision,
}: {
  bundle: WorkOrderBundle;
  fileName: string;
  /** The current decision, for the signed ack the plant beams back. */
  onDecision?: (d: PlantDecision) => void;
}) {
  const [gate, setGate] = useState<Verdict | null>(null);
  const [model, setModel] = useState<Model>({ kind: 'probing' });
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const [calls, setCalls] = useState<TraceEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const replay = useRef(0);

  useEffect(() => {
    void verifyBundle(bundle, policy, null).then(setGate);
    const recorded = async (): Promise<Model> => {
      // TS SHA-256: crypto.subtle is missing on plain-http LAN pages.
      const sha = toHex(sha256(new TextEncoder().encode(JSON.stringify(bundle))));
      const res = await fetch(sampleUrl(fileName.replace(/\.json$/, '.verify.json')));
      const rec = res.ok ? ((await res.json()) as Recording) : null;
      return rec?.bundleSha256 === sha ? { kind: 'recorded', rec } : { kind: 'none' };
    };
    fetch('/api/verify')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((s: { ready: boolean; model: string } | null) => (s?.ready ? { kind: 'live' as const, model: s.model } : recorded()))
      .catch((): Model => ({ kind: 'none' }))
      .then(setModel);
  }, [bundle, fileName]);

  useEffect(() => {
    if (run.kind !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [run.kind]);

  const verifyLive = async () => {
    setCalls([]);
    setRun({ kind: 'running', startedAt: Date.now() });
    try {
      const res = await fetch('/api/verify', { method: 'POST', body: JSON.stringify({ bundle }) });
      if (!res.ok) throw new Error(`plant verifier unavailable (HTTP ${res.status})`);
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split('\n');
        buf = lines.pop()!;
        for (const line of lines.filter(Boolean)) {
          const msg = JSON.parse(line);
          if (msg.type === 'call') setCalls((c) => [...c, msg.event]);
          else if (msg.type === 'error') setRun({ kind: 'error', message: msg.message });
          else if (msg.type === 'done') setRun({ kind: 'done', verdict: msg.verdict, live: true });
        }
      }
    } catch (e) {
      setRun({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const playRecorded = async (rec: Recording) => {
    const id = ++replay.current;
    setCalls([]);
    setRun({ kind: 'running', startedAt: Date.now() });
    for (const event of rec.verdict.trace) {
      await new Promise((r) => setTimeout(r, 700));
      if (replay.current !== id) return;
      setCalls((c) => [...c, event]);
    }
    setRun({ kind: 'done', verdict: rec.verdict, live: false });
  };

  const done = run.kind === 'done' ? run : null;
  const verdict = done?.verdict ?? gate;
  const flagged = new Map<number, string[]>();
  for (const f of verdict?.findings ?? []) {
    const i = /^\$\.steps\[(\d+)\]/.exec(f.path)?.[1];
    if (i !== undefined) flagged.set(Number(i), [...(flagged.get(Number(i)) ?? []), f.message]);
  }
  const header = verdict?.findings.filter((f) => !f.path.startsWith('$.steps')) ?? [];
  const modelName = model.kind === 'live' ? model.model : model.kind === 'recorded' ? model.rec.verdict.trace[0]?.model ?? 'model' : '';
  const decidedBy = done ? `policy gate + ${modelName}${done.live ? '' : ' (recorded run)'}` : 'deterministic policy gate, on this device, offline';

  useEffect(() => {
    if (verdict) onDecision?.({ verdict, decidedBy, workOrderId: bundle.work_order_id });
  }, [verdict, decidedBy, bundle, onDecision]);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3 text-sm" data-testid="verifier">
      <div className="flex items-center justify-between">
        <span className="font-medium">Plant verifier · {policy.policy_id}</span>
        <span className="text-[10px] text-zinc-500">{policy.site}</span>
      </div>

      {verdict && (
        <div className={`rounded-lg px-3 py-2 font-medium ${DECISION_STYLE[verdict.decision]}`} data-testid="verdict">
          {DECISION_TEXT[verdict.decision]}
          <div className="text-[11px] font-normal opacity-80">
            {decidedBy}
          </div>
        </div>
      )}
      {done?.verdict.modelOverruled && (
        <p className="text-xs text-red-300">The model said approve; the policy gate overruled it. The gate is final.</p>
      )}

      {header.map((f) => (
        <p key={f.path + f.code} className="text-xs text-red-300">
          ✗ {f.message}
        </p>
      ))}

      <div className="text-xs text-zinc-400">
        {bundle.work_order_id} · {bundle.asset_id}
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">
          {bundle.steps.map((s, i) => (
            <li key={s.order} className={flagged.has(i) ? 'text-red-300' : ''} data-testid={flagged.has(i) ? 'flagged-step' : undefined}>
              {s.instruction}
              {s.setpoint && <span className="text-yellow-400"> [{s.setpoint.parameter} = {s.setpoint.value} {s.setpoint.unit}]</span>}
              {flagged.get(i)?.map((m) => (
                <div key={m} className="text-[11px] text-red-400">
                  ✗ {m}
                </div>
              ))}
            </li>
          ))}
        </ol>
      </div>

      {model.kind === 'live' && (
        <button
          className="rounded-lg bg-zinc-800 px-3 py-2 hover:bg-zinc-700 disabled:opacity-40"
          disabled={run.kind === 'running'}
          onClick={() => void verifyLive()}
          data-testid="verify-model"
        >
          Verify with {model.model} (plant network)
        </button>
      )}
      {model.kind === 'recorded' && (
        <button
          className="rounded-lg bg-zinc-800 px-3 py-2 hover:bg-zinc-700 disabled:opacity-40"
          disabled={run.kind === 'running'}
          onClick={() => void playRecorded(model.rec)}
          data-testid="verify-model"
        >
          Replay recorded plant verification
        </button>
      )}
      {model.kind === 'none' && (
        <p className="text-xs text-zinc-500">No plant verifier model reachable. The gate result above stands (fail-closed).</p>
      )}

      {run.kind === 'running' && (
        <p className="text-xs text-zinc-400">
          {modelName} · {model.kind === 'live' ? `working ${formatDuration((now - run.startedAt) / 1000)}` : 'replaying'}
        </p>
      )}
      {calls.length > 0 && (
        <ul className="space-y-0.5 font-mono text-[11px] text-zinc-400">
          {calls.map((t) => (
            <li key={t.op} className={t.ok ? '' : 'text-red-400'}>
              {t.op} {formatDuration(t.ms / 1000)}
              {t.note && <span className="text-zinc-500"> · {t.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {done?.verdict.model && (
        <div className="text-xs">
          <span className="text-zinc-500">
            Model: {done.verdict.model.decision}
            {done.verdict.model.injectionSuspected ? ', injection suspected' : ''}
          </span>
          <ul className="list-disc pl-4 text-zinc-300">
            {done.verdict.model.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {done?.verdict.notes.map((n) => (
        <p key={n} className="text-xs text-amber-400">
          {n}
        </p>
      ))}
      {run.kind === 'error' && <p className="text-xs text-red-400">{run.message}</p>}
    </div>
  );
}
