/**
 * "Paste a log" and "Share on mclo.gs" dialogs (app/logTools.ts), one modal layer like About
 * (DESIGN §6.8): a panel anchored 64px below the window top at the workspace's left edge over a
 * transparent click-away layer, focus kept inside, Esc closes, focus returns where it was.
 *
 * Paste: a textarea; Analyse runs the crash pipeline on the text for the selected instance. The
 * dialog states the limits and that the text stays on this computer.
 *
 * Share: nothing is uploaded until "Upload to mclo.gs" is pressed. The confirmation names the
 * file and says the log becomes public and that the home folder is replaced with `~`. After the
 * upload the link is copied (browser clipboard API) and shown, with Copy and Open (opener scope
 * `https://mclo.gs/*`). Errors are inline rows; offline gets its own sentence.
 */
import { X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { AppError, SharedLog } from '../../bindings';
import { Button } from '../components/Button';
import { ErrorRow } from '../components/ErrorRow';
import { formatBytes, formatInt, logPath, plural } from '../components/format';
import { Panel } from '../components/Panel';
import { suppressesDefault } from '../app/keyboard';
import { copyText, isPastedSource, openMclogs, PASTE_LIMIT_TEXT, sharedNote, shareErrorText, type LogDialog } from '../app/logTools';
import { useActions, useApp } from '../app/StoreContext';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function LogDialogs() {
  const dialog = useApp((s) => s.logDialog);
  if (!dialog || typeof document === 'undefined') return null;
  return createPortal(<Layer key={`${dialog.kind}:${dialog.instanceId}`} dialog={dialog} />, document.body);
}

function Layer({ dialog }: { dialog: LogDialog }) {
  const a = useActions();
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) a.setLogDialog(null);
  };

  useEffect(() => {
    const returnTo = document.activeElement;
    const first = ref.current?.querySelector<HTMLElement>('textarea,[data-autofocus]');
    (first ?? ref.current)?.focus();
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected && returnTo !== document.body) returnTo.focus();
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    // Modal: the window shortcuts never act underneath (typing J/K in the textarea included).
    e.stopPropagation();
    if (suppressesDefault(e)) e.preventDefault();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const list = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !ref.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const legend = dialog.kind === 'paste' ? 'Paste a log' : 'Share on mclo.gs';
  return (
    <>
      {/* Click-away layer: transparent, no blur (DESIGN §11). */}
      <div aria-hidden className="fixed inset-0 z-40" onMouseDown={close} />
      <div className="fixed top-16 left-[256px] z-50 max-h-[calc(100vh-96px)] max-w-[calc(100vw-272px)] overflow-y-auto">
        <Panel
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={legend}
          tabIndex={-1}
          legend={legend}
          flush
          onKeyDown={onKeyDown}
          className="w-[640px] max-w-full rounded-2 shadow-overlay focus-visible:outline-none"
          end={
            <button type="button" onClick={close} disabled={busy} aria-label="Close" className="-mr-2 flex size-6 items-center justify-center text-fg-faint hover:text-fg">
              <X size={16} />
            </button>
          }
        >
          {dialog.kind === 'paste' ? (
            <PasteBody instanceId={dialog.instanceId} onClose={close} />
          ) : (
            <ShareBody instanceId={dialog.instanceId} sourceId={dialog.sourceId} onClose={close} onBusy={setBusy} />
          )}
        </Panel>
      </div>
    </>
  );
}

