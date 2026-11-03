/**
 * Shell geometry (DESIGN.md §5). The rail is 240px; the workspace needs room for the mod table's
 * fixed columns plus a 160px name. When the window is too narrow for the preferred inspector
 * width, the inspector first shrinks toward its 280px minimum; below that it becomes a drawer
 * that overlays the workspace from the right (the window's minimum width is 960px).
 */
import { INSPECTOR_MIN } from '../components/resize';

export const RAIL_WIDTH = 240;
/** Mod table: rail 4 + icon 24 + name 160 + version 120 + loader 80 + Modrinth 112 + status 96 + on 48. */
export const MIN_WORKSPACE = 648;
/** Gap kept to the left of an open drawer so the workspace edge stays visible. */
const DRAWER_GUTTER = 48;

export interface InspectorLayout {
  mode: 'docked' | 'drawer';
  width: number;
}

export function inspectorLayout(viewport: number, preferred: number): InspectorLayout {
  const room = viewport - RAIL_WIDTH - MIN_WORKSPACE;
  if (room >= INSPECTOR_MIN) return { mode: 'docked', width: Math.min(preferred, room) };
  const max = Math.max(INSPECTOR_MIN, viewport - RAIL_WIDTH - DRAWER_GUTTER);
  return { mode: 'drawer', width: Math.min(preferred, max) };
}
