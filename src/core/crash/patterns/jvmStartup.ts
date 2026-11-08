/**
 * Java could not start the game: failures the JVM prints to its console before Minecraft's
 * logging starts, so they are only in the launcher's capture of the console (Modrinth App
 * `logs/launcher_log.txt`) or in console text the user pastes (launchers.md §7). Wording from
 * OpenJDK (`libjli/emessages.h`, `sun/launcher/resources/launcher.properties`, hotspot
 * `runtime/arguments.cpp`, `memory/universe.cpp`):
 *
 * - `Error: Could not create the Java Virtual Machine.` + `Error: A fatal exception has occurred.
 *   Program will exit.` after the actual reason, one of:
 *   - `Unrecognized VM option 'UseConcMarkSweepGC'` / `Unrecognized option: --add-opens`: a JVM
 *     argument this Java does not accept. Java 9+ options on Java 8 mean the wrong Java
 *     (C-JAVA-VERSION); anything else is a bad or removed argument (C-JVM-START);
 *   - `Invalid maximum heap size: -Xmx4GB` / `Invalid initial heap size: …`, with `The specified
 *     size exceeds the maximum representable size.` on 32-bit Java; `Initial heap size set to a
 *     larger value than the maximum heap size` (C-JVM-START);
 *   - `Error occurred during initialization of VM` + `Could not reserve enough space for 4194304KB
 *     object heap`: the heap could not be reserved, 32-bit Java or too little memory (C-OOM);
 * - `Error: Could not find or load main class X` + `Caused by: java.lang.ClassNotFoundException: X`
 *   (C-JVM-START): a broken install when X is the game's or loader's class, else a stray word in
 *   the JVM arguments that Java took for the class name;
 * - `Error occurred during initialization of boot layer` + `java.lang.module.FindException: …`
 *   (C-JVM-START; a `ResolutionException` there is C-RESOLUTION's).
 *
 * `UnsupportedClassVersionError` / `LinkageError occurred while loading main class` (wrong Java
 * for the game itself) stay with C-JAVA-VERSION.
 */
import type { CrashPattern, Finding } from '../../model';
import { ctxOf, finding, logEvidence, manual, type Ctx } from '../context';
import { minJavaForMinecraft } from '../javaVersions';
import { logLevel } from '../text';
import { fatal } from '../tiers';

const CREATE_VM = 'Error: Could not create the Java Virtual Machine';
const FATAL_EXIT = 'Error: A fatal exception has occurred. Program will exit';
const INIT_VM = 'Error occurred during initialization of VM';
const BOOT_LAYER = 'Error occurred during initialization of boot layer';

const UNRECOGNIZED_VM = /Unrecognized VM option '([^']+)'/;
const UNRECOGNIZED = /Unrecognized option: (\S+)/;
const INVALID_HEAP = /Invalid (maximum|initial) heap size: (\S*)/;
const HEAP_ORDER = /Initial heap size set to a larger value than the maximum heap size/;
const NOT_REPRESENTABLE = /The specified size exceeds the maximum representable size/;
const RESERVE = /Could not reserve enough space for (\d+)KB object heap/;
const MAIN_CLASS = /Error: Could not find or load main class (\S+)/;
const FIND_EXCEPTION = /java\.lang\.module\.FindException: (.+)$/;
const OTHER_BOOT_EXCEPTION = /^\s*(?:Caused by: )?(java\.lang\.(?:LayerInstantiationException|IllegalStateException|module\.InvalidModuleDescriptorException)[^\s:]*)(?::\s?(.*))?$/;

/** Options only Java 9 and newer understand: on Java 8 they mean the wrong Java is selected. */
const JAVA9_OPTION = /^--(?:add-opens|add-exports|add-modules|add-reads|illegal-access|module-path|upgrade-module-path|patch-module|enable-preview|enable-native-access)\b|^-p$/;

