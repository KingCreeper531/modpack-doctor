/**
 * CRASHES view of the findings panel (M4; DESIGN.md §5, §6.2, §6.3, §10).
 *
 * Left: the instance's crash reports and logs, newest first, as ruled 32px two-line rows
 * (relative path in mono; kind, modified time and size beneath; a pip for the worst finding once
 * analysed). The selected source gets the rail's 2px `signal` rule on `raised`.
 * Right: the selected source as a diagnosis (crash findings as triage rows marked
 * `from <file>`, expanding to the log evidence with jar chips) or as the whole log digest
 * (virtualised log viewer, culprit lines highlighted).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { LogSource } from '../../bindings';
import type { Finding, Severity } from '../../core/model';
import { Button } from '../components/Button';
import { cx } from '../components/cx';
import { ErrorRow, isUnavailable } from '../components/ErrorRow';
import { formatAgo, formatBytes, formatInt, logPath, plural } from '../components/format';
import { LogViewer } from '../components/LogViewer';
import { onRovingKeyDown } from '../components/roving';
import { Pip, type PipTone } from '../components/Severity';
import { TriageRow } from '../components/TriageRow';
import { digestView, LOG_KIND_LABEL, sourceDir, sourceName, type CrashAnalysis, type CrashPane } from '../app/crashState';
import { useActions, useApp, useAppShallow } from '../app/StoreContext';
import { findingMenuFor } from '../app/rowMenus';
import { useFindingCursor, useNow, useRowMenu } from './hooks';
import { useFixBlock } from './fixHooks';
import { useFixVersions } from './modrinthHooks';

const TONE: Record<Severity, PipTone> = { error: 'error', warning: 'warning', info: 'info' };

function worst(findings: readonly Finding[]): Severity | null {
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  return findings.length ? 'info' : null;
}

function SourceRow({ source, selected, analysis, now, onSelect }: { source: LogSource; selected: boolean; analysis: CrashAnalysis | undefined; now: number; onSelect: () => void }) {
  const sev = analysis?.status === 'done' ? worst(analysis.findings) : null;
  const when = new Date(source.modifiedMs);
  return (
    <li>
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={onSelect}
        title={logPath(source.id)}
        className={cx(
          'flex h-8 w-full flex-col justify-center border-b border-l-2 border-b-line pr-2 pl-[14px] text-left',
          selected ? 'border-l-signal bg-raised' : 'border-l-transparent hover:bg-raised',
          'focus-visible:bg-raised focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-signal',
        )}
      >
        <span className="flex min-w-0 t-mono">
          <span className="min-w-0 shrink-[999] truncate text-fg-faint">{sourceDir(source.id)}</span>
          <span className="min-w-0 truncate text-fg">{sourceName(source.id)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2 t-small text-fg-faint">
          <span className="shrink-0 t-label">{LOG_KIND_LABEL[source.kind]}</span>
          <span className="shrink-0 t-mono" title={when.toLocaleString()}>
            {formatAgo(now - source.modifiedMs)}
          </span>
          <span className="ml-auto shrink-0 t-mono">{formatBytes(source.size)}</span>
          {sev ? <Pip tone={TONE[sev]} label={`worst finding: ${sev}`} /> : <span className="size-1 shrink-0" aria-hidden />}
        </span>
      </button>
    </li>
  );
}

const PANES: ReadonlyArray<[CrashPane, string]> = [
  ['diagnosis', 'Diagnosis'],
  ['log', 'Log'],
];
const PANE_IDS = PANES.map(([id]) => id);

/** Diagnosis / Log: a radio group (one tab stop; arrows, Home and End move and select). */
function PaneSwitch({ pane, onPane }: { pane: CrashPane; onPane: (p: CrashPane) => void }) {
  return (
    <div role="radiogroup" aria-label="Show" className="flex h-6 items-stretch gap-4" onKeyDown={(e) => onRovingKeyDown(e, PANE_IDS, pane, onPane)}>
      {PANES.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={pane === id}
          tabIndex={pane === id ? 0 : -1}
          data-roving={id}
          onClick={() => onPane(id)}
          className={cx(
            'relative flex items-center t-small focus-visible:outline-1 focus-visible:-outline-offset-1',
            pane === id ? 'text-fg' : 'text-fg-faint hover:text-fg-dim',
          )}
        >
          {label}
          {pane === id ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-signal" /> : null}
        </button>
      ))}
    </div>
  );
}

