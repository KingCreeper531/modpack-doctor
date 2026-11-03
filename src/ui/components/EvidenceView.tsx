/** Renders one `Evidence` item (DESIGN.md §6.2 expanded row, §6.3). */
import { useState, type ReactNode } from 'react';

import type { Evidence } from '../../core/model';
import { basename, formatInt } from './format';
import { clipExcerpt, excerptLines } from './logModel';
import { LogViewer } from './LogViewer';

export interface EvidenceViewProps {
  evidence: Evidence;
  jarLabel?: (jarId: string) => string;
  onJarClick?: (jarId: string) => void;
  maxHeight?: number;
  /**
   * Show at most this many metadata excerpt lines (around the first highlight) until the
   * reader asks for all of them. Omit to show the whole excerpt.
   */
  clipLines?: number;
}

function Source({ kind, children, action }: { kind: string; children: string; action?: ReactNode }) {
  return (
    <div className="flex h-6 items-center gap-2 t-mono">
      <span className="t-label text-fg-faint">{kind}</span>
      <span className="min-w-0 truncate text-fg-dim" title={children}>
        {children}
      </span>
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  );
}

function MetadataEvidence({
  evidence,
  jarLabel,
  maxHeight,
  clipLines,
}: {
  evidence: Extract<Evidence, { kind: 'metadata' }>;
  jarLabel?: ((jarId: string) => string) | undefined;
  maxHeight: number;
  clipLines?: number | undefined;
}) {
  const [all, setAll] = useState(false);
  const name = jarLabel ? jarLabel(evidence.jarId) : basename(evidence.jarId);
  const lines = excerptLines(evidence.excerpt, evidence.highlight);
  const clip = clipLines !== undefined && !all ? clipExcerpt(lines, clipLines) : { lines, clipped: false };
  const canToggle = clipLines !== undefined && lines.length > clipLines;
  return (
    <div>
      <Source
        kind="metadata"
        action={
          canToggle ? (
            <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)} className="t-small text-fg-dim underline hover:text-fg">
              {all ? 'Show fewer' : `Show all ${formatInt(lines.length)} lines`}
            </button>
          ) : null
        }
      >{`${name} › ${evidence.file}`}</Source>
      <LogViewer
        lines={clip.lines}
        {...(clip.clipped ? { totalLines: lines.length } : {})}
        maxHeight={maxHeight}
        label={`${evidence.file} in ${name}`}
      />
    </div>
  );
}

export function EvidenceView({ evidence, jarLabel, onJarClick, maxHeight = 288, clipLines }: EvidenceViewProps) {
  const opt = { ...(jarLabel ? { jarLabel } : {}), ...(onJarClick ? { onJarClick } : {}) };
  switch (evidence.kind) {
    case 'log':
      return (
        <div>
          <Source kind="log">{evidence.source}</Source>
          <LogViewer lines={evidence.lines} frames={evidence.frames} maxHeight={maxHeight} label={`Excerpt of ${evidence.source}`} {...opt} />
        </div>
      );
    case 'metadata':
      return <MetadataEvidence evidence={evidence} jarLabel={jarLabel} maxHeight={maxHeight} clipLines={clipLines} />;
    case 'note':
      return (
        <div className="flex min-h-6 items-baseline gap-2 t-mono">
          <span className="t-label text-fg-faint">note</span>
          <span className="text-fg-dim">{evidence.text}</span>
        </div>
      );
  }
}
