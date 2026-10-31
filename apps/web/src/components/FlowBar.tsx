// The whole path at a glance, with the model (or the lack of one) at each
// stage. The stages the current tab performs are lit.

type Side = 'connected' | 'light' | 'plant';

const STAGES: { title: string; by: string; side: Side; tabs: ('tx' | 'rx')[] }[] = [
  { title: 'Pack', by: 'Muse Spark', side: 'connected', tabs: ['tx'] },
  { title: 'Red-team', by: 'Muse Glimmer 30B', side: 'connected', tabs: ['tx'] },
  { title: 'Beam over light', by: 'LT fountain · 8-color', side: 'light', tabs: ['tx', 'rx'] },
  { title: 'Policy gate', by: 'offline · no model', side: 'plant', tabs: ['rx'] },
  { title: 'Signed ack back', by: 'ECDSA · SAM 3.1 finds screen', side: 'plant', tabs: ['rx'] },
];

const TONE: Record<Side, string> = {
  connected: 'border-sky-700 text-sky-300',
  light: 'border-yellow-500 text-yellow-300',
  plant: 'border-emerald-700 text-emerald-300',
};

export function FlowBar({ tab }: { tab: 'tx' | 'rx' }) {
  return (
    <ol className="hidden grid-cols-5 gap-1.5 text-xs md:grid" data-testid="flow">
      {STAGES.map((s, i) => (
        <li
          key={s.title}
          className={`relative rounded-lg border bg-zinc-900/60 px-2.5 py-1.5 transition-opacity ${TONE[s.side]} ${s.tabs.includes(tab) ? '' : 'opacity-35'}`}
        >
          <div className="font-medium">
            <span className="mr-1 text-zinc-500">{i + 1}</span>
            {s.title}
          </div>
          <div className="truncate text-[11px] text-zinc-400">{s.by}</div>
        </li>
      ))}
      <li className="col-span-2 text-center text-[10px] uppercase tracking-widest text-sky-400/70">connected sender</li>
      <li className="text-center text-[10px] uppercase tracking-widest text-yellow-400/70">air gap</li>
      <li className="col-span-2 text-center text-[10px] uppercase tracking-widest text-emerald-400/70">air-gapped plant</li>
    </ol>
  );
}