function CrashFindings({ instanceId, source, analysis }: { instanceId: string; source: LogSource; analysis: CrashAnalysis }) {
  const result = useApp((s) => s.scans[instanceId]?.result ?? null);
  const selection = useApp((s) => s.selection);
  const fixErrors = useApp((s) => s.fixErrors);
  const fixErrorFrom = useApp((s) => s.fixErrorFrom);
  const fixPending = useApp((s) => s.fixPending);
  const orderOpen = useApp((s) => s.order !== null);
  const a = useActions();
  const jarNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const j of result?.jars ?? []) names[j.id] = j.fileName;
    return names;
  }, [result]);
  const versions = useFixVersions(instanceId);
  const blocked = useFixBlock(instanceId);
  const findings = analysis.findings;
  // The top error opens by itself the first time this source's findings appear.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || !findings.length) return;
    setOpened(true);
    const top = findings.find((f) => f.severity === 'error') ?? findings[0];
    if (top) setExpanded(new Set([top.id]));
  }, [findings, opened]);
  const name = sourceName(source.id);
  const listRef = useRef<HTMLDivElement>(null);
  const rowMenu = useRowMenu();
  /** Click or Enter on the keyboard cursor: expand/collapse and show it in the inspector. */
  const open = (id: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    a.select({ kind: 'crash', id, sourceId: source.id });
  };
  const ids = useMemo(() => findings.map((f) => f.id), [findings]);
  const cursor = useFindingCursor(listRef, ids, open);

  if (!findings.length) {
    return (
      <div className="flex flex-wrap items-center gap-4 px-4 py-1" role="status">
        <p className="t-small text-fg-faint">
          Nothing in {name} matches a known crash pattern ({plural(analysis.digest?.totalLines ?? 0, 'line')} read).
        </p>
        <Button size={24} onClick={() => a.setCrashPane(instanceId, 'log')}>
          Show log
        </Button>
      </div>
    );
  }
  return (
    <div ref={listRef} role="list" aria-label={`Crash findings, ${formatInt(findings.length)}`}>
      {findings.map((f) => (
        <div role="listitem" key={f.id} data-finding-id={f.id}>
          <TriageRow
            finding={f}
            origin={name}
            expanded={expanded.has(f.id)}
            onToggle={() => {
              a.setCursor(f.id);
              open(f.id);
            }}
            focused={cursor === f.id}
            onContextMenu={(e) => rowMenu(e, `Crash finding ${f.code}`, (st) => findingMenuFor(st, f.id, source.id))}
            selected={selection?.kind === 'crash' && selection.id === f.id && selection.sourceId === source.id}
            jarNames={jarNames}
            fixVersions={versions}
            selectedJarId={selection?.kind === 'jar' ? selection.id : null}
            onJarClick={a.revealJar}
            onFix={(fix) => void a.fix(f.id, fix, 'triage')}
            fixesDisabled={orderOpen || !!fixPending[f.id] || blocked !== null}
            fixHint={blocked}
            fixError={fixErrorFrom[f.id] === 'triage' ? (fixErrors[f.id] ?? null) : null}
          />
        </div>
      ))}
    </div>
  );
}

function DigestLog({ instanceId, analysis, scrollToLine, scrollRequest }: { instanceId: string; analysis: CrashAnalysis; scrollToLine: number | null; scrollRequest: number }) {
  const result = useApp((s) => s.scans[instanceId]?.result ?? null);
  const a = useActions();
  const view = useMemo(() => (analysis.digest ? digestView(analysis.digest, analysis.findings) : null), [analysis]);
  const label = useMemo(() => {
    const names = new Map((result?.jars ?? []).map((j) => [j.id, j.fileName]));
    return (id: string) => names.get(id) ?? id;
  }, [result]);
  if (!analysis.digest || !view) return null;
  return (
    <>
      {analysis.digest.truncated ? (
        <p className="flex h-6 shrink-0 items-center border-b border-line px-4 t-small text-fg-faint">
          Long file: showing the start, the end and the lines around every crash marker ({formatInt(view.lines.length)} of{' '}
          {formatInt(analysis.digest.totalLines)} lines).
        </p>
      ) : null}
      <LogViewer
        lines={view.lines}
        frames={view.frames}
        totalLines={analysis.digest.totalLines}
        jarLabel={label}
        onJarClick={a.revealJar}
        scrollToLine={scrollToLine}
        scrollRequest={scrollRequest}
        label={`Log ${logPath(analysis.digest.source.id)}`}
        className="min-h-0 flex-1 border-0"
      />
    </>
  );
}

