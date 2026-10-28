export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(s: number): string {
  if (s < 60) return `${Math.ceil(s)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${Math.round(s % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg bg-zinc-900 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="truncate font-mono text-sm text-zinc-100" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
