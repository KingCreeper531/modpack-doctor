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
  /** `none`: production build without the Tauri bridge; every command fails with `NO_BACKEND`. */
  kind: 'tauri' | 'mock' | 'none';
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

/** Shown when a production build runs without the Tauri bridge (e.g. opened in a browser). */
export const NO_BACKEND: AppError = {
  kind: 'internal',
  message: "Modpack Doctor's backend is not running, so nothing can be scanned. Start Modpack Doctor from its installed app, not from a web browser.",
  path: null,
};

/** A backend that answers every command with `NO_BACKEND` and never emits events. */
export function missingBackend(): Backend {
  const fail = async () => ({ status: 'error' as const, error: NO_BACKEND });
  const commandsProxy = new Proxy({}, { get: () => fail }) as AppCommands;
  const silent: EventChannel<never> = { listen: async () => () => undefined };
  return {
    kind: 'none',
    commands: commandsProxy,
    events: { scanStarted: silent, scanProgress: silent, instanceAdded: silent, dropRejected: silent, crashDetected: silent, opStatus: silent },
  };
}

/**
 * Real Tauri when the bridge exists. Otherwise, in dev builds only, the browser mock configured
 * from the URL (`?scenario=`); production builds get `missingBackend()` and never show mock
 * data. `import.meta.env.DEV` is a compile-time constant, so the mock modules are dropped from
 * production bundles. `allowMock: false` lets tests exercise the production path.
 */
export function createBackend(
  w: (object & { location?: { search: string } }) | undefined = typeof window === 'undefined' ? undefined : window,
  allowMock = true,
): Backend {
  if (isTauri(w)) return tauriBackend();
  if (import.meta.env.DEV && allowMock) return createMockBackend(mockOptionsFromSearch(w?.location?.search ?? ''));
  return missingBackend();
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
