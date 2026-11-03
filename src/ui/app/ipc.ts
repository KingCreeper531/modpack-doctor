/**
 * The single place the UI touches `commands` / `events` from the generated bindings.
 *
 * Inside Tauri (`'__TAURI_INTERNALS__' in window`) calls go to Rust. In a plain browser (vite dev
 * server, screenshots, tests) a mock backend with the same typed surface stands in, so every
 * screen can be reviewed without a Rust build. Everything else in the UI receives a `Backend`.
 */
import {
  commands,
  events,
  type AppError,
  type CrashDetected,
  type DropRejected,
  type InstanceAdded,
  type OpStatus,
  type ScanProgress,
  type ScanStarted,
} from '../../bindings';
import { createMockBackend, mockOptionsFromSearch } from './mockIpc';

export type Result<T> = { status: 'ok'; data: T } | { status: 'error'; error: AppError };

export type Unlisten = () => void;

/** A typed event stream; the callback receives the payload only. */
export interface EventChannel<T> {
  listen(cb: (payload: T) => void): Promise<Unlisten>;
}

export interface AppEvents {
  scanStarted: EventChannel<ScanStarted>;
  scanProgress: EventChannel<ScanProgress>;
  instanceAdded: EventChannel<InstanceAdded>;
  dropRejected: EventChannel<DropRejected>;
  crashDetected: EventChannel<CrashDetected>;
  opStatus: EventChannel<OpStatus>;
}

/** Exactly the generated command surface. */
export type AppCommands = typeof commands;

export interface Backend {
  kind: 'tauri' | 'mock';
  commands: AppCommands;
  events: AppEvents;
}

export function isTauri(w: object | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  return w !== undefined && '__TAURI_INTERNALS__' in w;
}

interface TauriEvent<T> {
  listen(cb: (e: { payload: T }) => void): Promise<Unlisten>;
}

function channel<T>(ev: TauriEvent<T>): EventChannel<T> {
  return { listen: (cb) => ev.listen((e) => cb(e.payload)) };
}

export function tauriBackend(): Backend {
  return {
    kind: 'tauri',
    commands,
    events: {
      scanStarted: channel(events.scanStarted),
      scanProgress: channel(events.scanProgress),
      instanceAdded: channel(events.instanceAdded),
      dropRejected: channel(events.dropRejected),
      crashDetected: channel(events.crashDetected),
      opStatus: channel(events.opStatus),
    },
  };
}

/** Real Tauri when available, otherwise the mock configured from the URL (`?scenario=`). */
export function createBackend(w: (object & { location?: { search: string } }) | undefined = typeof window === 'undefined' ? undefined : window): Backend {
  if (isTauri(w)) return tauriBackend();
  return createMockBackend(mockOptionsFromSearch(w?.location?.search ?? ''));
}

/**
 * Await a command and never throw. The generated wrapper rethrows `Error` instances (an IPC
 * failure rather than an `AppError`); those become an `internal` AppError so the caller always
 * renders an inline error row.
 */
export async function call<T>(p: Promise<Result<T>> | (() => Promise<Result<T>>)): Promise<Result<T>> {
  try {
    return await (typeof p === 'function' ? p() : p);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { status: 'error', error: { kind: 'internal', message: `The app backend did not answer: ${message}`, path: null } };
  }
}
