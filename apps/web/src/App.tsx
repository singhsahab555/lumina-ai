import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_BLOCK_SIZE } from '@lumina/protocol';
import { GridCanvas, type GridCanvasHandle } from './components/GridCanvas.tsx';
import { deflateRaw } from './lib/deflate.ts';
import { Transmitter, randomSessionId } from './lib/transmitter.ts';
import { startScheduler, type SchedulerStats } from './lib/scheduler.ts';

const SAMPLE_URL = '/samples/pump-station-log.txt';

interface Payload {
  name: string;
  originalBytes: number;
  compressedBytes: number;
  sessionId: number;
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg bg-zinc-900 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="font-mono text-sm text-zinc-100" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

export function App() {
  const grid = useRef<GridCanvasHandle>(null);
  const tx = useRef<Transmitter | null>(null);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [rate, setRate] = useState(30);
  const [paused, setPaused] = useState(false);
  const [seed, setSeed] = useState(0);
  const [stats, setStats] = useState<SchedulerStats>({ symbolsPerSecond: 0, refreshHz: 0 });
  const [error, setError] = useState<string | null>(null);

  const rateRef = useRef(rate);
  const runningRef = useRef(false);
  const seedRef = useRef(0);
  rateRef.current = rate;
  runningRef.current = !paused && payload !== null;

  const emit = useCallback(() => {
    if (!tx.current) return;
    const symbol = tx.current.next();
    grid.current?.draw(symbol.modules);
    seedRef.current = symbol.seed;
  }, []);

  useEffect(
    () =>
      startScheduler(
        () => rateRef.current,
        () => runningRef.current,
        emit,
        (s) => {
          setStats(s);
          setSeed(seedRef.current);
        },
      ),
    [emit],
  );

  const load = useCallback(
    async (name: string, bytes: Uint8Array) => {
      try {
        setError(null);
        const compressed = await deflateRaw(bytes);
        const sessionId = randomSessionId();
        tx.current = new Transmitter(compressed, sessionId);
        setPayload({ name, originalBytes: bytes.length, compressedBytes: compressed.length, sessionId });
        emit();
        setSeed(seedRef.current);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [emit],
  );

  const onFile = async (file: File | undefined) => {
    if (file) await load(file.name, new Uint8Array(await file.arrayBuffer()));
  };

  const loadSample = async () => {
    const res = await fetch(SAMPLE_URL);
    await load('pump-station-log.txt', new Uint8Array(await res.arrayBuffer()));
  };

  const step = () => {
    emit();
    setSeed(seedRef.current);
  };

  const k = tx.current?.k ?? 0;
  const repair = payload !== null && seed >= k;

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-6 lg:flex-row">
      <aside className="flex w-full flex-col gap-4 lg:w-80 lg:shrink-0">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">
            Lumina<span className="text-yellow-400">AI</span>
          </h1>
          <p className="text-sm text-zinc-400">Transmitter · raw mode · 2-color</p>
        </header>

        <label
          className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-zinc-700 px-4 py-6 text-center hover:border-yellow-400"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onFile(e.dataTransfer.files[0]);
          }}
        >
          <span className="text-sm font-medium">Choose or drop a file</span>
          <span className="text-xs text-zinc-500">deflate → LT fountain → light</span>
          <input type="file" className="hidden" data-testid="file" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        <button
          className="rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700"
          onClick={() => void loadSample()}
          data-testid="sample"
        >
          Load sample work order
        </button>

        <div className="rounded-xl bg-zinc-900 p-3">
          <div className="mb-1 flex justify-between text-sm">
            <span>Symbol rate</span>
            <span className="font-mono">{rate} /s</span>
          </div>
          <input
            type="range"
            min={1}
            max={60}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="w-full accent-yellow-400"
            data-testid="rate"
          />
          <div className="mt-2 flex gap-2">
            <button
              className="flex-1 rounded-lg bg-yellow-400 px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
              disabled={!payload}
              onClick={() => setPaused((p) => !p)}
              data-testid="pause"
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              className="flex-1 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={!payload || !paused}
              onClick={step}
              data-testid="step"
            >
              Step
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {payload && (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="File" value={payload.name} />
            <Stat label="Session" value={payload.sessionId.toString(16).padStart(8, '0')} testId="session" />
            <Stat label="Original" value={formatBytes(payload.originalBytes)} />
            <Stat
              label="Deflated"
              value={`${formatBytes(payload.compressedBytes)} (${Math.round((100 * payload.compressedBytes) / payload.originalBytes)}%)`}
            />
            <Stat label="Blocks K" value={`${k} × ${MAX_BLOCK_SIZE} B`} testId="k" />
            <Stat label="Seed" value={`${seed} ${repair ? 'repair' : 'systematic'}`} testId="seed" />
            <Stat label="Measured" value={`${stats.symbolsPerSecond} sym/s`} testId="measured" />
            <Stat label="Display" value={`${stats.refreshHz} Hz`} />
            <Stat label="Raw rate" value={`${formatBytes(stats.symbolsPerSecond * MAX_BLOCK_SIZE)}/s`} />
            <Stat label="Frames sent" value={`${seed + 1}`} />
          </div>
        )}
      </aside>

      <main className="flex flex-1 items-center justify-center">
        <div className="relative w-full max-w-[min(80vh,720px)]">
          <GridCanvas ref={grid} className={`w-full bg-white ${payload ? '' : 'invisible'}`} />
          {!payload && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl border border-zinc-800 text-sm text-zinc-500">
              Load a file to start beaming
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
