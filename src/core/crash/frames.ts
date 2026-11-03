/**
 * Stack frame parsing and frame → jar mapping (docs/research/crash-formats.md §5).
 *
 * Grammar: `at [<loader>/][<module>[@<ver>]/]<fqcn>.<method>(<src>) [~][<jar>[%23N][!/]:<ver>] [{audit}]`
 */
import type { JarRecord } from '../../bindings';
import type { JarIndex } from '../model';
import { jarByFileName, jarsForModId, jarsForModLoose, jarsForPackage } from './jars';
import { packageOf } from './text';

export interface Frame {
  loader?: string;
  module?: string;
  moduleVersion?: string;
  cls: string;
  method: string;
  /** Jar file name from the `~[…]` bracket, URL-decoded. */
  jar?: string;
  /** FG-ML8 `~[modid:ver]` bracket (no `.jar`). */
  bracketModId?: string;
  audit?: string;
}

const FRAME = /^\s*at ([^\s(]+)\(([^)]*)\)(.*)$/;

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function parseFrame(text: string): Frame | null {
  const m = FRAME.exec(text);
  if (!m) return null;
  const parts = (m[1] ?? '').split('/');
  const qualified = parts[parts.length - 1] ?? '';
  const dot = qualified.lastIndexOf('.');
  if (dot <= 0) return null;
  const frame: Frame = { cls: qualified.slice(0, dot), method: qualified.slice(dot + 1) };
  let moduleSpec: string | undefined;
  if (parts.length >= 3) {
    if (parts[0]) frame.loader = parts[0];
    moduleSpec = parts[1];
  } else if (parts.length === 2) {
    moduleSpec = parts[0];
  }
  if (moduleSpec) {
    const at = moduleSpec.indexOf('@');
    frame.module = at >= 0 ? moduleSpec.slice(0, at) : moduleSpec;
    if (at >= 0) frame.moduleVersion = moduleSpec.slice(at + 1);
  }
  const rest = m[3] ?? '';
  const bracket = /~?\[([^\]]*)\]/.exec(rest);
  if (bracket) {
    let jar = bracket[1] ?? '';
    const enc = jar.indexOf('%23');
    const bang = jar.indexOf('!/');
    if (enc >= 0) jar = jar.slice(0, enc);
    else if (bang >= 0) jar = jar.slice(0, bang);
    else if (jar.lastIndexOf(':') >= 0) jar = jar.slice(0, jar.lastIndexOf(':'));
    jar = safeDecode(jar);
    if (/\.jar$/i.test(jar)) frame.jar = jar;
    else if (jar && jar !== '?' && /^[a-z][\w.-]*$/.test(jar)) frame.bracketModId = jar;
  }
  const audit = /\{([^}]*)\}/.exec(rest);
  if (audit) frame.audit = audit[1] ?? '';
  return frame;
}

export interface MixinOwner {
  config: string;
  mixin: string;
  modId?: string;
}

/** Mixins applied to a frame's class: Forge `pl:mixin:APP:cfg:M`, NEO-11 `APP:cfg:M from mod x`. */
export function mixinOwners(audit: string): MixinOwner[] {
  const out: MixinOwner[] = [];
  for (const m of audit.matchAll(/APP:([\w.$-]+\.json):([\w.$]+)(?: from mod ([\w.-]+))?/g)) {
    const owner: MixinOwner = { config: m[1] ?? '', mixin: m[2] ?? '' };
    if (m[3]) owner.modId = m[3];
    out.push(owner);
  }
  return out;
}

/** Mod id embedded in a Fabric-fork mixin handler name: `handler$znp000$coolmod$onTick`. */
export function handlerModId(method: string): string | null {
  const m = /^(?:handler|redirect|modify|modifyExpressionValue|modifyReturnValue|wrapOperation|wrapWithCondition|localvar)\$[0-9a-z]+\$([a-z][a-z0-9_]*)\$/.exec(method);
  return m ? (m[1] ?? null) : null;
}

/** JDK, loader, Mixin and Minecraft classes: never blamed. */
const INTERNAL_CLASS = [
  'java.',
  'javax.',
  'jdk.',
  'sun.',
  'com.sun.',
  'cpw.mods.',
  'net.minecraftforge.',
  'net.neoforged.',
  'net.fabricmc.loader.',
  'net.fabricmc.fabric.api.event.',
  'net.fabricmc.fabric.impl.base.event.',
  'org.quiltmc.loader.',
  'org.spongepowered.asm.',
  'com.llamalad7.mixinextras.',
  'org.apache.',
  'org.slf4j.',
  'com.google.',
  'it.unimi.',
  'io.netty.',
  'org.lwjgl.',
  'net.minecraft.',
  'com.mojang.',
  'oshi.',
  'kotlin.',
  'scala.',
];

