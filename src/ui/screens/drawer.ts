/** Whether the inspector is currently a drawer (narrow window); the shell provides it. */
import { createContext, useContext } from 'react';

export const DrawerContext = createContext(false);

export function useInspectorIsDrawer(): boolean {
  return useContext(DrawerContext);
}
