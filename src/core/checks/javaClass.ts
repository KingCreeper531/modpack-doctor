/**
 * W-JAVA-CLASS (warning): a loaded top-level jar — or a jar bundled in it — has class files
 * compiled for a newer Java than the pack's Minecraft version requires
 * (`minJavaForMinecraft`). A launcher that picks Java by Minecraft version then crashes with
 * `UnsupportedClassVersionError`. Warning, not error: the user may already run a newer Java.
 * One finding per top-level jar (the highest class version across it and its loaded nested jars).
 * Skipped when the MC version is unknown/unrecognised or no class version was sampled.
 * Fix: manual (run a newer Java, or use a build for the pack's Java).
 */
import type { JarRecord } from '../../bindings';
import { javaFeatureForClassMajor, minJavaForMinecraft } from '../crash/javaVersions';
import type { Check, Finding } from '../model';
import { contextFor } from './context';
import { jarRef, makeFinding, manual } from './evidence';

export const javaClassCheck: Check = {
  id: 'java-class-version',
  codes: ['W-JAVA-CLASS'],
  run(input) {
    const ctx = contextFor(input);
    const mc = ctx.pack.mcVersion;
    const minJava = mc === null ? null : minJavaForMinecraft(mc);
    if (mc === null || minJava === null) return [];
    const byTop = new Map<string, { top: JarRecord; worst: JarRecord; major: number }>();
    for (const jar of ctx.loadedJars) {
      if (jar.maxClassMajor === null) continue;
      const top = ctx.topOf(jar);
      const cur = byTop.get(top.id);
      if (!cur || jar.maxClassMajor > cur.major) byTop.set(top.id, { top, worst: jar, major: jar.maxClassMajor });
    }
    const out: Finding[] = [];
    for (const { top, worst, major } of byTop.values()) {
      const needs = javaFeatureForClassMajor(major);
      if (needs === null || needs <= minJava) continue;
      const where = worst.id === top.id ? top.fileName : `${worst.path} (bundled in ${top.fileName})`;
      const first = ctx.loaded(top)[0];
      out.push(
        makeFinding({
          code: 'W-JAVA-CLASS',
          severity: 'warning',
          title: `${top.fileName} needs Java ${needs}, but Minecraft ${mc} ships with Java ${minJava}`,
          explanation:
            `${where} contains classes compiled for Java ${needs} (class file version ${major}). Minecraft ${mc} is normally run with Java ${minJava}, ` +
            `and an older Java crashes with "UnsupportedClassVersionError" when the mod loads. ` +
            `Run the instance with Java ${needs} or newer, or use a build of the mod made for Java ${minJava}.`,
          culprits: [jarRef(top, first?.modId)],
          evidence: [{ kind: 'note', text: `Highest class file version in ${where}: ${major} (Java ${needs}).` }, ctx.packNote],
          fixes: [
            manual(
              `In your launcher's instance settings, select a Java ${needs} (or newer) runtime.`,
              `Or replace ${top.fileName} with a build of the mod that targets Java ${minJava}.`,
            ),
          ],
          discriminator: '',
        }),
      );
    }
    return out;
  },
};
