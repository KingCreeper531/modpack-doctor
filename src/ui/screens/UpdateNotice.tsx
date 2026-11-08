/**
 * The rail footer's version slot, beside the About entry (CONTRACTS invariant 18).
 *
 * - Normally the running version (`t-mono`, `fg-faint`).
 * - When a check (the opt-in startup check, or a click in About) found a newer release, a quiet
 *   one-line notice in its place: "Update 0.2.0 available" in `signal` (as the Modrinth column's
 *   `update 0.5.11`, DESIGN §6.6), the version in mono. It opens About, where the notes and the
 *   Install button are; the notice itself never downloads or installs anything. No toast, no
 *   modal, no motion; announced politely to screen readers.
 * - A failed or up-to-date check changes nothing here.
 */
import { cx } from '../components/cx';
import { useActions, useApp } from '../app/StoreContext';
import { APP_VERSION } from './AboutDialog';

export function UpdateNotice({ className }: { className?: string }) {
  const version = useApp((s) => (s.update.status === 'available' ? s.update.info.version : null));
  const install = useApp((s) => (s.update.status === 'available' ? s.update.install : 'idle'));
  const a = useActions();
  const label =
    install === 'restarting' ? 'Restarting…' : install === 'installing' ? `Installing ${version ?? ''}…` : `Update ${version ?? ''} available`;
  return (
    <span aria-live="polite" className={cx('flex min-w-0 justify-end', className)}>
      {version ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={label}
          onClick={() => a.setAboutOpen(true)}
          title={`Modpack Doctor ${APP_VERSION} is running. Open About to read the release notes and install ${version}.`}
          className="flex h-6 min-w-0 items-center gap-1 px-1 t-small text-signal hover:underline"
        >
          {install === 'restarting' ? (
            'Restarting…'
          ) : (
            <>
              <span className="shrink-0">{install === 'installing' ? 'Installing' : 'Update'}</span>
              <span className="truncate t-mono">{version}</span>
              {install === 'installing' ? <span className="shrink-0">…</span> : <span className="shrink-0">available</span>}
            </>
          )}
        </button>
      ) : (
        <span className="t-mono text-fg-faint" title="Modpack Doctor version">
          {APP_VERSION}
        </span>
      )}
    </span>
  );
}
