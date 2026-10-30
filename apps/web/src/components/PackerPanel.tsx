import { useEffect, useRef, useState } from 'react';
import type { TraceEvent, WorkOrderBundle } from '@lumina/agents';
import { formatBytes, formatDuration } from './Stat.tsx';

// Meta AI packer on the connected sender. With the local helper (npm run dev /
// lan, see server/pack-api.ts) it packs the 45-day shift log live. Where there
// is no helper, e.g. GitHub Pages, it replays the recorded real run that
// produced samples/ps07-work-order.json, labelled as recorded.

const SOURCE = 'ps07-shift-log-45d.txt';
const BUNDLE = 'ps07-work-order.json';
const sampleUrl = (name: string) => `${import.meta.env.BASE_URL}samples/${name}`;

interface Run {
  sourceBytes: number;
  bundleBytes: number;
  attempts: number;
  trace: TraceEvent[];
  date?: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number; model: string }
  | { kind: 'done'; run: Run; bundle: WorkOrderBundle; json: string; live: boolean }
  | { kind: 'error'; message: string };

export function PackerPanel({ onBeam }: { onBeam: (name: string, bytes: Uint8Array) => void }) {
  // null until probed; then the helper's model id, or '' when there is no helper.
  const [liveModel, setLiveModel] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [attempts, setAttempts] = useState<TraceEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const replay = useRef(0);

  useEffect(() => {
    fetch('/api/pack')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { ready: boolean; model: string } | null) => setLiveModel(s?.ready ? s.model : ''))
      .catch(() => setLiveModel(''));
  }, []);

  useEffect(() => {
    if (status.kind !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [status.kind]);

  const packLive = async () => {
    setAttempts([]);
    setStatus({ kind: 'running', startedAt: Date.now(), model: liveModel ?? '' });
    try {
      const text = await (await fetch(sampleUrl(SOURCE))).text();
      const res = await fetch('/api/pack', { method: 'POST', body: JSON.stringify({ title: SOURCE, text }) });
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
          if (msg.type === 'attempt') setAttempts((a) => [...a, msg.event]);
          else if (msg.type === 'error') setStatus({ kind: 'error', message: msg.message });
          else if (msg.type === 'done') {
            const r = msg.result;
            setStatus({ kind: 'done', run: r, bundle: r.bundle, json: r.json, live: true });
          }
        }
      }
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Shows the recorded attempts one by one (sped up), with their real timings.
  const playRecorded = async () => {
    const id = ++replay.current;
    setAttempts([]);
    const [run, json] = await Promise.all([
      fetch(sampleUrl(BUNDLE.replace('.json', '.run.json'))).then((r) => r.json() as Promise<Run>),
      fetch(sampleUrl(BUNDLE)).then((r) => r.text()),
    ]);
    setStatus({ kind: 'running', startedAt: Date.now(), model: run.trace[0]?.model ?? '' });
    for (const event of run.trace) {
      await new Promise((r) => setTimeout(r, 900));
      if (replay.current !== id) return;
      setAttempts((a) => [...a, event]);
    }
    // Beam the compact form, as a live pack would, so the size shown is the size sent.
    const bundle = JSON.parse(json) as WorkOrderBundle;
    setStatus({ kind: 'done', run, bundle, json: JSON.stringify(bundle), live: false });
  };

  const live = Boolean(liveModel);
  const done = status.kind === 'done' ? status : null;

  return (
    <div className="rounded-xl bg-zinc-900 p-3 text-sm" data-testid="packer">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">Meta AI packer</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${live ? 'bg-emerald-900 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}>
          {liveModel === null ? '…' : live ? 'live' : 'recorded run'}
        </span>
      </div>
      <p className="mb-2 text-xs text-zinc-500">
        45-day shift log ({formatBytes(56190)}) → work-order JSON, schema-checked. Lossy summary.
      </p>

      <button
        className="w-full rounded-lg bg-zinc-800 px-3 py-2 hover:bg-zinc-700 disabled:opacity-40"
        disabled={liveModel === null || status.kind === 'running'}
        onClick={() => void (live ? packLive() : playRecorded())}
        data-testid="pack"
      >
        {live ? 'Pack shift log with Meta AI' : 'Replay recorded Meta AI pack'}
      </button>

      {status.kind === 'running' && (
        <p className="mt-2 text-xs text-zinc-400">
          {status.model} · {live ? `working ${formatDuration((now - status.startedAt) / 1000)} (a pass takes minutes)` : 'replaying'}
        </p>
      )}

      {attempts.length > 0 && (
        <ul className="mt-2 space-y-1 font-mono text-[11px]">
          {attempts.map((t) => (
            <li key={t.op} className={t.note?.startsWith('invalid') ? 'text-amber-400' : 'text-emerald-400'}>
              {t.op} {formatDuration(t.ms / 1000)} · in {formatBytes(t.inputBytes)} · out {formatBytes(t.outputBytes)}
              {t.note && <div className="truncate text-zinc-500" title={t.note}>{t.note}</div>}
            </li>
          ))}
        </ul>
      )}

      {status.kind === 'error' && <p className="mt-2 text-xs text-red-400">{status.message}</p>}

      {done && (
        <div className="mt-2 space-y-2">
          <p className="text-xs">
            <span className="font-mono">{formatBytes(done.run.sourceBytes)}</span> →{' '}
            <span className="font-mono text-yellow-400">{formatBytes(done.run.bundleBytes)}</span>{' '}
            <span className="text-zinc-500">
              ({Math.round(done.run.sourceBytes / done.run.bundleBytes)}× smaller, {done.run.attempts} attempt
              {done.run.attempts > 1 ? 's' : ''}
              {!done.live && done.run.date ? `, recorded ${done.run.date.slice(0, 10)}` : ''})
            </span>
          </p>
          <details className="text-xs text-zinc-400">
            <summary className="cursor-pointer">
              {done.bundle.asset_id} · {done.bundle.steps.length} steps · {done.bundle.site}
            </summary>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              {done.bundle.steps.map((s) => (
                <li key={s.order}>
                  {s.instruction}
                  {s.setpoint && <span className="text-yellow-400"> [{s.setpoint.parameter} = {s.setpoint.value} {s.setpoint.unit}]</span>}
                </li>
              ))}
            </ol>
          </details>
          <button
            className="w-full rounded-lg bg-yellow-400 px-3 py-1.5 font-medium text-black"
            onClick={() => onBeam(BUNDLE, new TextEncoder().encode(done.json))}
            data-testid="beam-bundle"
          >
            Beam this bundle over light
          </button>
        </div>
      )}
    </div>
  );
}
