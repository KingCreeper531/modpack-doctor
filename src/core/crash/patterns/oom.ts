/**
 * C-OOM: JVM out-of-memory (crash-formats.md §3.8), cross-checked with the crash report's
 * `Memory:` / `JVM Flags:` lines or the hs_err `Command Line:` to tailor the -Xmx advice.
 */
import type { CrashPattern, Finding, Severity } from '../../model';
import { ctxOf, finding, gate, logEvidence, manual, worst, type Ctx } from '../context';
import { logLevel } from '../text';
import { contextual, fatal } from '../tiers';

type OomKind = 'heap' | 'gc' | 'metaspace' | 'class-space' | 'direct' | 'array' | 'threads' | 'native';

const JAVA_OOM = /java\.lang\.OutOfMemoryError: (Java heap space|GC overhead limit exceeded|Metaspace|Compressed class space|Direct buffer memory|Requested array size exceeds VM limit|unable to create (?:new )?native thread.*)/;
const NATIVE_OOM = /There is insufficient memory for the Java Runtime Environment|Native memory allocation \((?:malloc|mmap)\) failed|Out of Memory Error \(/;

/**
 * Only a thrown OutOfMemoryError counts: a stack-trace line that *starts* with it (optionally
 * after `Exception in thread "…"`, `Caused by:`, `Caused by N:` or `Exception message:`), or a
 * log record that reports it. The same words inside a crash-report details value (a mod's config
 * dump) or JVM flags (`-XX:+HeapDumpOnOutOfMemoryError`) do not.
 */
const THROWN_OOM = /^\s*(?:Exception in thread "[^"]*" |Caused by(?: \d+)?: |Exception message: )?java\.lang\.OutOfMemoryError:/;

function kindOf(text: string): OomKind | null {
  if (text.startsWith('#')) return NATIVE_OOM.test(text) ? 'native' : null;
  if (!THROWN_OOM.test(text) && logLevel(text) === null) return null;
  const m = JAVA_OOM.exec(text);
  if (m) {
    const what = m[1] ?? '';
    if (what === 'Java heap space') return 'heap';
    if (what === 'GC overhead limit exceeded') return 'gc';
    if (what === 'Metaspace') return 'metaspace';
    if (what === 'Compressed class space') return 'class-space';
    if (what === 'Direct buffer memory') return 'direct';
    if (what.startsWith('Requested array size')) return 'array';
    return 'threads';
  }
  return null;
}

/** Max heap in MiB from `-Xmx`, the crash report `Memory: … up to N bytes`, or null. */
export function maxHeapMiB(ctx: Ctx): number | null {
  for (const { text } of ctx.lines) {
    const xmx = /-Xmx(\d+)([kKmMgG]?)\b/.exec(text);
    if (xmx && /JVM Flags:|Command Line:|jvm_args:|java(?:w)?(?:\.exe)?\b/.test(text)) {
      const n = Number(xmx[1]);
      const unit = (xmx[2] ?? '').toLowerCase();
      return unit === 'g' ? n * 1024 : unit === 'k' ? Math.round(n / 1024) : unit === 'm' ? n : Math.round(n / (1024 * 1024));
    }
    const mem = /^\tMemory: .* up to (\d+) bytes/.exec(text);
    if (mem) return Math.round(Number(mem[1]) / (1024 * 1024));
  }
  return null;
}

function advice(kind: OomKind, heap: number | null): { title: string; explanation: string; steps: string[] } {
  const heapText = heap !== null ? `${(heap / 1024).toFixed(heap % 1024 === 0 ? 0 : 1)} GB` : 'unknown';
  const raise = 'In your launcher, raise the instance memory (maximum / -Xmx), e.g. 6–8 GB for a large pack. Leave at least 2–3 GB for the system.';
  switch (kind) {
    case 'heap':
    case 'gc':
    case 'array':
      if (heap !== null && heap >= 12 * 1024) {
        return {
          title: `Java ran out of heap memory with ${heapText} allocated`,
          explanation: `The game used up its ${heapText} heap. With that much memory, a mod is probably leaking memory (or a world/structure is pathological); more RAM will only delay it.`,
          steps: [
            'Lower -Xmx to 8–10 GB; very large heaps make garbage collection slower, not safer.',
            'Disable recently added mods to find a leak, or remove mods that cache whole worlds (minimaps, chunk pregenerators) to test.',
          ],
        };
      }
      return {
        title: `Java ran out of heap memory${heap !== null ? ` (${heapText} allocated)` : ''}`,
        explanation: `The game needed more heap than allowed (-Xmx ${heapText}). Modpacks with hundreds of mods usually need 6–8 GB.`,
        steps: [raise, 'Close other memory-heavy programs while playing.'],
      };
    case 'metaspace':
    case 'class-space':
      return {
        title: 'Java ran out of Metaspace (class memory)',
        explanation: 'Class metadata filled Metaspace. This happens in huge packs or when a JVM argument caps it.',
        steps: [
          'Remove any -XX:MaxMetaspaceSize or -XX:CompressedClassSpaceSize argument from the instance JVM arguments.',
          'If none is set, the pack loads too many classes for its memory: raise -Xmx or remove some mods.',
        ],
      };
    case 'direct':
      return {
        title: 'Java ran out of direct (off-heap) buffer memory',
        explanation: 'Native buffers (used for rendering and networking) are full.',
        steps: ['Remove a low -XX:MaxDirectMemorySize argument, or raise -Xmx (direct memory defaults to the heap size).'],
      };
    case 'threads':
      return {
        title: 'Java could not create another thread',
        explanation: 'The operating system refused to start a new thread: either memory is exhausted or a mod creates threads without limit.',
        steps: ['Lower -Xmx so the OS has memory left, close other programs, and check for mods that spawn many worker threads.'],
      };
    case 'native':
      return {
        title: 'The system could not give Java enough memory',
        explanation: `The JVM itself could not allocate native memory${heap !== null ? ` (-Xmx ${heapText})` : ''}. The heap is set larger than the free RAM plus page file, or 32-bit Java is in use.`,
        steps: [
          'Lower -Xmx below your free RAM (for 16 GB of RAM, 6–8 GB).',
          'Use 64-bit Java and let Windows manage the page file size.',
          'Close other memory-heavy programs.',
        ],
      };
  }
}

export const oomPattern: CrashPattern = {
  id: 'out-of-memory',
  codes: ['C-OOM'],
  anchors: [
    // hs_err header for a JVM that could not get memory: the process is gone.
    ...fatal('There is insufficient memory for the Java Runtime Environment'),
    // OutOfMemoryError mentions appear in healthy logs (heap-dump flags, caught errors).
    ...contextual('java.lang.OutOfMemoryError', 'Native memory allocation', 'Out of Memory Error', 'JVM Flags: '),
  ],
  match(input) {
    const ctx = ctxOf(input);
    const byKind = new Map<OomKind, { lineIdx: number[]; severity: Severity | null }>();
    ctx.lines.forEach((l, i) => {
      const kind = kindOf(l.text);
      if (!kind) return;
      const severity = gate(ctx, i, { warn: 'warning', fatal: kind === 'native' });
      if (!severity) return;
      const e = byKind.get(kind) ?? { lineIdx: [], severity: null };
      e.lineIdx.push(i);
      e.severity = worst(e.severity, severity);
      byKind.set(kind, e);
    });
    const heap = byKind.size > 0 ? maxHeapMiB(ctx) : null;
    const out: Finding[] = [];
    for (const [kind, e] of byKind) {
      if (!e.severity) continue;
      const a = advice(kind, heap);
      out.push(
        finding(ctx, {
          code: 'C-OOM',
          severity: e.severity,
          title: a.title,
          explanation: a.explanation,
          culprits: [],
          evidence: [logEvidence(ctx, e.lineIdx.slice(0, 5), { context: 1 })],
          fixes: [manual(...a.steps)],
          discriminator: kind,
        }),
      );
    }
    return out;
  },
};
