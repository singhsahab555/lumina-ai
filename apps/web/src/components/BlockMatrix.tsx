import { useEffect, useRef } from 'react';

// One cell per source block of the fountain code: dark = unknown, amber =
// pinned by an equation from mixed droplets (solved once the rank is full),
// green = recovered. Large files are bucketed so the matrix stays one canvas.

const MAX_CELLS = 1024;
const COLORS = ['#27272a', '#f59e0b', '#22c55e'];

export function BlockMatrix({ states }: { states: Uint8Array }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const k = states.length;
  const per = Math.max(1, Math.ceil(k / MAX_CELLS));
  const cells = Math.ceil(k / per);
  const cols = Math.min(cells, Math.max(16, Math.ceil(Math.sqrt(cells * 4))));
  const rows = Math.ceil(cells / cols);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !k) return;
    const size = 8;
    c.width = cols * size;
    c.height = rows * size;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    for (let cell = 0; cell < cells; cell++) {
      // A bucket shows its least-recovered block, so green means all of it is in.
      let s = 2;
      for (let i = cell * per; i < Math.min(k, (cell + 1) * per); i++) s = Math.min(s, states[i]);
      g.fillStyle = COLORS[s];
      g.fillRect((cell % cols) * size, Math.floor(cell / cols) * size, size - 1, size - 1);
    }
  }, [states, k, per, cells, cols, rows]);

  if (!k) return null;
  return (
    <div className="mt-2" data-testid="rx-blocks">
      <canvas ref={canvas} className="w-full [image-rendering:pixelated]" style={{ aspectRatio: `${cols} / ${rows}` }} />
      <div className="mt-1 flex gap-3 text-[10px] text-zinc-500">
        <span><span className="text-emerald-500">■</span> recovered</span>
        <span><span className="text-amber-500">■</span> pinned by mixed droplets</span>
        <span><span className="text-zinc-600">■</span> missing</span>
        {per > 1 && <span>1 cell = {per} blocks</span>}
      </div>
    </div>
  );
}
