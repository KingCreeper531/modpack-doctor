/**
 * About (DESIGN.md §6.8): a panel overlay laid out like a data plate. Under the `ABOUT` legend,
 * the app name and a one-line description, a two-column table (version, build commit, Tauri
 * version, data dir, cache dir, licence, source link; rows the build cannot report are left
 * out), the update section, and the non-affiliation disclaimer. No third-party logos.
 *
 * `UpdateSection` is presentational: it renders an `UpdateView` (app/updateState.ts) and calls
 * back. Release notes are rendered as a plain text node (pre-wrapped), never as HTML or Markdown.
 */
import { ArrowSquareOut, X } from '@phosphor-icons/react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';

import type { AppError, UpdateInfo } from '../../bindings';
import { Button } from './Button';
import { cx } from './cx';
import { ErrorRow } from './ErrorRow';
import { Panel } from './Panel';

export const DISCLAIMER =
  'Modpack Doctor is not affiliated with or endorsed by Modrinth, Mojang, Microsoft, Forge, NeoForge, Fabric, or Quilt.';
export const DATA_SOURCE = 'Mod data from the Modrinth API.';
export const DESCRIPTION = 'Finds why a Minecraft modpack crashes, names the jars responsible, and applies reversible fixes.';
export const REPO_URL = 'https://github.com/KingCreeper531/modpack-doctor';

export interface AboutInfo {
  version: string;
  /** Unknown values (null) are left out of the plate rather than guessed. */
  commit: string | null;
  tauri: string | null;
  dataDir: string | null;
  cacheDir: string | null;
  licence: string;
}

/** What the update section shows (a projection of the store's `UpdateState`). */
export type UpdateView =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; version: string }
  | { status: 'available'; info: UpdateInfo; install: 'idle' | 'installing' | 'restarting'; error: AppError | null }
  | { status: 'error'; error: AppError };

export interface AboutPlateProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  info: AboutInfo;
  onClose?: () => void;
  /** Opens the repository page (opener plugin under Tauri); without it the link is plain text. */
  onOpenLink?: (url: string) => void;
  /** The update section (`UpdateSection`), placed between the plate table and the disclaimer. */
  updates?: ReactNode;
  /** Id for the app-name heading, so a dialog can be labelled by it. */
  titleId?: string;
  ref?: Ref<HTMLElement>;
}

