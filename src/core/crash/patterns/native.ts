/**
 * C-NATIVE: hs_err native crash (crash-formats.md §4). `# Problematic frame:` followed by
 * `# C  [atio6axx.dll+0x1b3e4f]` names the library; the frame letter says whether it is native
 * code (C), the JVM (V) or Java code (J/j).
 */
import type { CrashPattern, Finding } from '../../model';
import { ctxOf, finding, gate, logEvidence, manual, refs } from '../context';
import { jarsForPackage, topLevel, jarLabel } from '../jars';
import { packageOf } from '../text';

const PROBLEMATIC = /^#\s*Problematic frame:/;
const NATIVE_FRAME = /^#\s+([CVJjv])\s+(?:\[([^+\]\s]+)(?:\+0x[0-9a-fA-F]+)?\]|(?:\d+\s+)?(?:c[12]\s+|jvmci\s+)?([\w$.]+)\.[\w$<>]+)/;
const SIGNAL = /^#\s+(EXCEPTION_[A-Z_]+|SIG[A-Z]+)\s+\((0x[0-9a-fA-F]+)\)/;

type LibKind = 'amd' | 'nvidia' | 'intel' | 'mesa' | 'apple' | 'lwjgl' | 'overlay' | 'jvm' | 'java' | 'other';

function classify(lib: string, letter: string): { kind: LibKind; what: string } {
  const l = lib.toLowerCase();
  if (letter === 'V' || /^(?:jvm\.dll|libjvm\.(?:so|dylib))$/.test(l)) return { kind: 'jvm', what: 'the Java virtual machine itself' };
  if (letter === 'J' || letter === 'j') return { kind: 'java', what: 'JIT-compiled Java code' };
  if (/^(?:atio6axx|atioglxx|atiumd\w*|amdxc64|amdvlk\w*)\.dll$/.test(l)) return { kind: 'amd', what: 'the AMD graphics driver' };
  if (/^(?:nvoglv(?:32|64)|nvd3dum\w*|nvwgf2um\w*)\.dll$|^libnvidia-glcore|^libglx_nvidia/.test(l)) return { kind: 'nvidia', what: 'the NVIDIA graphics driver' };
  if (/^ig\w*icd(?:32|64)\.dll$|^igxelp\w*\.dll$/.test(l)) return { kind: 'intel', what: 'the Intel graphics driver' };
  if (/^libgl\.so|_dri\.so$|^libgallium|^libvulkan_/.test(l)) return { kind: 'mesa', what: 'the Linux OpenGL driver (Mesa)' };
  if (/^libgl\.dylib$|glengine|appleintel|^amdmtl/.test(l)) return { kind: 'apple', what: 'the macOS graphics driver' };
  if (/^(?:lib)?lwjgl\w*\.(?:dll|so|dylib)$|^(?:lib)?glfw\w*\.(?:dll|so|dylib)$/.test(l)) return { kind: 'lwjgl', what: 'LWJGL/GLFW (the game\'s native graphics glue)' };
  if (/^(?:rtsshooks64|discordhook64|obs-vulkan64|gameoverlayrenderer64|graphics-hook\w*|nvspcap64|mangohud\w*)\.(?:dll|so)$/.test(l)) {
    return { kind: 'overlay', what: 'an overlay or capture hook' };
  }
  return { kind: 'other', what: `the native library ${lib}` };
}

function steps(kind: LibKind, lib: string): string[] {
  switch (kind) {
    case 'amd':
    case 'nvidia':
    case 'intel':
    case 'mesa':
    case 'apple':
      return [
        'Update the graphics driver from the GPU vendor (not Windows Update); if the crash started after an update, roll back one version.',
        'Remove shader packs and rendering mods (Sodium/Embeddium/Iris/OptiFine) one at a time to see which triggers the driver bug.',
        'On laptops, make Java use the dedicated GPU.',
      ];
    case 'lwjgl':
      return ['Update the graphics driver.', 'Make sure the launcher uses its bundled LWJGL natives and no mod replaces them.'];
    case 'overlay':
      return [`Close or disable the program that injects ${lib} (overlays, FPS counters, recorders), then try again.`];
    case 'jvm':
      return [
        'Install a current build of the required Java version (e.g. latest Eclipse Temurin).',
        'Remove unusual JVM arguments (experimental GC flags, -XX:+UnlockExperimentalVMOptions …).',
      ];
    case 'java':
      return ['Update Java to the latest patch release of its version; JIT crashes are JVM bugs triggered by specific code.'];
    case 'other':
      return [`Find which program or mod ships ${lib}; update or remove it.`, 'Update the graphics driver if the library is graphics-related.'];
  }
}

export const nativePattern: CrashPattern = {
  id: 'native-crash',
  codes: ['C-NATIVE'],
  anchors: [
    'A fatal error has been detected by the Java Runtime Environment',
    '# Problematic frame:',
    'EXCEPTION_ACCESS_VIOLATION',
    'SIGSEGV',
  ],
  match(input) {
    const ctx = ctxOf(input);
    const out: Finding[] = [];
    for (let i = 0; i < ctx.lines.length; i++) {
      if (!PROBLEMATIC.test(ctx.lines[i]?.text ?? '')) continue;
      const frameLine = ctx.lines[i + 1];
      const m = frameLine ? NATIVE_FRAME.exec(frameLine.text) : null;
      if (!m) continue;
      const severity = gate(ctx, i, { fatal: true });
      if (!severity) continue;
      const letter = m[1] ?? 'C';
      const lib = m[2] ?? m[3] ?? 'unknown';
      const { kind, what } = classify(lib, letter);
      const signalIdx = ctx.lines.findIndex((l) => SIGNAL.test(l.text));
      const signal = signalIdx >= 0 ? SIGNAL.exec(ctx.lines[signalIdx]?.text ?? '')?.[1] : undefined;
      // A Java frame in a mod package can be attributed; native libraries are not jars.
      const jar = kind === 'java' && ctx.index && m[3] ? jarsForPackage(packageOf(m[3]), ctx.index, true)[0] : undefined;
      const top = jar && ctx.index ? topLevel(jar, ctx.index) : undefined;
      const culprits = refs(ctx, [top]);
      const label = kind === 'java' ? (top ? `${jarLabel(top)} (${m[3] ?? ''})` : (m[3] ?? 'Java code')) : lib;
      out.push(
        finding(ctx, {
          code: 'C-NATIVE',
          severity,
          title: kind === 'java' ? `Java crashed natively while running ${label}` : `Native crash in ${lib} (${what})`,
          explanation: `The Java runtime crashed outside normal Java error handling${signal ? ` (${signal})` : ''}. The problematic frame is in ${what}${kind === 'java' ? `: ${label}` : ` (${lib})`}. ${
            kind === 'jvm' || kind === 'java'
              ? 'This is usually a JVM bug or a bad JVM argument.'
              : 'Mods cannot cause this directly, but rendering mods and shaders often trigger driver bugs.'
          }`,
          culprits,
          evidence: [logEvidence(ctx, [i, i + 1, ...(signalIdx >= 0 ? [signalIdx] : [])], { context: 1 })],
          fixes: [manual(...steps(kind, lib))],
          discriminator: `${letter}:${lib.toLowerCase()}`,
        }),
      );
    }
    return out;
  },
};
