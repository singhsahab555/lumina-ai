import { useEffect, useState } from 'react';
import { TransmitView } from './components/TransmitView.tsx';
import { ReceiveView } from './components/ReceiveView.tsx';
import { FlowBar } from './components/FlowBar.tsx';

type Mode = 'tx' | 'rx';

const modeFromHash = (): Mode => (location.hash === '#rx' ? 'rx' : 'tx');

export function App() {
  const [mode, setMode] = useState<Mode>(modeFromHash);

  useEffect(() => {
    const onHash = () => setMode(modeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const tab = (m: Mode, label: string) => (
    <a
      href={m === 'rx' ? '#rx' : '#tx'}
      className={`rounded-lg px-3 py-1.5 text-sm ${mode === m ? 'bg-yellow-400 font-medium text-black' : 'text-zinc-300 hover:bg-zinc-800'}`}
      data-testid={`tab-${m}`}
    >
      {label}
    </a>
  );

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Lumina<span className="text-yellow-400">AI</span>
          </h1>
          <p className="text-xs text-zinc-500">Work orders into air-gapped plants through light. No network, no USB.</p>
        </div>
        <nav className="flex gap-1 rounded-xl bg-zinc-900 p-1">
          {tab('tx', 'Transmit')}
          {tab('rx', 'Receive')}
        </nav>
      </header>
      <FlowBar tab={mode} />
      <main>{mode === 'tx' ? <TransmitView /> : <ReceiveView />}</main>
    </div>
  );
}