/** Options removed from newer Javas (with the release that removed them). */
const REMOVED_OPTIONS: ReadonlyArray<[RegExp, string]> = [
  [/^[+-]?(?:UseConcMarkSweepGC|CMS\w*)/, 'Java 14 removed the CMS garbage collector'],
  [/^[+-]?(?:UseParNewGC)/, 'Java 10 removed ParNew'],
  [/^[+-]?(?:AggressiveOpts)/, 'Java 12 removed -XX:+AggressiveOpts'],
  [/^[+-]?(?:UseSplitVerifier|UseFastAccessorMethods)/, 'Java 8 removed this option'],
];

/** The game's and loaders' own entry points: when one is missing, the install is broken. */
const GAME_CLASS = /^(?:net\.minecraft\.|com\.mojang\.|cpw\.mods\.|net\.minecraftforge\.|net\.neoforged\.|net\.fabricmc\.|org\.quiltmc\.|io\.github\.zekerzhayard\.|org\.prismlauncher\.|org\.multimc\.)/;

/** Where the memory, Java and JVM arguments of an instance are set in each launcher. */
const WHERE =
  'Where to change it: Prism Launcher / MultiMC: Edit instance → Settings → Java; Modrinth App: the instance → ⋯ → Options → Java and memory; CurseForge: Settings → Minecraft → Java settings (or the profile options of the instance); Minecraft Launcher: Installations → Edit → More options.';

/**
 * Severity of a JVM start-up line at `i`: an error unless it is a log4j record below ERROR
 * (the same words quoted in a running game's log are not a failed start), or a crash-report
 * details value.
 */
function startupGate(ctx: Ctx, i: number): boolean {
  if (ctx.details.has(i)) return false;
  const lvl = logLevel(ctx.lines[i]?.text ?? '');
  return lvl === null || lvl === 'ERROR' || lvl === 'FATAL';
}

/** Indices of `Error: Could not create the Java Virtual Machine.` / fatal-exit lines within `reach` after `i`. */
function exitLinesAfter(ctx: Ctx, i: number, reach = 6): number[] {
  const out: number[] = [];
  for (let j = i + 1; j < ctx.lines.length && j <= i + reach; j++) {
    const t = ctx.lines[j]?.text ?? '';
    if (t.includes(CREATE_VM) || t.includes(FATAL_EXIT)) out.push(j);
  }
  return out;
}

function gb(kb: number): string {
  const g = kb / (1024 * 1024);
  return `${g >= 10 || Number.isInteger(g) ? g.toFixed(0) : g.toFixed(1)} GB`;
}

interface Hit {
  key: string;
  lines: number[];
  context: number[];
  build: (ctx: Ctx, lines: number[], context: number[]) => Finding;
}

function evidence(ctx: Ctx, lines: number[], context: number[]) {
  return [logEvidence(ctx, lines, { context: 1, contextIdx: context })];
}

function unrecognized(option: string, raw: string, mcMin: number | null): Omit<Hit, 'lines' | 'context'> {
  if (JAVA9_OPTION.test(option)) {
    const need = mcMin !== null && mcMin > 8 ? mcMin : null;
    const needText = need !== null ? `Java ${need}` : 'Java 17 or newer';
    return {
      key: 'java8',
      build: (ctx, lines, context) =>
        finding(ctx, {
          code: 'C-JAVA-VERSION',
          severity: 'error',
          title: `The game is started with Java 8, but needs ${needText}`,
          explanation: `Java rejected the argument ${raw}, which only Java 9 and newer understand: the instance is started with Java 8. ${
            ctx.mcVersion ? `Minecraft ${ctx.mcVersion}` : 'This Minecraft version'
          } needs ${needText}.`,
          culprits: [],
          evidence: evidence(ctx, lines, context),
          fixes: [manual(`Install ${needText} (64-bit, e.g. Eclipse Temurin) and select it for this instance in your launcher.`, WHERE)],
          discriminator: `java:${need ?? '?'}`,
        }),
    };
  }
  const removed = REMOVED_OPTIONS.find(([re]) => re.test(option.replace(/^-XX:/, '')))?.[1];
  return {
    key: `option:${option}`,
    build: (ctx, lines, context) =>
      finding(ctx, {
        code: 'C-JVM-START',
        severity: 'error',
        title: `Java does not accept the JVM argument ${raw}`,
        explanation: `Java stopped before the game started because of the argument ${raw}${
          removed ? ` (${removed}, so it fails on the Java the instance uses)` : ''
        }. Nothing in the mods folder is involved.`,
        culprits: [],
        evidence: evidence(ctx, lines, context),
        fixes: [
          manual(
            `Remove ${raw} from the instance's JVM arguments (also check for a typo or a missing "-" in the arguments around it).`,
            'If you copied the arguments from a guide for another Java version, start with no extra arguments; the launcher adds what the game needs.',
            WHERE,
          ),
        ],
        discriminator: `option:${option}`,
      }),
  };
}

