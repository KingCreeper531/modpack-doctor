/** React access to the app store (store.ts): one provider at the root, selector hooks below. */
import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { AppState, AppStore } from './store';

const Ctx = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useAppStore(): AppStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('useApp must be used inside <StoreProvider>');
  return s;
}

/** Select one value; the component re-renders only when it changes (Object.is). */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(useAppStore(), selector);
}

/** Select several values at once, compared shallowly. */
export function useAppShallow<T extends object>(selector: (s: AppState) => T): T {
  return useStore(useAppStore(), useShallow(selector));
}

/** Store actions are stable for the store's lifetime. */
export function useActions(): AppState {
  return useAppStore().getState();
}
