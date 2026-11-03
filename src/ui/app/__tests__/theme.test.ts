import { describe, expect, it, vi } from 'vitest';

import { followTheme, resolveTheme } from '../theme';

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeMedia(initialDark: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches: initialDark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    flip(dark: boolean) {
      this.matches = dark;
      for (const fn of listeners) fn();
    },
    count: () => listeners.size,
  };
}

describe('theme', () => {
  it('resolves explicit and system preferences', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('follows OS theme changes at runtime and re-themes the title bar each time', async () => {
    const media = fakeMedia(true);
    const apply = vi.fn();
    const setWindowTheme = vi.fn().mockResolvedValue(null);
    const stop = followTheme('system', { media: media as never, apply, setWindowTheme });

    expect(apply).toHaveBeenLastCalledWith('dark');
    await tick();
    expect(setWindowTheme).toHaveBeenLastCalledWith('dark');

    media.flip(false);
    expect(apply).toHaveBeenLastCalledWith('light');
    await tick();
    expect(setWindowTheme).toHaveBeenLastCalledWith('light');
    await tick();
    expect(setWindowTheme).toHaveBeenCalledTimes(2);

    stop();
    expect(media.count()).toBe(0);
  });

  it('does not listen to the OS for an explicit preference', async () => {
    const media = fakeMedia(false);
    const setWindowTheme = vi.fn().mockResolvedValue(null);
    followTheme('dark', { media: media as never, apply: vi.fn(), setWindowTheme });
    media.flip(true);
    await tick();
    expect(setWindowTheme).toHaveBeenCalledTimes(1);
    expect(media.count()).toBe(0);
  });
});
