/**
 * Native crash notifications (watch mode, M4).
 *
 * Permission is asked for respectfully: never at startup, only when the first error-severity
 * crash needs to be announced, and at most once per app run. When it is not granted the store
 * shows an in-app banner instead (store.ts `crashBanner`).
 */
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

export type NotifyResult = 'sent' | 'denied';

export interface Notifier {
  notify(title: string, body: string): Promise<NotifyResult>;
}

/** The permission calls the notifier needs; injectable for tests. */
export interface PermissionApi {
  isGranted(): Promise<boolean>;
  request(): Promise<string>;
  send(title: string, body: string): void;
}

/** Asks once per run; a refusal (or a failing permission call) sticks until restart. */
export function notifierFrom(api: PermissionApi): Notifier {
  let state: 'unknown' | 'granted' | 'denied' = 'unknown';
  let asking: Promise<void> | null = null;
  const ask = async () => {
    try {
      if (await api.isGranted()) state = 'granted';
      else state = (await api.request()) === 'granted' ? 'granted' : 'denied';
    } catch {
      state = 'denied';
    }
  };
  return {
    async notify(title, body) {
      if (state === 'unknown') {
        asking ??= ask();
        await asking;
      }
      if (state !== 'granted') return 'denied';
      try {
        api.send(title, body);
        return 'sent';
      } catch {
        return 'denied';
      }
    },
  };
}

/**
 * Inside Tauri: the notification plugin (capabilities `notification:allow-notify`,
 * `allow-is-permission-granted`, `allow-request-permission`).
 */
export function tauriNotifier(): Notifier {
  return notifierFrom({
    isGranted: isPermissionGranted,
    request: requestPermission,
    send: (title, body) => sendNotification({ title, body }),
  });
}

interface WebNotification {
  permission: string;
  requestPermission(): Promise<string>;
  new (title: string, options?: { body?: string }): unknown;
}

/**
 * Browser preview: the Web Notification API when the page has it. A request that never
 * settles (headless browsers) counts as denied after `timeoutMs`.
 */
export function browserNotifier(timeoutMs = 1500): Notifier {
  const N = (globalThis as { Notification?: WebNotification }).Notification;
  if (!N) return deniedNotifier();
  return notifierFrom({
    isGranted: async () => N.permission === 'granted',
    request: () =>
      Promise.race([N.requestPermission(), new Promise<string>((r) => setTimeout(() => r('denied'), timeoutMs))]),
    send: (title, body) => {
      new N(title, { body });
    },
  });
}

/** No notifications at all (no backend, tests): every crash goes to the in-app banner. */
export function deniedNotifier(): Notifier {
  return { notify: async () => 'denied' };
}