export function AboutPlate({ info, onClose, onOpenLink, updates, titleId, className, ref, ...rest }: AboutPlateProps) {
  const rows: Array<[string, string | null]> = [
    ['Version', info.version],
    ['Build commit', info.commit],
    ['Tauri', info.tauri],
    ['Data directory', info.dataDir],
    ['Cache directory', info.cacheDir],
    ['Licence', info.licence],
  ];
  const repo = REPO_URL.replace(/^https:\/\//, '');
  return (
    <Panel
      ref={ref}
      legend="About"
      flush
      className={cx('w-[560px] max-w-full rounded-2 shadow-overlay', className)}
      end={
        onClose ? (
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 flex size-6 items-center justify-center text-fg-faint hover:text-fg">
            <X size={16} />
          </button>
        ) : undefined
      }
      {...rest}
    >
      <div className="flex flex-col justify-center gap-1 border-b border-line px-4 py-2">
        <span id={titleId} className="t-title text-fg">
          Modpack Doctor
        </span>
        <span className="t-small text-fg-dim">{DESCRIPTION}</span>
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map(([k, v]) =>
            v === null ? null : (
              <tr key={k} className="h-6 border-b border-line">
                <th scope="row" className="w-[160px] px-4 text-left align-middle t-label font-medium text-fg-faint">
                  {k}
                </th>
                <td className="max-w-0 truncate pr-4 align-middle t-mono text-fg" title={v}>
                  {v}
                </td>
              </tr>
            ),
          )}
          <tr className="h-6 border-b border-line">
            <th scope="row" className="w-[160px] px-4 text-left align-middle t-label font-medium text-fg-faint">
              Source
            </th>
            <td className="max-w-0 pr-4 align-middle t-mono text-fg">
              {onOpenLink ? (
                <button type="button" onClick={() => onOpenLink(REPO_URL)} title={REPO_URL} className="flex max-w-full items-center gap-1 text-left hover:underline">
                  <span className="truncate">{repo}</span>
                  <ArrowSquareOut size={12} aria-hidden className="shrink-0 text-fg-faint" />
                </button>
              ) : (
                <span className="block truncate" title={REPO_URL}>
                  {repo}
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {updates}
      <p className="max-w-[72ch] px-4 py-4 t-small text-fg-dim">
        {DISCLAIMER} {DATA_SOURCE}
      </p>
    </Panel>
  );
}

/** `2026-11-20T09:00:00Z` → `2026-11-20`; anything else is shown as given. */
export function releaseDate(date: string | null): string | null {
  if (!date) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date.trim());
  return m ? m[1]! : date.trim();
}

export interface UpdateSectionProps {
  view: UpdateView;
  onCheck: () => void;
  /** Install exactly this version (the one on screen). */
  onInstall: (version: string) => void;
  className?: string;
}

/**
 * UPDATES: a ruled sub-panel. Nothing here runs by itself: the check runs on "Check for updates",
 * and the install only on "Install <version> and restart" for the version shown.
 */
export function UpdateSection({ view, onCheck, onInstall, className }: UpdateSectionProps) {
  const checking = view.status === 'checking';
  const busy = view.status === 'available' && view.install !== 'idle';
  return (
    <section aria-label="Updates" className={cx('border-b border-line', className)}>
      <header className="flex h-8 items-center gap-4 border-b border-line px-4">
        <h3 className="t-label text-fg-faint">Updates</h3>
        <span className="ml-auto truncate t-mono text-fg-faint">GitHub Releases · only when you ask</span>
      </header>
      <div aria-live="polite">
        {view.status === 'available' ? (
          <>
            <table className="w-full border-collapse">
              <tbody>
                <tr className="h-6 border-b border-line">
                  <th scope="row" className="w-[160px] px-4 text-left align-middle t-label font-medium text-fg-faint">
                    Available
                  </th>
                  <td className="pr-4 align-middle t-mono text-signal">{view.info.version}</td>
                </tr>
                {releaseDate(view.info.date) ? (
                  <tr className="h-6 border-b border-line">
                    <th scope="row" className="w-[160px] px-4 text-left align-middle t-label font-medium text-fg-faint">
                      Published
                    </th>
                    <td className="pr-4 align-middle t-mono text-fg">{releaseDate(view.info.date)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <div className="border-b border-line px-4 py-2">
              <h4 className="t-label text-fg-faint">Release notes</h4>
              {view.info.notes?.trim() ? (
                // A text node only: the notes come from the release and are never parsed as HTML.
                <div data-testid="update-notes" className="mt-1 max-h-[160px] overflow-y-auto t-small whitespace-pre-wrap break-words text-fg-dim">
                  {view.info.notes}
                </div>
              ) : (
                <p className="mt-1 t-small text-fg-faint">This release has no notes.</p>
              )}
            </div>
            {view.error ? <ErrorRow error={view.error} /> : null}
            <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
              <Button variant="primary" disabled={busy} onClick={() => onInstall(view.info.version)}>
                {view.install === 'installing'
                  ? `Installing ${view.info.version}…`
                  : view.install === 'restarting'
                    ? 'Restarting…'
                    : `Install ${view.info.version} and restart`}
              </Button>
              <span className="min-w-0 flex-1 t-small text-fg-dim">
                {view.install === 'restarting'
                  ? 'Installed. Modpack Doctor restarts now.'
                  : 'Downloads from github.com, checks the signature, then restarts the app.'}
              </span>
            </div>
          </>
        ) : (
          <>
            {view.status === 'error' ? <ErrorRow error={view.error} /> : null}
            <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
              <Button disabled={checking} onClick={onCheck}>
                {checking ? 'Checking…' : view.status === 'idle' ? 'Check for updates' : 'Check again'}
              </Button>
              <span role={checking ? 'status' : undefined} className={cx('min-w-0 flex-1 t-small', view.status === 'current' ? 'text-ok' : 'text-fg-dim')}>
                {checking
                  ? 'Asking github.com for the latest release…'
                  : view.status === 'current'
                    ? `${view.version} is the latest release.`
                    : view.status === 'error'
                      ? 'Nothing was downloaded.'
                      : 'Contacts github.com only when you click.'}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
