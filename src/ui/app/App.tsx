import { useEffect } from 'react';

import { commands } from '../../bindings';
import { followTheme } from './theme';

/** M1 placeholder shell. Real screens arrive in M3 after the /design sheet is approved. */
export function App() {
  // Settings are wired in M3; until then follow the OS theme.
  useEffect(
    () =>
      followTheme('system', {
        media: window.matchMedia('(prefers-color-scheme: dark)'),
        apply: (theme) => document.documentElement.setAttribute('data-theme', theme),
        setWindowTheme: commands.setWindowTheme,
      }),
    [],
  );

  return (
    <main className="h-screen bg-bg text-fg">
      <header className="flex h-8 items-center border-b border-line px-4">
        <span className="t-label text-fg-faint">Modpack Doctor</span>
        <span className="ml-auto t-mono text-fg-faint">scaffold · M1</span>
      </header>
    </main>
  );
}
