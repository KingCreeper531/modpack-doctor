/** Work-order row text and keyboard rule (DESIGN.md §6.4). Pure. */
import type { FileOp, WorkOrder } from '../../bindings';
import { formatBytes, hostOf } from './format';

export interface OpLine {
  /** Padded to 8 columns in mono so targets line up. */
  verb: string;
  /** Source / subject, before the arrow. */
  subject: string;
  /** Destination after `→`, if any. */
  target: string | null;
  /** Secondary detail in `fg-faint`, e.g. `replaces mods/x.jar`. */
  detail: string | null;
}

export function describeOp(op: FileOp): OpLine {
  switch (op.op) {
    case 'rename':
      return { verb: 'rename', subject: op.from, target: op.to, detail: null };
    case 'moveToBackup':
      return { verb: 'backup', subject: op.path, target: 'backup snapshot', detail: null };
    case 'download':
      return {
        verb: 'download',
        subject: `${op.projectTitle} ${op.versionNumber} (${formatBytes(op.sizeBytes)}) from ${hostOf(op.url)}`,
        target: op.dest,
        detail: op.replaces ? `replaces ${op.replaces}` : null,
      };
    case 'restore':
      return {
        verb: 'restore',
        subject: op.backupPath,
        target: op.to,
        detail: op.expectAbsentOrSha1 ? `expects sha1 ${op.expectAbsentOrSha1.slice(0, 8)}` : 'expects absent',
      };
    case 'removeCreated':
      return { verb: 'remove', subject: op.path, target: 'backup snapshot', detail: `created by fix · sha1 ${op.expectSha1.slice(0, 8)}` };
  }
}

/** Width the verb column is padded to (`download` is the longest verb). */
export const VERB_WIDTH = 8;

/**
 * Enter confirms only an undo consisting of exactly one rename (e.g. undoing a disable).
 * Every other order needs a click, or Tab + Space, on Execute.
 */
export function enterExecutes(order: Pick<WorkOrder, 'kind' | 'ops'>): boolean {
  return order.kind === 'undo' && order.ops.length === 1 && order.ops[0]?.op.op === 'rename';
}
