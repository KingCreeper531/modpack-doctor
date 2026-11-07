/**
 * Modrinth settings (M5) in the rail footer, beside THEME: DESIGN.md does not place settings, and
 * the rail footer already holds the app-wide ones. Two labelled toggles (§6.5):
 * - Lookups: `Settings.modrinthEnabled`. Off = no network; static checks only.
 * - Betas: `Settings.includeBeta` (update suggestions may be betas; never alpha).
 */
import { cx } from '../components/cx';
import { Toggle } from '../components/Toggle';
import { useActions, useApp } from '../app/StoreContext';

export function ModrinthControl({ className }: { className?: string }) {
  const enabled = useApp((s) => s.settings.modrinthEnabled);
  const beta = useApp((s) => s.settings.includeBeta);
  const a = useActions();
  return (
    <div role="group" aria-labelledby="modrinth-label" className={cx('flex flex-col gap-1', className)}>
      <span id="modrinth-label" className="t-label text-fg-faint">
        Modrinth
      </span>
      <div className="flex h-6 items-center justify-between">
        <span className="t-small text-fg-dim">Look up mods online</span>
        <Toggle on={enabled} label="Modrinth lookups" showState onChange={(on) => void a.setModrinthEnabled(on)} />
      </div>
      <div className="flex h-6 items-center justify-between">
        <span className={cx('t-small', enabled ? 'text-fg-dim' : 'text-fg-faint')}>Suggest beta updates</span>
        <Toggle on={beta} label="Beta update suggestions" showState disabled={!enabled} onChange={(on) => void a.setIncludeBeta(on)} />
      </div>
    </div>
  );
}
