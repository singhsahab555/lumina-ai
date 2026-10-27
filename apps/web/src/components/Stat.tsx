export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
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
