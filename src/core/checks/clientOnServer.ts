/**
 * W-CLIENT-ON-SERVER (warning): the pack side is `server` and an active top-level jar is a
 * client-only mod. Either source suffices:
 * - Jar metadata: every metadata entry the pack loader reads has `environment: client` (Fabric/
 *   Quilt `"environment": "client"`, Forge/NeoForge `clientSideOnly = true`).
 * - Modrinth (when the context is present; cached data is used even offline): the identified
 *   version's v3 `environment`; when absent or `unknown`, the project's `environment` list (all
 *   entries client-only); when that is empty too, the legacy `server_side: unsupported` with a
 *   supported client side.
 *   Client-only environments: `client_only` and `singleplayer_only` (runs only in the integrated
 *   server). `client_only_server_optional` is NOT client-only: Modrinth marks it optional on the
 *   server, so it loads there.
 * Fix: disable the jar.
 */
import type { JarRecord, MrProject, MrVersion } from '../../bindings';
import type { Check, Evidence, Finding, ModrinthContext } from '../model';
import { contextFor } from './context';
import { disable, environmentLines, jarRef, makeFinding, metadataEvidence, modName } from './evidence';

const CLIENT_ONLY_ENVS: ReadonlySet<string> = new Set(['client_only', 'singleplayer_only']);

interface ModrinthVerdict {
  source: string;
  title: string;
}

/** Client-only verdict from Modrinth data, or null (not client-only / unknown). */
export function modrinthClientOnly(jar: JarRecord, mr: ModrinthContext | undefined): ModrinthVerdict | null {
  if (!mr) return null;
  const version: MrVersion | undefined = mr.versions[jar.sha1.toLowerCase()] ?? mr.versions[jar.sha1];
  if (!version) return null;
  const project: MrProject | undefined = mr.projects[version.projectId];
  const title = project?.title ?? version.name;
  const env = version.environment;
  if (env && env !== 'unknown') {
    return CLIENT_ONLY_ENVS.has(env) ? { source: `Modrinth lists version ${version.versionNumber} as "${env}".`, title } : null;
  }
  if (!project) return null;
  const envs = project.environment.filter((e) => e !== 'unknown');
  if (envs.length > 0) {
    return envs.every((e) => CLIENT_ONLY_ENVS.has(e)) ? { source: `Modrinth lists the project as "${envs.join(', ')}".`, title } : null;
  }
  if (project.serverSide === 'unsupported' && (project.clientSide === 'required' || project.clientSide === 'optional')) {
    return { source: `Modrinth lists the project as client: ${project.clientSide}, server: unsupported.`, title };
  }
  return null;
}

export const clientOnServerCheck: Check = {
  id: 'client-on-server',
  codes: ['W-CLIENT-ON-SERVER'],
  run(input) {
    const ctx = contextFor(input);
    if (ctx.pack.side !== 'server') return [];
    const out: Finding[] = [];
    for (const jar of ctx.topLevel) {
      const mods = ctx.relevant(jar);
      const metaClient = mods.length > 0 && mods.every((m) => m.environment === 'client');
      const mr = modrinthClientOnly(jar, input.modrinth);
      if (!metaClient && !mr) continue;
      const first = mods[0];
      const name = first ? modName(first) : (mr?.title ?? jar.fileName);
      const evidence: Evidence[] = [];
      if (metaClient && first && first.metadataExcerpt) evidence.push(metadataEvidence(jar, first, environmentLines(first)));
      if (mr) evidence.push({ kind: 'note', text: mr.source });
      evidence.push(ctx.packNote);
      const how = metaClient
        ? `Its ${first?.metadataFile ?? 'metadata'} marks it client-only, so the server skips it — it is dead weight and can still break if another mod expects it.`
        : `Modrinth marks it client-only. A dedicated server has no rendering or input code, so a client-only mod usually crashes the server at startup.`;
      out.push(
        makeFinding({
          code: 'W-CLIENT-ON-SERVER',
          severity: 'warning',
          title: `${name} is a client-only mod on a server`,
          explanation: `${name} (${jar.fileName}) only runs on the client (the game window), and this instance is a server. ${how} Disable it on the server; players keep it in their own client.`,
          culprits: [jarRef(jar, first?.modId)],
          evidence,
          fixes: [disable(jar)],
          discriminator: '',
        }),
      );
    }
    return out;
  },
};
