/** Renders one `Evidence` item (DESIGN.md §6.2 expanded row, §6.3). */
import type { Evidence } from '../../core/model';
import { basename } from './format';
import { excerptLines } from './logModel';
import { LogViewer } from './LogViewer';

export interface EvidenceViewProps {
  evidence: Evidence;
  jarLabel?: (jarId: string) => string;
  onJarClick?: (jarId: string) => void;
  maxHeight?: number;
}

function Source({ kind, children }: { kind: string; children: string }) {
  return (
    <div className="flex h-6 items-center gap-2 t-mono">
      <span className="t-label text-fg-faint">{kind}</span>
      <span className="truncate text-fg-dim" title={children}>
        {children}
      </span>
    </div>
  );
}

export function EvidenceView({ evidence, jarLabel, onJarClick, maxHeight = 288 }: EvidenceViewProps) {
  const opt = { ...(jarLabel ? { jarLabel } : {}), ...(onJarClick ? { onJarClick } : {}) };
  switch (evidence.kind) {
    case 'log':
      return (
        <div>
          <Source kind="log">{evidence.source}</Source>
          <LogViewer lines={evidence.lines} frames={evidence.frames} maxHeight={maxHeight} label={`Excerpt of ${evidence.source}`} {...opt} />
        </div>
      );
    case 'metadata': {
      const name = jarLabel ? jarLabel(evidence.jarId) : basename(evidence.jarId);
      return (
        <div>
          <Source kind="metadata">{`${name} › ${evidence.file}`}</Source>
          <LogViewer lines={excerptLines(evidence.excerpt, evidence.highlight)} maxHeight={maxHeight} label={`${evidence.file} in ${name}`} />
        </div>
      );
    }
    case 'note':
      return (
        <div className="flex min-h-6 items-baseline gap-2 t-mono">
          <span className="t-label text-fg-faint">note</span>
          <span className="text-fg-dim">{evidence.text}</span>
        </div>
      );
  }
}
