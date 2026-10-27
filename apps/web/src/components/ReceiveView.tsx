import { useEffect, useRef, useState } from 'react';
import type { Point } from '@lumina/protocol';
import type { ReceivedFile, RxStats } from '../lib/receiver.ts';
import type { RxRequest, RxResponse } from '../lib/receiver.worker.ts';
import { Stat, formatBytes } from './Stat.tsx';

// Frames are downscaled to this long side before decoding: plenty for the
// ≥4 px/module the detector needs, and it keeps decode time near 30 ms.
const MAX_SIDE = 1280;

type Phase = 'idle' | 'starting' | 'scanning' | 'done';

interface Run {
  stop(): void;
}

function drawQuad(canvas: HTMLCanvasElement, quad: Point[] | null, valid: boolean) {
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!quad) return;
  g.lineWidth = Math.max(3, canvas.width / 240);
  g.strokeStyle = valid ? '#4ade80' : '#facc15';
  g.beginPath();
  quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  g.stroke();
}

export function ReceiveView() {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const run = useRef<Run | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stats, setStats] = useState<RxStats | null>(null);
  const [perf, setPerf] = useState({ fps: 0, ms: 0 });
  const [file, setFile] = useState<ReceivedFile | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');

  const camera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => () => run.current?.stop(), []);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const start = async (id = deviceId) => {
    run.current?.stop();
    setError(null);
    setFile(null);
    setStats(null);
    setPhase('starting');
    try {
      const size = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } };
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: id ? { deviceId: { exact: id }, ...size } : { facingMode: { ideal: 'environment' }, ...size },
      });
      const v = video.current!;
      v.srcObject = stream;
      await v.play();
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'));

      const worker = new Worker(new URL('../lib/receiver.worker.ts', import.meta.url), { type: 'module' });
      const grab = document.createElement('canvas');
      const g = grab.getContext('2d', { willReadFrequently: true })!;
      let running = true;
      let busy = false;
      let replies = 0;
      let windowStart = performance.now();
      let firstValid = 0;

      const stop = () => {
        running = false;
        worker.terminate();
        stream.getTracks().forEach((t) => t.stop());
        v.srcObject = null;
      };
      run.current = { stop };

      worker.onmessage = ({ data: msg }: MessageEvent<RxResponse>) => {
        if (msg.type === 'frame') {
          busy = false;
          replies++;
          const now = performance.now();
          if (msg.report.valid && !firstValid) firstValid = now;
          if (now - windowStart > 500) {
            setPerf({ fps: Math.round((replies * 1000) / (now - windowStart)), ms: msg.ms });
            replies = 0;
            windowStart = now;
          }
          setStats(msg.stats);
          if (overlay.current) drawQuad(overlay.current, msg.report.quad, msg.report.valid);
        } else if (msg.type === 'file') {
          setElapsed(firstValid ? (performance.now() - firstValid) / 1000 : 0);
          setFile(msg.file);
          setUrl(URL.createObjectURL(new Blob([msg.file.bytes as BlobPart])));
          setPhase('done');
          if (overlay.current) drawQuad(overlay.current, null, false);
          stop();
        } else {
          setError(msg.message);
        }
      };

      const schedule = () =>
        'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
      const tick = () => {
        if (!running) return;
        if (!busy && v.videoWidth) {
          const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
          const w = Math.round(v.videoWidth * scale);
          const h = Math.round(v.videoHeight * scale);
          if (grab.width !== w || grab.height !== h) {
            grab.width = w;
            grab.height = h;
            if (overlay.current) {
              overlay.current.width = w;
              overlay.current.height = h;
            }
          }
          g.drawImage(v, 0, 0, w, h);
          const img = g.getImageData(0, 0, w, h);
          busy = true;
          const req: RxRequest = { type: 'frame', width: w, height: h, buffer: img.data.buffer };
          worker.postMessage(req, [img.data.buffer]);
        }
        schedule();
      };
      setPhase('scanning');
      schedule();
    } catch (e) {
      setPhase('idle');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  };

  const stop = () => {
    run.current?.stop();
    run.current = null;
    setPhase('idle');
  };

  const progress = stats && stats.k ? stats.solved / stats.k : 0;
  const scanning = phase === 'scanning' || phase === 'starting';

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <aside className="flex w-full flex-col gap-4 lg:w-80 lg:shrink-0">
        <p className="text-sm text-zinc-400">Receiver · camera → finders → homography → LT</p>

        {!camera && (
          <p className="rounded-lg bg-red-950 p-3 text-sm text-red-300">
            Camera access needs a secure page. Open this app on <span className="font-mono">https://</span> or{' '}
            <span className="font-mono">localhost</span> (see README: npm run lan).
          </p>
        )}

        <div className="flex gap-2">
          {scanning ? (
            <button className="flex-1 rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700" onClick={stop}>
              Stop camera
            </button>
          ) : (
            <button
              className="flex-1 rounded-lg bg-yellow-400 px-3 py-2 text-sm font-medium text-black disabled:opacity-40"
              disabled={!camera}
              onClick={() => void start()}
              data-testid="rx-start"
            >
              {phase === 'done' ? 'Receive another' : 'Start camera'}
            </button>
          )}
        </div>

        {devices.length > 1 && (
          <select
            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm"
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              if (scanning) void start(e.target.value);
            }}
          >
            <option value="">Default (rear) camera</option>
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {stats && (
          <>
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span>Blocks recovered</span>
                <span className="font-mono" data-testid="rx-progress">
                  {stats.solved} / {stats.k || '?'}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-zinc-800">
                <div className="h-full bg-yellow-400 transition-[width]" style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Session" value={stats.sessionId === null ? '-' : stats.sessionId.toString(16).padStart(8, '0')} />
              <Stat label="Decode" value={`${perf.fps} fps · ${perf.ms} ms`} />
              <Stat label="Frames read" value={`${stats.frames}`} />
              <Stat label="Grid found" value={`${stats.located}`} />
              <Stat label="CRC valid" value={`${stats.valid}`} testId="rx-valid" />
              <Stat label="Unique droplets" value={`${stats.received}`} />
            </div>
          </>
        )}

        {file && (
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
            {file.verified ? (
              <div className="font-medium text-green-400" data-testid="rx-verified">
                ✓ SHA-256 verified, byte-exact
              </div>
            ) : (
              <div className="font-medium text-red-400" data-testid="rx-mismatch">
                ✗ SHA-256 mismatch: do not use this file
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Stat label="File" value={file.name} testId="rx-name" />
              <Stat label="Size" value={formatBytes(file.bytes.length)} />
              <Stat label="Over light" value={`${elapsed.toFixed(1)} s`} />
              <Stat label="Throughput" value={elapsed ? `${formatBytes(Math.round(file.bytes.length / elapsed))}/s` : '-'} />
              <div className="col-span-2">
                <Stat label="SHA-256" value={file.sha256} testId="rx-sha" />
              </div>
            </div>
            {url && (
              <a
                href={url}
                download={file.name}
                className="rounded-lg bg-yellow-400 px-3 py-2 text-center text-sm font-medium text-black"
                data-testid="rx-download"
              >
                Download {file.name}
              </a>
            )}
          </div>
        )}
      </aside>

      <section className="flex flex-1 items-start justify-center">
        <div className="relative w-full max-w-[720px] overflow-hidden rounded-xl border border-zinc-800 bg-black">
          <video ref={video} className={scanning ? 'block w-full' : 'hidden'} playsInline muted />
          <canvas ref={overlay} className="pointer-events-none absolute inset-0 h-full w-full" />
          {phase === 'idle' && !file && (
            <div className="flex aspect-video items-center justify-center p-6 text-center text-sm text-zinc-500">
              Point the camera at a transmitter grid. Fill at least a third of the frame and hold steady.
            </div>
          )}
          {phase === 'done' && file && (
            <div className="flex aspect-video items-center justify-center text-sm text-zinc-400">Transfer complete. Camera off.</div>
          )}
        </div>
      </section>
    </div>
  );
}
