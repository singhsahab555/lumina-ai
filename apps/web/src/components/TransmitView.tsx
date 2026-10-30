import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_BLOCK_SIZE, sealEnvelope, sha256, toHex } from '@lumina/protocol';
import { GridCanvas, type GridCanvasHandle } from './GridCanvas.tsx';
import { PackerPanel } from './PackerPanel.tsx';
import { Stat, formatBytes, formatDuration } from './Stat.tsx';
import { deflateRaw } from '../lib/deflate.ts';
import { Transmitter, dropletsPerSymbol, randomSessionId, type TxMode } from '../lib/transmitter.ts';
import { startScheduler, type SchedulerStats } from '../lib/scheduler.ts';
import { rememberBeam } from '../lib/ack.ts';

const sampleUrl = (name: string) => `${import.meta.env.BASE_URL}samples/${name}`;

interface Payload {
  name: string;
  originalBytes: number;
  compressedBytes: number;
  sessionId: number;
  sha256: string;
}

export function TransmitView() {
  const grid = useRef<GridCanvasHandle>(null);
  const tx = useRef<Transmitter | null>(null);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [rate, setRate] = useState(30);
  const [mode, setMode] = useState<TxMode>('auto');
  const [colors, setColors] = useState(8);
  const [paused, setPaused] = useState(false);
  const [seed, setSeed] = useState(0);
  const [stats, setStats] = useState<SchedulerStats>({ symbolsPerSecond: 0, refreshHz: 0 });
  const [error, setError] = useState<string | null>(null);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  if (tx.current) tx.current.mode = mode;
  const rateRef = useRef(rate);
  const runningRef = useRef(false);
  const seedRef = useRef(0);
  rateRef.current = rate;
  runningRef.current = !paused && payload !== null;

  const emit = useCallback(() => {
    if (!tx.current) return;
    const symbol = tx.current.next();
    grid.current?.draw(symbol.modules, symbol.colors);
    seedRef.current = symbol.seed;
    setColors(symbol.colors);
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
        // The envelope carries the name and SHA-256, so the receiver can verify the file itself.
        const compressed = await deflateRaw(sealEnvelope(name, bytes));
        const sessionId = randomSessionId();
        tx.current = new Transmitter(compressed, sessionId, modeRef.current);
        const hash = toHex(sha256(bytes));
        setPayload({ name, originalBytes: bytes.length, compressedBytes: compressed.length, sessionId, sha256: hash });
        // The plant's signed ack names this hash; the Receive tab matches them.
        rememberBeam({ name, sha256: hash, at: new Date().toISOString() });
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

  const loadSample = async (name: string) => {
    const res = await fetch(sampleUrl(name));
    await load(name, new Uint8Array(await res.arrayBuffer()));
  };

  const step = () => {
    emit();
    setSeed(seedRef.current);
  };

  const k = tx.current?.k ?? 0;
  const repair = payload !== null && seed >= k;
  // One pass of K droplets is the floor for any receiver; camera loss adds to it.
  const passSeconds = k / ((stats.symbolsPerSecond || rate) * dropletsPerSymbol(mode));

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <aside className="flex w-full flex-col gap-4 lg:w-80 lg:shrink-0">
        <p className="text-sm text-zinc-400">Transmitter · raw mode · {colors}-color <span className="text-zinc-600">· build {__BUILD_ID__}</span></p>

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
          onClick={() => void loadSample('pump-station-log.txt')}
          data-testid="sample"
        >
          Load sample work order
        </button>
        <button
          className="rounded-lg border border-red-900 px-3 py-2 text-sm text-red-300 hover:bg-red-950"
          onClick={() => void loadSample('ps07-work-order-tampered.json')}
          data-testid="sample-tampered"
          title="The packed PS-07 order, altered by a compromised sender: discharge limit 9 bar and an injected interlock bypass"
        >
          Load tampered work order (attack demo)
        </button>
        <PackerPanel onBeam={(name, bytes) => void load(name, bytes)} />

        <div className="rounded-xl bg-zinc-900 p-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>Colors</span>
            <div className="flex gap-1 rounded-lg bg-zinc-800 p-0.5">
              {(['auto', 8, 2] as const).map((m) => (
                <button
                  key={m}
                  className={`rounded-md px-2.5 py-1 text-xs ${mode === m ? 'bg-yellow-400 font-medium text-black' : 'text-zinc-300'}`}
                  onClick={() => setMode(m)}
                  data-testid={`mode-${m}`}
                  title={m === 'auto' ? '8-color, with every 4th symbol in 2-color as a fallback' : `${m}-color only`}
                >
                  {m === 'auto' ? 'Auto' : m}
                </button>
              ))}
            </div>
          </div>
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
            <Stat label="Raw rate" value={`${formatBytes(Math.round(stats.symbolsPerSecond * MAX_BLOCK_SIZE * dropletsPerSymbol(mode)))}/s`} />
            <Stat label="Droplets sent" value={`${seed + 1}`} />
            <Stat label="Min. time" value={formatDuration(passSeconds)} testId="tx-eta" />
            {passSeconds > 120 && (
              <p className="col-span-2 rounded-lg bg-amber-950 p-2 text-xs text-amber-200" data-testid="tx-large">
                Large file: at least {formatDuration(passSeconds)} over light at this rate, more if the camera drops frames. Keep the receiver steady, or send a smaller file.
              </p>
            )}
            <div className="col-span-2">
              <Stat label="SHA-256" value={`${payload.sha256.slice(0, 16)}…`} testId="tx-sha" />
            </div>
            <a href="#rx" className="col-span-2 rounded-lg bg-zinc-800 px-3 py-2 text-center text-xs hover:bg-zinc-700" data-testid="await-ack">
              Return channel: receive the plant's signed ack →
            </a>
          </div>
        )}
      </aside>

      <section className="flex flex-1 items-center justify-center">
        <div className="relative w-full max-w-[min(80vh,720px)]">
          <GridCanvas ref={grid} className={`w-full bg-white ${payload ? '' : 'invisible'}`} />
          {!payload && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl border border-zinc-800 text-sm text-zinc-500">
              Load a file to start beaming
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
