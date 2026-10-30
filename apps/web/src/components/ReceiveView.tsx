import { useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '@lumina/protocol';
import type { ScreenFind } from '@lumina/agents';
import type { ReceivedFile, RxStats } from '../lib/receiver.ts';
import type { RxRequest, RxResponse } from '../lib/receiver.worker.ts';
import { Stat, formatBytes, formatDuration } from './Stat.tsx';
import { VerifierPanel, parseBundle } from './VerifierPanel.tsx';
import { AckBeam, type PlantDecision } from './AckBeam.tsx';
import { AckPanel } from './AckPanel.tsx';
import { parseAck } from '../lib/ack.ts';
import { cropFor, roiFromMatch, toVideo, type Crop, type Rect } from '../lib/roi.ts';

// Frames are downscaled to this long side before decoding: plenty for the
// ≥4 px/module the detector needs, and it keeps decode time near 30 ms.
const MAX_SIDE = 1280;
// With a SAM region, frames that miss the grid this many times in a row
// mean the screen moved: ask SAM again (or fall back to the whole frame).
const LOST_AFTER = 45;
const SAM_RETRY_MS = 3000;

// SAM 3.1 runs on the connected side's helper (server/sam-api.ts). 'absent'
// is GitHub Pages or the plant, where no helper exists.
type Sam =
  | { kind: 'absent' }
  | { kind: 'no-key' }
  | { kind: 'ready'; model: string }
  | { kind: 'finding' }
  | { kind: 'locked'; find: ScreenFind; roi: Rect }
  | { kind: 'missed'; find: ScreenFind | null; error?: string };

type Phase = 'idle' | 'starting' | 'scanning' | 'done';

interface Run {
  stop(): void;
}

// The overlay is in video pixels scaled by `k`; the SAM region is drawn in blue.
function drawQuad(canvas: HTMLCanvasElement, quad: Point[] | null, valid: boolean, k = 1, roi: Rect | null = null) {
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (roi) {
    g.lineWidth = Math.max(2, canvas.width / 400);
    g.strokeStyle = '#38bdf8';
    g.setLineDash([12, 8]);
    g.strokeRect(roi.x * k, roi.y * k, roi.w * k, roi.h * k);
    g.setLineDash([]);
    g.fillStyle = '#38bdf8';
    g.font = `${Math.max(14, canvas.width / 60)}px system-ui`;
    g.fillText('SAM 3.1 · computer monitor', roi.x * k + 6, Math.max(18, roi.y * k - 6));
  }
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
  const [sam, setSam] = useState<Sam>({ kind: 'absent' });
  const [decision, setDecision] = useState<PlantDecision | null>(null);
  const roiRef = useRef<Rect | null>(null);
  const samModel = useRef('');
  // Set while the camera runs: grabs a still and asks SAM for the screen.
  const findScreen = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    fetch('/api/sam')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((s: { ready: boolean; model: string } | null) => {
        if (!s) return;
        samModel.current = s.model ?? '';
        setSam(s.ready ? { kind: 'ready', model: s.model } : { kind: 'no-key' });
      });
  }, []);

  const camera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => () => run.current?.stop(), []);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const start = async (id = deviceId) => {
    run.current?.stop();
    setError(null);
    setFile(null);
    setElapsed(0);
    setStats(null);
    setDecision(null);
    roiRef.current = null;
    setSam((s) => (s.kind === 'locked' || s.kind === 'missed' || s.kind === 'finding' ? { kind: 'ready', model: samModel.current } : s));
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
      // Two frames in flight: the next grab overlaps the current decode.
      let inFlight = 0;
      let replies = 0;
      let windowStart = performance.now();
      let firstValid = 0;
      // Crops of the frames in flight, in order: the worker answers in order.
      const crops: Crop[] = [];
      let k = 1;
      let misses = 0;
      let lastSam = 0;

      findScreen.current = async () => {
        if (!v.videoWidth) return;
        lastSam = performance.now();
        setSam({ kind: 'finding' });
        const still = document.createElement('canvas');
        const s = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
        still.width = Math.round(v.videoWidth * s);
        still.height = Math.round(v.videoHeight * s);
        still.getContext('2d')!.drawImage(v, 0, 0, still.width, still.height);
        try {
          const res = await fetch('/api/sam', { method: 'POST', body: JSON.stringify({ image: still.toDataURL('image/jpeg', 0.85), prompt: 'computer monitor' }) });
          const find = (await res.json()) as ScreenFind & { error?: string };
          if (!res.ok || !find.match) {
            roiRef.current = null;
            setSam({ kind: 'missed', find: res.ok ? find : null, error: find.error ?? (find.trace?.ok === false ? find.trace.note : undefined) });
            return;
          }
          roiRef.current = roiFromMatch(find.match, v.videoWidth, v.videoHeight);
          misses = 0;
          setSam({ kind: 'locked', find, roi: roiRef.current });
        } catch (e) {
          roiRef.current = null;
          setSam({ kind: 'missed', find: null, error: e instanceof Error ? e.message : String(e) });
        }
      };

      const stop = () => {
        running = false;
        findScreen.current = null;
        worker.terminate();
        stream.getTracks().forEach((t) => t.stop());
        v.srcObject = null;
      };
      run.current = { stop };

      worker.onmessage = ({ data: msg }: MessageEvent<RxResponse>) => {
        if (msg.type === 'frame') {
          inFlight--;
          replies++;
          const crop = crops.shift()!;
          const now = performance.now();
          if (msg.report.valid && !firstValid) firstValid = now;
          if (now - windowStart > 500) {
            setPerf({ fps: Math.round((replies * 1000) / (now - windowStart)), ms: msg.ms });
            if (firstValid) setElapsed((now - firstValid) / 1000);
            replies = 0;
            windowStart = now;
          }
          setStats(msg.stats);
          const quad = msg.report.quad?.map((p) => toVideo(p, crop)) ?? null;
          if (overlay.current) drawQuad(overlay.current, quad, msg.report.valid, k, roiRef.current);
          if (roiRef.current) {
            misses = msg.report.quad ? 0 : misses + 1;
            if (misses >= LOST_AFTER && now - lastSam > SAM_RETRY_MS) void findScreen.current?.();
          }
        } else if (msg.type === 'file') {
          setElapsed(firstValid ? (performance.now() - firstValid) / 1000 : 0);
          setFile(msg.file);
          setUrl(URL.createObjectURL(new Blob([msg.file.bytes as BlobPart])));
          setPhase('done');
          if (overlay.current) drawQuad(overlay.current, null, false);
          stop();
        } else {
          inFlight--;
          crops.shift();
          setError(msg.message);
        }
      };
      // A page left open across a deploy points at a worker file Pages no
      // longer serves; without this the receiver just sits silent.
      worker.onerror = (e) => {
        e.preventDefault();
        setError('STALE');
        stop();
        setPhase('idle');
      };

      const schedule = () =>
        'requestVideoFrameCallback' in v ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
      const tick = () => {
        if (!running) return;
        if (inFlight < 2 && v.videoWidth) {
          // Whole frame downscaled, or SAM's region at native resolution.
          const c = cropFor(v.videoWidth, v.videoHeight, MAX_SIDE, roiRef.current);
          const w = c.dw;
          const h = c.dh;
          if (grab.width !== w || grab.height !== h) {
            grab.width = w;
            grab.height = h;
          }
          k = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
          const ow = Math.round(v.videoWidth * k);
          if (overlay.current && overlay.current.width !== ow) {
            overlay.current.width = ow;
            overlay.current.height = Math.round(v.videoHeight * k);
          }
          g.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
          const img = g.getImageData(0, 0, w, h);
          crops.push(c);
          inFlight++;
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
  // Rank grows ~1 per unique droplet, so the remaining blocks over the recent
  // droplet rate is an honest ETA (plus a couple of droplets of overhead).
  const dropletRate = elapsed > 1 && stats ? stats.received / elapsed : 0;
  const eta = dropletRate && stats && stats.k ? (stats.k - stats.solved + 2) / dropletRate : null;
  const scanning = phase === 'scanning' || phase === 'starting';
  // Only a byte-exact file is worth checking: a corrupted bundle never reaches the verifier.
  const bundle = useMemo(() => (file?.verified ? parseBundle(file.bytes) : null), [file]);
  const ack = useMemo(() => (file?.verified ? parseAck(file.bytes) : null), [file]);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <aside className="flex w-full flex-col gap-4 lg:w-80 lg:shrink-0">
        <p className="text-sm text-zinc-400">
          Receiver · camera → finders → homography → LT <span className="text-zinc-600">· build {__BUILD_ID__}</span>
        </p>

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

        {error === 'STALE' ? (
          <div className="flex flex-col gap-2 rounded-lg bg-red-950 p-3 text-sm text-red-300" data-testid="rx-stale">
            The receiver code failed to load: this page is probably an old cached version.
            <button className="rounded-md bg-red-800 px-3 py-1.5 text-white" onClick={() => location.reload()}>
              Reload to update
            </button>
          </div>
        ) : (
          error && <p className="text-sm text-red-400">{error}</p>
        )}

        {scanning && sam.kind !== 'absent' && (
          <div className="flex flex-col gap-1 rounded-lg bg-zinc-900 p-2 text-xs" data-testid="sam">
            {sam.kind === 'no-key' ? (
              <span className="text-zinc-500">SAM 3.1 needs MODEL_API_KEY (Meta Model API) on this helper. Reading the whole frame.</span>
            ) : (
              <>
                <button
                  className="rounded-md bg-sky-800 px-3 py-1.5 text-white hover:bg-sky-700 disabled:opacity-40"
                  disabled={sam.kind === 'finding' || phase !== 'scanning'}
                  onClick={() => void findScreen.current?.()}
                  data-testid="sam-find"
                >
                  {sam.kind === 'finding' ? 'SAM 3.1 looking…' : sam.kind === 'locked' ? 'Find the screen again' : 'Find the far screen (SAM 3.1)'}
                </button>
                {sam.kind === 'locked' && (
                  <span className="text-sky-300" data-testid="sam-locked">
                    Locked: {Math.round(sam.roi.w)}×{Math.round(sam.roi.h)} px region, decoded at camera resolution · {sam.find.trace.ms} ms
                  </span>
                )}
                {sam.kind === 'missed' && (
                  <span className="text-amber-400">
                    {sam.error ? `SAM 3.1: ${sam.error}` : 'SAM 3.1 found no monitor'}. Reading the whole frame.
                  </span>
                )}
              </>
            )}
          </div>
        )}

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
              <Stat label="Decode" value={`${perf.fps} fps · ${perf.ms} ms`} testId="rx-decode" />
              <Stat label="Frames read" value={`${stats.frames}`} testId="rx-frames" />
              <Stat label="Grid found" value={`${stats.located}`} testId="rx-located" />
              <Stat label="CRC valid" value={`${stats.valid}`} testId="rx-valid" />
              <Stat label="Unique droplets" value={`${stats.received}`} testId="rx-unique" />
              <Stat label="Colors seen" value={`${stats.colors}`} testId="rx-colors" />
              <Stat label="Droplets / frame" value={stats.valid ? (stats.packets / stats.valid).toFixed(2) : '-'} testId="rx-dpf" />
              {phase !== 'done' && (
                <>
                  <Stat label="Droplets / s" value={dropletRate ? dropletRate.toFixed(1) : '-'} testId="rx-rate" />
                  <Stat label="ETA" value={eta === null ? '-' : formatDuration(eta)} testId="rx-eta" />
                </>
              )}
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
              <Stat label="Over light" value={`${elapsed.toFixed(1)} s`} testId="rx-elapsed" />
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

        {file && bundle && <VerifierPanel bundle={bundle} fileName={file.name} onDecision={setDecision} />}
        {file && ack && <AckPanel ack={ack} />}
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
          {phase === 'done' && file && (ack || !file.verified) && (
            <div className="flex aspect-video items-center justify-center text-sm text-zinc-400">Transfer complete. Camera off.</div>
          )}
          {phase === 'done' && file?.verified && !ack && stats && (
            <AckBeam
              file={file}
              decision={bundle ? decision : null}
              telemetry={{ seconds: Math.round(elapsed * 10) / 10, frames: stats.frames, crcValid: stats.valid, droplets: stats.received, k: stats.k }}
            />
          )}
        </div>
      </section>
    </div>
  );
}
