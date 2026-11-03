/**
 * In-app crash notice (M4), shown only when the native notification could not be sent
 * (permission refused). An inline ruled row with the `err` rail like an error row (DESIGN.md
 * §10), never a toast: `CRASH`, the headline, the instance, Show and Dismiss.
 */
import { Button } from '../components/Button';
import { useActions, useApp } from '../app/StoreContext';

export function CrashBanner() {
  const alert = useApp((s) => s.crashBanner);
  const name = useApp((s) => (alert ? (s.discovery?.instances.find((i) => i.id === alert.instanceId)?.name ?? null) : null));
  const a = useActions();
  if (!alert) return null;
  return (
    <div role="alert" aria-label="Modpack crashed" className="flex min-h-8 shrink-0 items-stretch border-b border-line bg-panel">
      <span aria-hidden className="w-1 shrink-0 bg-err" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 py-1 pr-2 pl-4">
        <span className="w-24 shrink-0 t-mono text-err-text">crash</span>
        <span className="min-w-0 flex-1 t-body text-fg">{alert.summary.headline}</span>
        {name ? <span className="min-w-0 truncate t-mono text-fg-dim">{name}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 pr-2">
        <Button size={24} variant="primary" onClick={() => a.openCrashAlert(alert)}>
          Show crash
        </Button>
        <Button size={24} onClick={a.dismissCrashBanner}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
