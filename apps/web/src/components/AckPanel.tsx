import { useEffect, useState } from 'react';
import { lastBeam, trustKey, trustedKeys, verifyAck, type AckCheck, type SignedAck } from '../lib/ack.ts';
import { formatBytes } from './Stat.tsx';

// Connected side of the return channel: an ack read off the plant screen.
// It counts only when the signature checks out, the key is one this laptop
// pinned, and it names the file this laptop last beamed.

const DECISION_STYLE = {
  approve: 'bg-emerald-900 text-emerald-200',
  hold: 'bg-amber-900 text-amber-200',
  reject: 'bg-red-900 text-red-200',
  received: 'bg-zinc-800 text-zinc-200',
} as const;

const Check = ({ ok, children, testId }: { ok: boolean; children: React.ReactNode; testId?: string }) => (
  <li className={ok ? 'text-green-400' : 'text-red-400'} data-testid={testId} data-ok={ok}>
    {ok ? '✓' : '✗'} {children}
  </li>
);

export function AckPanel({ ack }: { ack: SignedAck }) {
  const [check, setCheck] = useState<AckCheck | null>(null);
  const [trusted, setTrusted] = useState<string[]>(trustedKeys);
  const sent = lastBeam();
  const b = ack.body;

  useEffect(() => {
    void verifyAck(ack).then(setCheck);
  }, [ack]);

  if (!check) return null;
  const known = trusted.includes(check.fingerprint);
  const matches = sent?.sha256 === b.file_sha256;
  const ok = check.signatureOk && known && matches;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3 text-sm" data-testid="ack">
      <div className="flex items-center justify-between">
        <span className="font-medium">Plant acknowledgement</span>
        <span className="text-[10px] text-zinc-500">{new Date(b.issued_at).toLocaleString()}</span>
      </div>
      <div className={`rounded-lg px-3 py-2 font-medium ${ok ? DECISION_STYLE[b.decision] : 'bg-red-950 text-red-300'}`} data-testid="ack-status">
        {ok ? `Plant says ${b.decision.toUpperCase()}` : 'Ack not trusted'}
        <div className="text-[11px] font-normal opacity-80">{b.decided_by}</div>
      </div>
      <ul className="space-y-0.5 text-xs">
        <Check ok={check.signatureOk} testId="ack-sig">ECDSA P-256 signature</Check>
        <Check ok={known} testId="ack-known">
          Plant key <span className="font-mono">{check.fingerprint || '?'}</span> {known ? 'pinned' : 'not pinned yet'}
        </Check>
        <Check ok={matches} testId="ack-match">
          {matches ? `Names the file beamed: ${sent!.name}` : sent ? `Names ${b.file_name}, but ${sent.name} was beamed last` : 'Nothing beamed from this browser to match'}
        </Check>
      </ul>
      {check.signatureOk && !known && (
        <button
          className="rounded-lg bg-zinc-800 px-3 py-2 text-xs hover:bg-zinc-700"
          onClick={() => {
            trustKey(check.fingerprint);
            setTrusted((t) => [...t, check.fingerprint]);
          }}
          data-testid="ack-trust"
        >
          The plant screen shows {check.fingerprint}: pin this key
        </button>
      )}
      {b.findings.length > 0 && (
        <ul className="font-mono text-[11px] text-red-300">
          {b.findings.map((f) => (
            <li key={f.path + f.code}>
              ✗ {f.code} at {f.path}
            </li>
          ))}
        </ul>
      )}
      <div className="text-xs text-zinc-500">
        {b.work_order_id && <>{b.work_order_id} · </>}
        {formatBytes(b.file_bytes)} received in {b.telemetry.seconds.toFixed(1)} s · {b.telemetry.droplets} droplets for K={b.telemetry.k} ·{' '}
        {b.telemetry.crcValid}/{b.telemetry.frames} frames CRC-valid
      </div>
    </div>
  );
}
