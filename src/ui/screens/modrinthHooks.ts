/** View hooks over the store's Modrinth state (M5). */
import { useMemo } from 'react';

import type { FixVersions } from '../components/labels';
import { fixVersions } from '../app/modrinthState';
import { useApp } from '../app/StoreContext';

/** Version facts for the fix buttons of an instance's findings (`Update Sodium to 0.5.11`). */
export function useFixVersions(instanceId: string): FixVersions {
  const m = useApp((s) => s.modrinth[instanceId]);
  const ctx = m?.ctx ?? null;
  const resolutions = m?.resolutions;
  const depRange = m?.depRange;
  return useMemo(() => fixVersions(ctx, resolutions ?? {}, depRange), [ctx, resolutions, depRange]);
}
