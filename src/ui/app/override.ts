/**
 * Pack-identity override form validation. An override is applied only when every field it sets
 * is something the checks can use: a Minecraft version `src/core/version` recognises, and (with
 * a loader picked) a non-empty loader version without spaces.
 */
import type { LoaderKind, PackOverride, Side } from '../../bindings';
import { normalizeMinecraft } from '../../core/version';

export interface OverrideFields {
  mc: string;
  kind: LoaderKind | '';
  version: string;
  side: Side | '';
}

export interface OverrideCheck {
  /** The override to store (`null` = no override), or null with `errors` when invalid. */
  override: PackOverride | null;
  errors: { mc?: string; version?: string };
  valid: boolean;
}

export const MC_HINT = "Not a Minecraft version this app recognises. Use a release such as 1.20.1 or 26.1, or a snapshot such as 24w14a.";
export const VERSION_EMPTY_HINT = 'Enter the loader version, for example 47.3.0.';
export const VERSION_SPACE_HINT = 'A loader version has no spaces.';

export function checkOverride(f: OverrideFields): OverrideCheck {
  const mc = f.mc.trim();
  const version = f.version.trim();
  const errors: OverrideCheck['errors'] = {};
  if (mc && normalizeMinecraft(mc) === null) errors.mc = MC_HINT;
  if (f.kind) {
    if (!version) errors.version = VERSION_EMPTY_HINT;
    else if (/\s/.test(version)) errors.version = VERSION_SPACE_HINT;
  }
  const valid = !errors.mc && !errors.version;
  const o: PackOverride = { mcVersion: mc || null, loader: f.kind ? { kind: f.kind, version: version || null } : null, side: f.side || null };
  return { override: valid && (o.mcVersion || o.loader || o.side) ? o : null, errors, valid };
}