const INTERNAL_MODULE = /^(?:java\.|jdk\.)|^(?:minecraft|forge|neoforge|fml_loader|fml_core|loader|mcp|cpw\.mods\..*|org\.spongepowered\.mixin)$/;
/**
 * Game, loader and library jars as they appear in frame brackets (never in `mods/`): the
 * Minecraft client/server jars (`client-1.20.1-20230612.114412-srg.jar`, `client-intermediary.jar`,
 * `minecraft-26.1.2-client.jar`, `minecraft-1.21.jar`), Forge/NeoForge/FML, Fabric/Quilt loader,
 * ModLauncher and Mixin. Only versioned names match, so a mod such as `minecraft-comes-alive-7.0.jar`
 * or `client-tweaks-1.0.jar` is not internal (and a jar found in the index is always a mod).
 */
const INTERNAL_JAR = new RegExp(
  [
    String.raw`^(?:client|server)-(?:\d[\w.+-]*|intermediary|extra|slim|srg|official|named|mojmap)\.jar$`,
    String.raw`^minecraft(?:-\d[\w.+-]*?)?(?:-(?:client|server))?\.jar$`,
    String.raw`^(?:neo)?forge-\d`,
    String.raw`^(?:fmlloader|fmlcore|fmlearlydisplay|javafmllanguage|lowcodelanguage|mclanguage|fancymodloader|loader|modlauncher|securejarhandler|bootstraplauncher|eventbus|bus|coremods|accesstransformers)-\d`,
    String.raw`^(?:fabric-loader|quilt-loader|sponge-mixin|mixin|mixinextras(?:-\w+)?)-\d`,
  ].join('|'),
  'i',
);
const INTERNAL_BRACKET_ID = /^(?:forge|minecraft|neoforge|mcp|fml)$/;

export function isInternalClass(cls: string): boolean {
  return INTERNAL_CLASS.some((p) => cls.startsWith(p));
}

export interface FrameHit {
  /** Resolved jar (any depth); callers take `topLevel` for fixes. */
  jar?: JarRecord;
  modId?: string;
  /** What the frame names: mod id, jar file name or package; for titles when no index. */
  label: string;
  via: 'handler' | 'module' | 'jar' | 'bracket' | 'package';
}

/**
 * Maps a frame to the mod that owns it. Returns null for JDK/loader/Mixin/Minecraft frames and
 * for frames that cannot be attributed. Without an index the hit has only a label.
 */
export function blameFrame(frame: Frame, index?: JarIndex): FrameHit | null {
  const handler = handlerModId(frame.method);
  if (handler) {
    const jar = index ? jarsForModId(handler, index)[0] : undefined;
    if (jar || !index) return { ...(jar ? { jar } : {}), modId: handler, label: handler, via: 'handler' };
  }
  if (isInternalClass(frame.cls)) return null;
  if (frame.loader === 'MC-BOOTSTRAP') return null;
  if (frame.module && INTERNAL_MODULE.test(frame.module)) return null;
  if (frame.module && frame.moduleVersion !== undefined) {
    const jar = index ? jarsForModLoose(frame.module, undefined, index)[0] : undefined;
    if (jar || !index) return { ...(jar ? { jar } : {}), modId: frame.module, label: frame.module, via: 'module' };
  }
  if (frame.jar) {
    const jar = index ? jarByFileName(frame.jar, index) : undefined;
    if (jar) return { jar, label: frame.jar, via: 'jar' };
    if (!index && !INTERNAL_JAR.test(frame.jar)) return { label: frame.jar, via: 'jar' };
  }
  if (frame.bracketModId && !INTERNAL_BRACKET_ID.test(frame.bracketModId)) {
    const jar = index ? jarsForModLoose(frame.bracketModId, undefined, index)[0] : undefined;
    if (jar || !index) {
      return { ...(jar ? { jar } : {}), modId: frame.bracketModId, label: frame.bracketModId, via: 'bracket' };
    }
  }
  if (index) {
    const jar = jarsForPackage(packageOf(frame.cls), index, true)[0];
    if (jar) return { jar, label: packageOf(frame.cls), via: 'package' };
  }
  return null;
}
