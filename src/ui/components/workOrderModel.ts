/** Work-order row text, outcome line and keyboard rule (DESIGN.md §6.4). Pure. */
import type { AppError, FileOp, OpStatus, WorkOrder } from '../../bindings';
import { formatBytes, hostOf, opNumber, plural } from './format';

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

/** The result line of a finished order. */
export interface OrderOutcome {
  ok: boolean;
  text: string;
}

/**
 * What a finished order did, in one sentence: every op done, or the first failed op with its
 * message and whether the completed ops were rolled back.
 */
export function orderOutcome(order: Pick<WorkOrder, 'ops'>, statuses: readonly OpStatus[], rolledBack: boolean): OrderOutcome {
  const failed = [...statuses].sort((a, b) => a.index - b.index).find((s) => s.state === 'failed');
  if (!failed) {
    if (!order.ops.length) return { ok: true, text: 'Done: this work order had notes only; no file was changed.' };
    return { ok: true, text: `Done: ${plural(order.ops.length, 'operation')} completed. Each action can be undone from History.` };
  }
  const head = `Operation ${opNumber(failed.index)} failed: ${failed.message ?? 'no reason was given.'}`;
  const done = statuses.some((s) => s.state === 'done');
  const tail = rolledBack
    ? 'Rolled back: every completed operation was reversed, so the files are as they were.'
    : done
      ? 'The operations before it completed and were not rolled back; see each row.'
      : 'Nothing was changed.';
  return { ok: false, text: `${head}${/[.!?]$/.test(head) ? '' : '.'} ${tail}` };
}

/** An execute refusal as the panel says it (a running game reads as an instruction). */
export function refusalText(error: AppError): AppError {
  return error.kind === 'gameRunning' ? { ...error, message: `Close Minecraft first: ${error.message}` } : error;
}
