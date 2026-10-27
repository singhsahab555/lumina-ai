// Fires onSymbol at a fixed symbol rate, aligned to display refreshes. At 30
// symbols/s on a 60 Hz panel each symbol is held for exactly 2 refreshes,
// which keeps rolling-shutter cameras from catching a half-drawn frame.

const JITTER_MS = 2;

export interface SchedulerStats {
  symbolsPerSecond: number;
  refreshHz: number;
}

export function startScheduler(
  rate: () => number,
  running: () => boolean,
  onSymbol: () => void,
  onStats: (stats: SchedulerStats) => void,
): () => void {
  const symbolTimes: number[] = [];
  const refreshTimes: number[] = [];
  let due = performance.now();
  let lastStats = 0;
  let raf = 0;

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    refreshTimes.push(now);
    const interval = 1000 / rate();
    if (running() && now >= due - JITTER_MS) {
      onSymbol();
      symbolTimes.push(now);
      due += interval;
      if (now - due > interval) due = now + interval; // fell behind (tab hidden etc.)
    } else if (!running()) {
      due = now;
    }
    while (symbolTimes.length && now - symbolTimes[0] > 1000) symbolTimes.shift();
    while (refreshTimes.length && now - refreshTimes[0] > 1000) refreshTimes.shift();
    if (now - lastStats > 250) {
      lastStats = now;
      onStats({ symbolsPerSecond: symbolTimes.length, refreshHz: refreshTimes.length });
    }
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