function SourcePane({ instanceId, source }: { instanceId: string; source: LogSource }) {
  const analysis = useApp((s) => s.crashes[instanceId]?.analyses[source.id]);
  const pane = useApp((s) => s.crashes[instanceId]?.pane ?? 'diagnosis');
  const logLine = useApp((s) => s.crashes[instanceId]?.logLine ?? null);
  const logRequest = useApp((s) => s.crashes[instanceId]?.logRequest ?? 0);
  const a = useActions();
  const lines = analysis?.digest?.totalLines;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-4 border-b border-line px-4">
        <PaneSwitch pane={pane} onPane={(p) => a.setCrashPane(instanceId, p)} />
        <span className="ml-auto min-w-0 truncate t-mono text-fg-faint">
          {lines !== undefined ? plural(lines, 'line') : ''}
          {analysis?.status === 'done' && !analysis.mapped ? ' · jars mapped after the scan' : ''}
        </span>
      </div>
      {!analysis || analysis.status === 'loading' ? (
        <p className="flex h-8 shrink-0 items-center px-4 t-small text-fg-faint" role="status">
          Reading {sourceName(source.id)}…
        </p>
      ) : analysis.status === 'error' && analysis.error ? (
        <ErrorRow
          error={analysis.error}
          action={
            isUnavailable(analysis.error) ? undefined : (
              <Button size={24} onClick={() => void a.analyzeLogSource(instanceId, source.id, true)}>
                Retry
              </Button>
            )
          }
        />
      ) : pane === 'log' ? (
        <DigestLog instanceId={instanceId} analysis={analysis} scrollToLine={logLine} scrollRequest={logRequest} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CrashFindings key={source.id} instanceId={instanceId} source={source} analysis={analysis} />
        </div>
      )}
    </div>
  );
}

export function CrashesView({ instanceId }: { instanceId: string }) {
  const c = useAppShallow((s) => {
    const cr = s.crashes[instanceId];
    return {
      status: cr?.sourcesStatus ?? 'idle',
      sources: cr?.sources,
      error: cr?.sourcesError ?? null,
      selected: cr?.selectedSourceId ?? null,
      analyses: cr?.analyses,
    };
  });
  const mrpack = useApp((s) => s.discovery?.instances.find((i) => i.id === instanceId)?.launcher === 'mrpack');
  const a = useActions();
  const now = useNow(30_000);
  const sources = c.sources ?? [];
  const source = sources.find((s) => s.id === c.selected) ?? null;

  if (c.error) {
    return (
      <ErrorRow
        error={c.error}
        action={
          isUnavailable(c.error) ? undefined : (
            <Button size={24} onClick={() => void a.loadLogSources(instanceId)}>
              Retry
            </Button>
          )
        }
      />
    );
  }
  if (!sources.length) {
    return (
      <p className="flex min-h-8 items-center px-4 py-1 t-small text-fg-faint" role="status">
        {mrpack
          ? 'A .mrpack file is a pack to install, not a game folder, so it has no crash reports or logs. Open the instance a launcher installed from it to read its crashes.'
          : c.status === 'done'
          ? 'No crash reports or logs yet. Modpack Doctor looks in crash-reports/, logs/latest.log, logs/debug.log and hs_err_pid*.log in the game folder.'
          : 'Looking for crash reports and logs…'}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <ul aria-label="Crash reports and logs" className="w-[280px] shrink-0 overflow-y-auto border-r border-line">
        {sources.map((s) => (
          <SourceRow
            key={s.id}
            source={s}
            selected={s.id === c.selected}
            analysis={c.analyses?.[s.id]}
            now={now}
            onSelect={() => a.selectLogSource(instanceId, s.id)}
          />
        ))}
      </ul>
      {source ? (
        <SourcePane instanceId={instanceId} source={source} />
      ) : (
        <p className="px-4 py-2 t-small text-fg-faint">Select a crash report or log to analyse it.</p>
      )}
    </div>
  );
}
