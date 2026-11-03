/**
 * About (DESIGN.md §6.8): a panel overlay laid out like a data plate. Under the `ABOUT` legend,
 * a two-column table (version, build commit, Tauri version, data dir, cache dir, licence) and the
 * non-affiliation disclaimer. No third-party logos.
 */
import { X } from '@phosphor-icons/react';

import { cx } from './cx';
import { Panel } from './Panel';

export const DISCLAIMER =
  'Modpack Doctor is not affiliated with or endorsed by Modrinth, Mojang, Microsoft, Forge, NeoForge, Fabric, or Quilt.';

export interface AboutInfo {
  version: string;
  commit: string;
  tauri: string;
  dataDir: string;
  cacheDir: string;
  licence: string;
}

export interface AboutPlateProps {
  info: AboutInfo;
  onClose?: () => void;
  className?: string;
}

export function AboutPlate({ info, onClose, className }: AboutPlateProps) {
  const rows: Array<[string, string]> = [
    ['Version', info.version],
    ['Build commit', info.commit],
    ['Tauri', info.tauri],
    ['Data directory', info.dataDir],
    ['Cache directory', info.cacheDir],
    ['Licence', info.licence],
  ];
  return (
    <Panel
      legend="About"
      role="dialog"
      aria-label="About Modpack Doctor"
      flush
      className={cx('w-[560px] max-w-full rounded-2 shadow-overlay', className)}
      meta={
        onClose ? (
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 flex size-6 items-center justify-center text-fg-faint hover:text-fg">
            <X size={16} />
          </button>
        ) : undefined
      }
    >
      <div className="flex h-12 items-center border-b border-line px-4">
        <span className="t-title text-fg">Modpack Doctor</span>
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="h-6 border-b border-line">
              <th scope="row" className="w-[160px] px-4 text-left align-middle t-label font-medium text-fg-faint">
                {k}
              </th>
              <td className="max-w-0 truncate pr-4 align-middle t-mono text-fg" title={v}>
                {v}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="max-w-[72ch] px-4 py-4 t-small text-fg-dim">{DISCLAIMER}</p>
    </Panel>
  );
}
