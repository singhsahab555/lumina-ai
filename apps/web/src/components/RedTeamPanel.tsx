import { useEffect, useRef, useState } from 'react';
import { groundBundle, type GroundingCheck, type RedTeamReport, type TraceEvent, type WorkOrderBundle } from '@lumina/agents';
import { sha256, toHex } from '@lumina/protocol';
import { formatDuration } from './Stat.tsx';

// Sender-side red-team, between packing and beaming. Grounding checks run here
// in the browser at once (source hash, asset and every setpoint found in the
// source). Muse Glimmer 30B then attacks the bundle: live through the local
// helper (server/redteam-api.ts), or, where there is none (GitHub Pages), as a
// replay of a recorded real run, but only for the exact bundle it was run on.

const sampleUrl = (name: string) => `${import.meta.env.BASE_URL}samples/${name}`;

interface Recording {
  date: string;
  bundleSha256: string;
  report: RedTeamReport;
}

type Model = { kind: 'probing' } | { kind: 'live'; model: string } | { kind: 'recorded'; rec: Recording } | { kind: 'none' };
type Run =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'done'; report: RedTeamReport; live: boolean; date?: string }
  | { kind: 'error'; message: string };

const VERDICT: Record<RedTeamReport['verdict'], { label: string; tone: string }> = {
  clear: { label: 'CLEAR', tone: 'bg-emerald-500 text-black' },
  flag: { label: 'FLAGGED', tone: 'bg-red-500 text-white' },
  'grounding-only': { label: 'GROUNDING ONLY', tone: 'bg-amber-400 text-black' },
};

function Grounding({ checks }: { checks: GroundingCheck[] }) {
  return (
    <ul className="space-y-0.5 text-[11px]" data-testid="grounding">
      {checks.map((c) => (
        <li key={c.path} className={c.ok ? 'text-zinc-400' : 'text-red-300'}>
          <span className={c.ok ? 'text-emerald-400' : 'text-red-400'}>{c.ok ? '✓' : '✗'}</span> {c.message}
        </li>
      ))}
    </ul>
  );
}

export function RedTeamPanel({ bundle, fileName }: { bundle: WorkOrderBundle; fileName: string }) {
  const [grounding, setGrounding] = useState<GroundingCheck[] | null>(null);
  const [model, setModel] = useState<Model>({ kind: 'probing' });
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const [calls, setCalls] = useState<TraceEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const replay = useRef(0);
  const source = useRef<string | null>(null);

  useEffect(() => {
    setRun({ kind: 'idle' });
    setCalls([]);
    const loadSource = async () => (source.current ??= await (await fetch(sampleUrl(bundle.source.title))).text());
    void loadSource()
      .then((text) => groundBundle(bundle, text))
      .then(setGrounding)
      .catch(() => setGrounding([]));
    const recorded = async (): Promise<Model> => {
      const sha = toHex(sha256(new TextEncoder().encode(JSON.stringify(bundle))));
      const res = await fetch(sampleUrl(fileName.replace(/\.json$/, '.redteam.json')));
      const rec = res.ok ? ((await res.json()) as Recording) : null;
      return rec?.bundleSha256 === sha ? { kind: 'recorded', rec } : { kind: 'none' };
    };
    fetch('/api/redteam')
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

  const runLive = async () => {
    setCalls([]);
    setRun({ kind: 'running', startedAt: Date.now() });
    try {
      const text = source.current ?? (await (await fetch(sampleUrl(bundle.source.title))).text());
      const res = await fetch('/api/redteam', { method: 'POST', body: JSON.stringify({ bundle, title: bundle.source.title, text }) });
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
          else if (msg.type === 'done') setRun({ kind: 'done', report: msg.report, live: true });
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
    await new Promise((r) => setTimeout(r, 1200));
    if (replay.current !== id) return;
    setCalls(rec.report.trace);
    setRun({ kind: 'done', report: rec.report, live: false, date: rec.date });
  };

  const modelName =
    model.kind === 'live' ? model.model : model.kind === 'recorded' ? model.rec.report.model ?? 'model' : 'nvidia:meta/muse-glimmer-30b';
  const done = run.kind === 'done' ? run : null;
  const grounded = grounding?.every((c) => c.ok) ?? true;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5" data-testid="redteam">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Red-team before sending</span>
        {done ? (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${VERDICT[done.report.verdict].tone}`} data-testid="redteam-verdict">
            {VERDICT[done.report.verdict].label}
          </span>
        ) : (
          grounding && (
            <span className={`text-[10px] ${grounded ? 'text-emerald-400' : 'text-red-400'}`}>{grounded ? 'grounded' : 'not grounded'}</span>
          )
        )}
      </div>
      <p className="mb-1.5 text-[11px] text-zinc-500">
        A second Meta model attacks the bundle against the source log. Advisory: the plant's offline gate still decides.
      </p>

      {grounding && <Grounding checks={grounding} />}

      {(model.kind === 'live' || model.kind === 'recorded') && (
        <button
          className="mt-2 w-full rounded-md bg-zinc-800 px-2 py-1.5 text-xs hover:bg-zinc-700 disabled:opacity-40"
          disabled={run.kind === 'running'}
          onClick={() => void (model.kind === 'live' ? runLive() : playRecorded(model.rec))}
          data-testid="redteam-run"
        >
          {model.kind === 'live' ? `Attack it with ${modelName.split('/').pop()}` : `Replay recorded red-team (${modelName.split('/').pop()})`}
        </button>
      )}
      {model.kind === 'none' && <p className="mt-2 text-[11px] text-zinc-600">No red-team model here (needs NVIDIA_API_KEY on the sender).</p>}

      {run.kind === 'running' && (
        <p className="mt-1.5 text-[11px] text-zinc-400">
          {modelName} · {model.kind === 'live' ? `reasoning ${formatDuration((now - run.startedAt) / 1000)}` : 'replaying'}
        </p>
      )}
      {run.kind === 'error' && <p className="mt-1.5 text-[11px] text-red-400">{run.message}</p>}

      {done && (
        <div className="mt-1.5 space-y-1">
          {calls.map((t) => (
            <p key={t.op} className="font-mono text-[10px] text-zinc-500">
              {t.model} · {formatDuration(t.ms / 1000)}
              {!done.live && done.date ? ` · recorded ${done.date.slice(0, 10)}` : ''}
            </p>
          ))}
          {done.report.issues.length === 0 && done.report.verdict === 'clear' && (
            <p className="text-[11px] text-emerald-300">No unsupported, unsafe or injected content found.</p>
          )}
          <ul className="space-y-1" data-testid="redteam-issues">
            {done.report.issues.map((i, n) => (
              <li key={n} className="rounded bg-red-950/60 px-2 py-1 text-[11px] text-red-200">
                <span className="font-semibold uppercase">{i.kind}</span>
                {i.step !== null && <span className="text-red-400"> · step {i.step}</span>}
                <div className="text-red-100/80">{i.detail}</div>
              </li>
            ))}
          </ul>
          {done.report.notes.map((n) => (
            <p key={n} className="text-[11px] text-amber-300">{n}</p>
          ))}
        </div>
      )}
    </div>
  );
}