function invalidHeap(which: string, value: string, bits32: boolean): Omit<Hit, 'lines' | 'context'> {
  const flag = which === 'maximum' ? '-Xmx' : '-Xms';
  return {
    key: `heap:${which}`,
    build: (ctx, lines, context) =>
      finding(ctx, {
        code: 'C-JVM-START',
        severity: 'error',
        title: bits32 ? `32-bit Java cannot use a ${value || flag} heap` : `Java does not accept the memory setting ${value || flag}`,
        explanation: bits32
          ? `The ${which} heap size ${value} is larger than 32-bit Java can address, so Java stopped before the game started. Modpacks need 64-bit Java.`
          : `The ${which} heap size "${value}" is not a size Java understands, so it stopped before the game started. ${flag} takes a whole number directly followed by M or G, e.g. ${flag}6G (not ${flag}6GB, ${flag} 6G or ${flag}6.5G).`,
        culprits: [],
        evidence: evidence(ctx, lines, context),
        fixes: [
          manual(
            ...(bits32
              ? ['Install 64-bit Java (e.g. Eclipse Temurin x64) and select it for this instance.']
              : [`Set the memory with the launcher's memory slider, or write ${flag} as a whole number followed by M or G (e.g. ${flag}6G).`]),
            WHERE,
          ),
        ],
        discriminator: `heap:${which}`,
      }),
  };
}

const HEAP_ORDER_HIT: Omit<Hit, 'lines' | 'context'> = {
  key: 'heap:order',
  build: (ctx, lines, context) =>
    finding(ctx, {
      code: 'C-JVM-START',
      severity: 'error',
      title: 'The minimum memory is set higher than the maximum',
      explanation: 'The initial heap (-Xms, minimum memory) is larger than the maximum heap (-Xmx), so Java stopped before the game started.',
      culprits: [],
      evidence: evidence(ctx, lines, context),
      fixes: [manual('Set the minimum memory (-Xms) to at most the maximum (-Xmx), or remove -Xms from the JVM arguments.', WHERE)],
      discriminator: 'heap:order',
    }),
};

function reserve(kb: number): Omit<Hit, 'lines' | 'context'> {
  const size = gb(kb);
  return {
    key: 'reserve',
    build: (ctx, lines, context) =>
      finding(ctx, {
        code: 'C-OOM',
        severity: 'error',
        title: `Java could not reserve the ${size} of memory set for the game`,
        explanation: `Before the game started, Java could not reserve a ${size} heap. Either 32-bit Java is selected (it cannot use more than about 1.5 GB), or the computer does not have that much memory free.`,
        culprits: [],
        evidence: evidence(ctx, lines, context),
        fixes: [
          manual(
            'Select 64-bit Java for this instance (e.g. Eclipse Temurin x64).',
            `Lower the maximum memory (-Xmx) below the free RAM; ${size} is too much if other programs use most of it. 6–8 GB is enough for most packs.`,
            WHERE,
          ),
        ],
        discriminator: 'reserve',
      }),
  };
}