function Footer({ meta, children }: { meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2 px-4 py-2">
      {meta !== undefined ? <span className="min-w-0 truncate t-mono text-fg-faint">{meta}</span> : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

function PasteBody({ instanceId, onClose }: { instanceId: string; onClose: () => void }) {
  const name = useApp((s) => s.discovery?.instances.find((i) => i.id === instanceId)?.name ?? null);
  const a = useActions();
  const [text, setText] = useState('');
  const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  const bytes = text.length ? new TextEncoder().encode(text).length : 0;
  const analyse = () => {
    if (!text.trim()) return;
    a.analyzePastedText(instanceId, text);
    onClose();
  };
  return (
    <>
      <div className="flex flex-col gap-1 border-b border-line px-4 py-2">
        <p className="t-body text-fg">
          Paste console output, a crash report or any log{name ? ` of ${name}` : ''}. It is analysed with the same crash checks as a log file
          {name ? ', and mapped to this instance’s mods when it has been scanned' : ''}.
        </p>
        <p className="t-small text-fg-dim">The text stays on this computer: it is not uploaded and not saved. {PASTE_LIMIT_TEXT}</p>
      </div>
      <div className="border-b border-line p-4">
        <textarea
          aria-label="Log text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="Error: Could not create the Java Virtual Machine."
          className="block h-[280px] w-full resize-none rounded-1 border border-line-strong bg-raised px-2 py-1 t-log whitespace-pre text-fg placeholder:text-fg-faint"
        />
      </div>
      <Footer meta={lines ? `${plural(lines, 'line')} · ${formatBytes(bytes)}` : 'nothing pasted yet'}>
        <Button size={24} onClick={onClose}>
          Cancel
        </Button>
        <Button size={24} variant="primary" onClick={analyse} disabled={!text.trim()}>
          Analyse
        </Button>
      </Footer>
    </>
  );
}

type SharePhase =
  | { kind: 'confirm' }
  | { kind: 'uploading' }
  | { kind: 'done'; shared: SharedLog; copied: boolean }
  | { kind: 'error'; error: AppError };

function ShareBody({ instanceId, sourceId, onClose, onBusy }: { instanceId: string; sourceId: string; onClose: () => void; onBusy: (b: boolean) => void }) {
  const name = useApp((s) => s.discovery?.instances.find((i) => i.id === instanceId)?.name ?? null);
  const source = useApp((s) => s.crashes[instanceId]?.sources.find((x) => x.id === sourceId) ?? null);
  const backendKind = useApp((s) => s.backendKind);
  const a = useActions();
  const [phase, setPhase] = useState<SharePhase>({ kind: 'confirm' });
  const live = useRef(true);
  useEffect(() => {
    // Set on every mount (StrictMode mounts twice in development).
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  if (isPastedSource(sourceId)) {
    return <p className="px-4 py-2 t-small text-fg-dim">Pasted text is never uploaded. Only log files of an instance can be shared.</p>;
  }

  const upload = async () => {
    setPhase({ kind: 'uploading' });
    onBusy(true);
    const r = await a.shareLog(instanceId, sourceId);
    onBusy(false);
    if (!live.current) return;
    if (r.status === 'error') {
      setPhase({ kind: 'error', error: r.error });
      return;
    }
    const copied = await copyText(r.data.url);
    if (live.current) setPhase({ kind: 'done', shared: r.data, copied });
  };

  const plate = (
    <dl className="flex flex-col border-b border-line">
      {[
        ['Instance', name ?? instanceId],
        ['File', logPath(sourceId)],
        ...(source ? [['Size', formatBytes(source.size)]] : []),
        ['Destination', 'mclo.gs (public link, kept for 90 days)'],
      ].map(([k, v]) => (
        <div key={k} className="flex min-h-6 items-baseline gap-2 border-b border-line px-4 py-1 last:border-b-0">
          <dt className="w-24 shrink-0 t-label text-fg-faint">{k}</dt>
          <dd className="min-w-0 flex-1 t-mono break-all text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );

  if (phase.kind === 'done') {
    const { shared, copied } = phase;
    return (
      <>
        <div className="flex flex-col gap-1 border-b border-line px-4 py-2" role="status">
          <p className="t-body text-fg">{copied ? 'Uploaded. The link is copied to the clipboard.' : 'Uploaded. Copy the link below; the clipboard was not available.'}</p>
          <p className="t-small text-fg-dim">{sharedNote(shared)}</p>
        </div>
        <div className="flex h-8 items-center gap-2 border-b border-line px-4">
          <span className="w-24 shrink-0 t-label text-fg-faint">Link</span>
          <input
            readOnly
            aria-label="mclo.gs link"
            value={shared.url}
            onFocus={(e) => e.currentTarget.select()}
            className="h-6 min-w-0 flex-1 rounded-1 border border-line-strong bg-raised px-2 t-mono text-fg"
          />
        </div>
        <Footer meta={`raw: ${shared.rawUrl.replace(/^https:\/\//, '')}`}>
          <Button
            size={24}
            onClick={() =>
              void copyText(shared.url).then((ok) => {
                if (live.current) setPhase({ kind: 'done', shared, copied: ok });
              })
            }
          >
            Copy link
          </Button>
          <Button size={24} onClick={() => void openMclogs(shared.url, backendKind)}>
            Open in browser
          </Button>
          <Button size={24} variant="primary" onClick={onClose} data-autofocus>
            Close
          </Button>
        </Footer>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1 border-b border-line px-4 py-2">
        <p className="t-body text-fg">This uploads the log file below to mclo.gs. Anyone with the link can read it, so it is public.</p>
        <p className="t-small text-fg-dim">
          Your home folder is replaced with ~ before the upload. Logs longer than {formatInt(25_000)} lines or 10 MB keep their end, where
          crashes are. Nothing is uploaded until you press Upload.
        </p>
      </div>
      {plate}
      {phase.kind === 'error' ? <ErrorRow error={{ ...phase.error, message: shareErrorText(phase.error) }} /> : null}
      <Footer meta={phase.kind === 'uploading' ? 'uploading…' : undefined}>
        <Button size={24} onClick={onClose} disabled={phase.kind === 'uploading'}>
          Cancel
        </Button>
        <Button size={24} variant="primary" onClick={() => void upload()} disabled={phase.kind === 'uploading'}>
          {phase.kind === 'error' ? 'Try again' : 'Upload to mclo.gs'}
        </Button>
      </Footer>
    </>
  );
}
