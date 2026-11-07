/**
 * `homeScrubber` beyond the plain path (CONTRACTS invariant 16, M7 review): Windows 8.3 short
 * names, UTF-8 percent-encoding, UNC admin shares, NFC/NFD — always whole folder names only.
 */
import { describe, expect, it } from 'vitest';

import { homeScrubber } from '../text';

const NFC = 'J\u00fcrgen';
const NFD = 'Ju\u0308rgen';

describe('homeScrubber: Windows 8.3 short names', () => {
  it.each<[string, string, string]>([
    ['C:\\Users\\Bob Smith', 'C:\\Users\\BOBSMI~1\\AppData', '~\\AppData'],
    ['C:\\Users\\Bob Smith', 'c:\\users\\bobsmi~12\\x', '~\\x'],
    ['C:\\Users\\Bob', 'C:\\Users\\BOB~1\\x', '~\\x'],
    ['C:\\Users\\Alexander', 'C:/Users/ALEXAN~1/x', '~/x'],
    [`C:\\Users\\${NFC}`, 'C:\\Users\\JRGEN~1\\x', '~\\x'],
    [`C:\\Users\\${NFC}`, 'C:\\Users\\JURGEN~2\\x', '~\\x'],
    [`C:\\Users\\${NFC}`, 'C:\\Users\\J_RGEN~1\\x', '~\\x'],
    // Any folder of the home path, not only the last.
    ['C:\\Documents and Settings\\Bob', 'C:\\DOCUME~1\\Bob\\x and C:\\DOCUME~1\\BOB~1\\y', '~\\x and ~\\y'],
    // Whole names only: another user's short name is not ours.
    ['C:\\Users\\Bob', 'C:\\Users\\BOBBY~1\\x', 'C:\\Users\\BOBBY~1\\x'],
    ['C:\\Users\\Bob', 'C:\\Users\\BOB~1x\\y', 'C:\\Users\\BOB~1x\\y'],
    ['C:\\Users\\Bob', 'C:\\Users\\BOB1\\x', 'C:\\Users\\BOB1\\x'],
  ])('home %j: %j → %j', (home, text, expected) => {
    expect(homeScrubber(home)(text)).toBe(expected);
  });
});

describe('homeScrubber: percent-encoded UTF-8', () => {
  it.each<[string, string, string]>([
    [`C:\\Users\\${NFC}`, 'file:///C:/Users/J%C3%BCrgen/x', 'file:///~/x'],
    [`C:\\Users\\${NFC}`, 'file:///c:/users/j%c3%bcrgen/x', 'file:///~/x'],
    [`C:\\Users\\${NFC}`, 'file:///C:/Users/Ju%CC%88rgen/x', 'file:///~/x'],
    [`C:\\Users\\${NFC}`, 'file:///C:/USERS/J%C3%9CRGEN/x', 'file:///~/x'],
    [`C:\\Users\\${NFC}`, 'C%3A%5CUsers%5CJ%C3%BCrgen%5Cx', '~%5Cx'],
    ['C:\\Users\\Bob', 'https://x.example/?p=C%3A%2FUsers%2FBob%2Fmods', 'https://x.example/?p=~%2Fmods'],
    [`/home/${NFC}`, 'file:///home/J%C3%BCrgen/.minecraft', 'file:~/.minecraft'],
    ['C:\\Users\\Bob Smith', 'C:/Users/Bob%20Smith/x', '~/x'],
    // Whole names only, encoded or not.
    ['C:\\Users\\Bob', 'C%3A%5CUsers%5CBobby%5Cx', 'C%3A%5CUsers%5CBobby%5Cx'],
    ['C:\\Users\\Bob', 'C:/Users/Bob%C3%A9/x', 'C:/Users/Bob%C3%A9/x'],
    ['C:\\Users\\Bob', 'C:/Users/Bob%41/x', 'C:/Users/Bob%41/x'],
    ['C:\\Users\\Bob', 'C:/Users/Bob%5F2/x', 'C:/Users/Bob%5F2/x'],
    ['C:\\Users\\Bob', 'C:/Users/Bob%2Fx', '~%2Fx'],
  ])('home %j: %j → %j', (home, text, expected) => {
    expect(homeScrubber(home)(text)).toBe(expected);
  });
});

describe('homeScrubber: UNC admin shares', () => {
  it.each<[string, string, string]>([
    ['C:\\Users\\Bob', '\\\\DESKTOP-1\\C$\\Users\\Bob\\mods', '~\\mods'],
    ['C:\\Users\\Bob', 'at \\\\pc\\c$\\users\\bob.', 'at ~.'],
    ['C:\\Users\\Bob', '\\\\?\\UNC\\pc\\C$\\Users\\Bob\\x', '~\\x'],
    ['C:\\Users\\Bob', 'file://pc/C$/Users/Bob/x', 'file:~/x'],
    ['C:\\Users\\Bob', '\\\\pc\\C%24\\Users\\Bob\\x', '~\\x'],
    ['C:\\Users\\Bob Smith', '\\\\pc\\C$\\Users\\BOBSMI~1\\x', '~\\x'],
    // Another drive, another user: not ours.
    ['C:\\Users\\Bob', '\\\\pc\\D$\\Users\\Bob\\x', '\\\\pc\\D$\\Users\\Bob\\x'],
    ['C:\\Users\\Bob', '\\\\pc\\C$\\Users\\Bobby\\x', '\\\\pc\\C$\\Users\\Bobby\\x'],
    // A plain share is not the admin share.
    ['C:\\Users\\Bob', '\\\\pc\\share\\Users\\Bob\\x', '\\\\pc\\share\\Users\\Bob\\x'],
  ])('home %j: %j → %j', (home, text, expected) => {
    expect(homeScrubber(home)(text)).toBe(expected);
  });
});

describe('homeScrubber: Unicode normalisation', () => {
  it('matches NFD text against an NFC home and NFC text against an NFD home', () => {
    expect(homeScrubber(`/Users/${NFC}`)(`/Users/${NFD}/Library`)).toBe('~/Library');
    expect(homeScrubber(`/Users/${NFD}`)(`/Users/${NFC}/Library`)).toBe('~/Library');
    expect(homeScrubber(`C:\\Users\\${NFC}`)(`C:\\USERS\\J\u00dcRGEN\\x`)).toBe('~\\x');
  });

  it('returns NFC and keeps the whole-name rule', () => {
    expect(homeScrubber(`/Users/${NFC}`)(`/Users/${NFD}x/a`)).toBe(`/Users/${NFC}x/a`);
    expect(homeScrubber('/Users/Bob')(`/Users/Bob\u00e9/a`)).toBe('/Users/Bob\u00e9/a');
    expect(homeScrubber('/Users/Bob')('/Users/Bobby/a and /Users/Bob/a')).toBe('/Users/Bobby/a and ~/a');
  });
});