function mainClass(cls: string): Omit<Hit, 'lines' | 'context'> {
  const game = GAME_CLASS.test(cls) || /^[a-z_$][\w$]*(?:\.[\w$]+)+$/.test(cls) && /\.[A-Z][\w$]*$/.test(cls);
  return {
    key: `main:${game ? 'install' : 'args'}`,
    build: (ctx, lines, context) =>
      finding(ctx, {
        code: 'C-JVM-START',
        severity: 'error',
        title: game ? `Java could not find the game's main class ${cls}` : `Java took "${cls}" from the JVM arguments as the class to start`,
        explanation: game
          ? `The game's or loader's start class ${cls} is not in the files the launcher passed to Java: the instance's libraries or game jar are missing or damaged.`
          : `Java expected the class to start where it found "${cls}". A word in the JVM arguments is not an option (a space inside an option like "-Xmx 4G", a stray quote, or a path with spaces that is not quoted), so Java read it as the main class and stopped.`,
        culprits: [],
        evidence: evidence(ctx, lines, context),
        fixes: [
          manual(
            ...(game
              ? [
                  'Let the launcher repair or reinstall the instance (Prism: Edit → Version → reinstall the loader; Modrinth App: the instance → ⋯ → Repair; CurseForge: Repair profile), or reinstall the mod loader for this version.',
                  'Antivirus programs sometimes delete library jars; restore them or exclude the launcher folder.',
                ]
              : [`Fix or remove "${cls}" in the instance's JVM arguments: every argument starts with "-" and has no spaces inside (e.g. -Xmx4G).`]),
            WHERE,
          ),
        ],
        discriminator: game ? 'main:install' : 'main:args',
      }),
  };
}

function bootLayer(detail: string): Omit<Hit, 'lines' | 'context'> {
  return {
    key: 'boot-layer',
    build: (ctx, lines, context) =>
      finding(ctx, {
        code: 'C-JVM-START',
        severity: 'error',
        title: 'Java could not build the module layer from the loader\'s libraries',
        explanation: `Java stopped while setting up the module path, before the game started${detail ? `: ${detail}` : ''}. The loader's libraries are duplicated, missing or damaged (or a JVM argument adds a jar to the module path).`,
        culprits: [],
        evidence: evidence(ctx, lines, context),
        fixes: [
          manual(
            'Let the launcher repair or reinstall the mod loader for this instance.',
            'Remove JVM arguments that add jars or modules (-p, --module-path, --add-modules, -javaagent) unless a mod author asked for them.',
            WHERE,
          ),
        ],
        discriminator: 'boot-layer',
      }),
  };
}

const GENERIC: Omit<Hit, 'lines' | 'context'> = {
  key: 'generic',
  build: (ctx, lines, context) =>
    finding(ctx, {
      code: 'C-JVM-START',
      severity: 'error',
      title: 'Java could not start the game',
      explanation:
        'Java stopped before Minecraft started ("Could not create the Java Virtual Machine"). The reason is the line Java printed just before; it is usually a JVM argument, the memory setting, or the Java the instance uses.',
      culprits: [],
      evidence: evidence(ctx, lines, context),
      fixes: [
        manual(
          'Remove any extra JVM arguments from the instance and start it again.',
          'Check that 64-bit Java of the version the game needs is selected, and that the maximum memory is a plain size like 6G.',
          WHERE,
        ),
      ],
      discriminator: 'generic',
    }),
};

export const jvmStartupPattern: CrashPattern = {
  id: 'jvm-startup',
  codes: ['C-JVM-START', 'C-OOM', 'C-JAVA-VERSION'],
  anchors: [
    // Printed only by a JVM that is exiting before the game runs.
    ...fatal(
      CREATE_VM,
      FATAL_EXIT,
      INIT_VM,
      BOOT_LAYER,
      'Error: Could not find or load main class',
      'Could not reserve enough space for',
      'Unrecognized VM option',
      'Unrecognized option: ',
      'Invalid maximum heap size',
      'Invalid initial heap size',
      'Initial heap size set to a larger value than the maximum heap size',
      'The specified size exceeds the maximum representable size',
      'java.lang.module.FindException',
    ),
  ],
  match(input) {
    const ctx = ctxOf(input);
    const mcMin = ctx.mcVersion ? minJavaForMinecraft(ctx.mcVersion) : null;
    const hits = new Map<string, Hit>();
    const add = (i: number, h: Omit<Hit, 'lines' | 'context'>, context: number[] = []): void => {
      const cur = hits.get(h.key) ?? { ...h, lines: [], context: [] };
      if (cur.lines.length < 5) cur.lines.push(i);
      for (const c of context) if (!cur.context.includes(c)) cur.context.push(c);
      hits.set(h.key, cur);
    };
    const lines = ctx.lines;
    let specific = false;
    lines.forEach((l, i) => {
      const t = l.text;
      if (!t.includes('Unrecognized') && !t.includes('heap') && !t.includes('Error') && !t.includes('FindException')) return;
      if (!startupGate(ctx, i)) return;
      const vm = UNRECOGNIZED_VM.exec(t);
      if (vm) {
        const opt = vm[1] ?? '';
        // Java prints the name without its +/- (`'UseConcMarkSweepGC'`); flags are mostly `-XX:+Name`.
        add(i, unrecognized(opt, /^\w+$/.test(opt) ? `-XX:+${opt}` : `-XX:${opt}`, mcMin), exitLinesAfter(ctx, i));
        specific = true;
        return;
      }
      const un = UNRECOGNIZED.exec(t);
      if (un) {
        const opt = un[1] ?? '';
        add(i, unrecognized(opt, opt, mcMin), exitLinesAfter(ctx, i));
        specific = true;
        return;
      }
      const heap = INVALID_HEAP.exec(t);
      if (heap) {
        const next = lines.slice(i + 1, i + 3).some((x) => NOT_REPRESENTABLE.test(x.text));
        add(i, invalidHeap(heap[1] ?? 'maximum', heap[2] ?? '', next), exitLinesAfter(ctx, i));
        specific = true;
        return;
      }
      if (HEAP_ORDER.test(t)) {
        const init = i > 0 && (lines[i - 1]?.text ?? '').includes(INIT_VM) ? [i - 1] : [];
        add(i, HEAP_ORDER_HIT, init);
        specific = true;
        return;
      }
      const res = RESERVE.exec(t);
      if (res) {
        const init = i > 0 && (lines[i - 1]?.text ?? '').includes(INIT_VM) ? [i - 1] : [];
        add(i, reserve(Number(res[1])), init);
        specific = true;
        return;
      }
      const main = MAIN_CLASS.exec(t);
      if (main) {
        const cause = (lines[i + 1]?.text ?? '').includes('Caused by:') ? [i + 1] : [];
        add(i, mainClass(main[1] ?? ''), cause);
        specific = true;
        return;
      }
      if (t.includes(BOOT_LAYER)) {
        // The exception printed right after; a ResolutionException is C-RESOLUTION's.
        const next = lines.slice(i + 1, i + 4);
        if (next.some((x) => x.text.includes('java.lang.module.ResolutionException'))) {
          specific = true;
          return;
        }
        const k = next.findIndex((x) => FIND_EXCEPTION.test(x.text) || OTHER_BOOT_EXCEPTION.test(x.text));
        const exText = k >= 0 ? (next[k]?.text ?? '') : '';
        const detail = (FIND_EXCEPTION.exec(exText)?.[1] ?? OTHER_BOOT_EXCEPTION.exec(exText)?.[2] ?? '').trim();
        const hit = bootLayer(detail.length > 200 ? `${detail.slice(0, 199)}…` : detail);
        add(i, hit);
        // The exception line is a culprit too: it is the crash's own trace.
        if (k >= 0) add(i + 1 + k, hit);
        specific = true;
      }
    });
    // Nothing more specific: the generic exit lines, unless the wrong Java for the game itself
    // explains them (C-JAVA-VERSION reports that).
    const wrongJava = lines.some((l) => l.text.includes('UnsupportedClassVersionError') || l.text.includes('LinkageError occurred while loading main class'));
    if (!specific && !wrongJava) {
      lines.forEach((l, i) => {
        if (!startupGate(ctx, i)) return;
        if (l.text.includes(CREATE_VM)) {
          const before = [i - 3, i - 2, i - 1].filter((j) => j >= 0 && (lines[j]?.text.trim() ?? '') !== '');
          add(i, GENERIC, before);
        } else if (l.text.includes(INIT_VM)) {
          // `Error occurred during initialization of VM` is followed by its reason.
          const after = [i + 1, i + 2].filter((j) => j < lines.length && (lines[j]?.text.trim() ?? '') !== '');
          add(i, GENERIC, after);
        }
      });
    }
    return [...hits.values()].map((h) => h.build(ctx, h.lines, h.context));
  },
};
