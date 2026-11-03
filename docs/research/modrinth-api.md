# Modrinth API v2 research (R3)

Researched 2026-11-02 against live `api.modrinth.com` (12 requests, UA `KingCreeper531/modpack-doctor/0.0.0-research (...)`),
the published OpenAPI spec (`info.version: v2.7.0/366f528`, https://docs.modrinth.com/openapi.yaml), and labrinth
source on `main` (https://github.com/modrinth/code/tree/main/apps/labrinth). v2 is still the current API; v3 is
still documented as experimental and not for production use.

**Big change since most third-party docs were written:** projects and versions now carry an `environment` field
(new 9-value side system, Aug 2025). `client_side`/`server_side` still exist in v2 but are marked
**deprecated**. See section 3.

---

## 1. `POST /v2/version_files` (hash -> Version)

Body (`HashList`): `{"hashes": [string], "algorithm": "sha1" | "sha512"}`. If you leave out `algorithm`, labrinth
infers it from the length of the **first** hash (>=128 chars means sha512, otherwise sha1). Always send it.

```http
POST /v2/version_files
Content-Type: application/json
{"hashes":["b11e18bb09f06c3f8028fa2c090072976fa326d0","bcdbf37d9494e405cba210d7a80ed58e756297b5",
           "0000000000000000000000000000000000000000"],"algorithm":"sha1"}
```
```json
{
  "b11e18bb09f06c3f8028fa2c090072976fa326d0": {"id":"vgceLbdH","project_id":"AANobbMI","version_number":"mc1.20-0.4.10", "...": "..."},
  "bcdbf37d9494e405cba210d7a80ed58e756297b5": {"id":"OihdIimA","project_id":"AANobbMI","version_number":"mc1.20.1-0.5.13-fabric", "...": "..."}
}
```
- Response is a map from hash to a full Version object. **Unknown hashes are silently left out** (verified live:
  the all-zero hash got no key, status 200). A hash whose version is hidden from you is also left out.
- Keys are the hash in the requested algorithm, so lower-case hex, the same as what you sent.
- The `files[]` inside the returned Version holds *all* files of that version. Find the one whose
  `hashes.sha1` equals the key.
- **No batch limit** shows up in the spec or in the route code (`get_versions_from_hashes` passes the whole list
  to one DB query). The JSON body size limit of the server/Cloudflare still applies. See recommendations.
- Single-hash form: `GET /v2/version_file/{hash}?algorithm=sha1` returns 404 if not found.

## 2. `POST /v2/version_files/update` (hash -> latest matching Version)

Body (`GetLatestVersionsFromHashesBody`):
```json
{"hashes":["bcdbf37d..."],"algorithm":"sha1","loaders":["fabric"],"game_versions":["1.20.1"],
 "version_types":["release"]}
```
- `version_types` (`release`/`beta`/`alpha`) is an optional extra filter. The spec marks `loaders` and
  `game_versions` as required, but in the code all three are `Option`. An empty or missing array means **no filter**.
  Verified: a body with only `hashes`+`algorithm` returned the newest version overall (`mc26.3-0.9.3-beta.1-fabric`,
  a *beta*). So always send `loaders` + `game_versions`, and send `version_types` when the user wants stable versions.
- Response: map from hash to a single Version (v2 shape. v3 returns `hash -> [Version]`).
- Semantics, from labrinth `update_files_internal`. For each hash: find its **project**, then choose the newest
  version of that project where `version_type IN version_types` AND some `game_versions` value is in the list AND
  some loader is in the list AND the version is visible. **Newest = `ORDER BY date_published DESC, id DESC`. It does
  not sort by semver.** So a back-port published later "wins" if it matches your filters.
- **Already latest:** it returns the *same* version. Verified: the 0.5.13 hash mapped to itself (`OihdIimA`).
  Compare `result.id == current.id` to detect "up to date".
- **Older hash:** maps to the newer version (verified: the 0.4.10 hash mapped to 0.5.13 for fabric/1.20.1).
- **No match** (for example `loaders:["forge"]` for Sodium-fabric): the hash is **left out** and you get `{}` with
  status 200 (verified). Unknown hashes are also left out. "Missing key" can therefore mean unknown file *or* no
  compatible version. Tell these apart with `/version_files` first.
- Two different hashes from the same project both map to the same Version.
- Loader matching is "any of". Fabric builds often list `["fabric","quilt"]`, so for a Quilt instance query
  `["quilt","fabric"]`.

## 3. `GET /v2/projects?ids=[...]`

The query parameter `ids` is a **JSON array string**, URL-encoded:
`/v2/projects?ids=%5B%22AANobbMI%22%2C%22fabric-api%22%5D`. **IDs and slugs can be mixed** (verified). Unknown entries
are left out (verified with `doesnotexist-zzz`). Output order is not guaranteed, so key the results by `id`/`slug`.

```json
[{"id":"AANobbMI","slug":"sodium","title":"Sodium","project_type":"mod",
  "icon_url":"https://cdn.modrinth.com/data/AANobbMI/295862f4..._96.webp",
  "raw_icon_url":"https://cdn.modrinth.com/data/AANobbMI/icon.png",
  "client_side":"required","server_side":"unsupported","environment":["client_only"],
  "loaders":["fabric","neoforge","quilt"],"game_versions":["1.16.3","..."],"versions":["..."]},
 {"id":"P7dR8mSH","slug":"fabric-api","title":"Fabric API","client_side":"optional","server_side":"optional",
  "environment":["client_or_server_prefers_both"],"loaders":["fabric"]}]
```
- `client_side` / `server_side`: `required | optional | unsupported | unknown` (`LegacySideType`). These are
  **deprecated in favor of `environment`**. In v2 they are now *derived* from the v3 environment data.
- **New `environment`** (project: array of every environment its versions use; version: a single string):
  `client_and_server`, `client_only`, `client_only_server_optional`, `singleplayer_only`, `server_only`,
  `server_only_client_optional`, `dedicated_server_only`, `client_or_server`, `client_or_server_prefers_both`,
  `unknown` (the last only on output). The spec says to prefer the **version's** environment. Meanings:
  https://modrinth.com/news/article/new-environments
- Also new: `raw_icon_url` (no CDN transform), `disclosure_types` (in search hits), `all_project_types`.
- `project_type`: `mod | modpack | resourcepack | shader` (also `plugin`/`datapack` show up as loaders/types).
- Max ids per request: **none documented**. Keep requests to around 100 ids. That is about 1.5 KB of URL for 8-char
  ids, well under typical 8 KB proxy limits.

## 4. Version object (v2)

Fields we saw live on `GET /v2/project/sodium/version`: `id, project_id, author_id, name, version_number,
changelog, changelog_url, date_published, downloads, version_type (release|beta|alpha), status, requested_status,
featured, game_versions[], loaders[], environment (string), files[], dependencies[]`.

```json
"files":[{"id":"KcvCzyWY",
  "hashes":{"sha1":"bcdbf37d9494e405cba210d7a80ed58e756297b5","sha512":"81c64f9c...ea4"},
  "url":"https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium-fabric-0.5.13%2Bmc1.20.1.jar",
  "filename":"sodium-fabric-0.5.13+mc1.20.1.jar","primary":true,"size":971552,"file_type":null}],
"dependencies":[{"version_id":null,"project_id":"VOYxIjFI","file_name":null,"dependency_type":"incompatible"}]
```
- `primary`: at most one per version. If none is set, the **first file** counts as primary (spec).
- `file_type`: `null` or one of `required-resource-pack, optional-resource-pack, sources-jar, dev-jar,
  javadoc-jar, signature, unknown`. Leave out sources/dev/javadoc jars when choosing a file to install.
- `dependency_type`: `required | optional | incompatible | embedded`. `version_id`, `project_id` and `file_name`
  are each nullable. `version_id` is usually null (it means "pinned exact version"). `file_name`-only deps are
  external files (mostly in modpacks). `embedded` = bundled (JiJ), so do not install it separately.
- URLs: only **`https://cdn.modrinth.com/data/{project_id}/versions/{version_id}/{urlencoded filename}`** was
  seen. The filename is percent-encoded (`+` becomes `%2B`), so use `url` as given and never build it from
  `filename`. No other hosts appear in v2 version files. Still treat it as an arbitrary HTTPS URL and allowlist it
  (see section 8).
- `GET /v2/project/{id|slug}/version?loaders=["fabric"]&game_versions=["1.20.1"]&include_changelog=false`
  (JSON arrays again). Verified: it returns **newest first** (by date). `include_changelog=false` is "highly
  recommended" by the spec and makes responses much smaller. Other filter: `featured`. No `version_types` param is
  documented here, so filter on the client. Matching is "any of" for each array.
- Related: `GET /v2/project/{id}/dependencies` (all dependency projects and versions of a project),
  `GET /v2/versions?ids=[...]` (batch versions).

## 5. Resolving a loader mod id (`fabric-api`, `cloth-config`) to a project

Modrinth does **not** index `fabric.mod.json` / `mods.toml` mod ids. Slugs are chosen by authors, are often equal to
the mod id, and **can change**. Store the `id`, not the slug.

Live checks: `fabric-api`, `cloth-config`, `jei`, `modmenu`, `iris`, `geckolib`, `kotlin-for-forge`,
`fabric-language-kotlin` all resolve as slugs. **`architectury` does not resolve** (the slug is `architectury-api`).
Forge-style ids use `_` (for example `cloth_config`), but slugs use `-`.

Recommended order:
1. **Hash first.** If the jar's sha1 is known to Modrinth, read `dependencies[].project_id` from its Version.
   This avoids guessing mod ids.
2. Leave out pseudo-deps: `minecraft`, `java`, `fabricloader`, `fabric-loader`, `quilt_loader`, `forge`,
   `neoforge`, `quilted_fabric_api`-style loader shims (handle those through a mapping).
3. Batch-guess: `GET /v2/projects?ids=["<modid>","<modid with _ to ->", ...]` in one call. **Validate** each hit:
   `project_type == "mod"`, its `loaders` includes the instance loader, and ideally the title roughly matches. A
   slug match can be an unrelated project.
4. Fallback search: `GET /v2/search?query=<modid>&facets=[["project_type:mod"],["categories:fabric"],["versions:1.20.1"]]&limit=5`.
   Inner arrays are OR, outer arrays are AND. Loaders are passed as `categories:`. `index=relevance` is the default.
   Response: `{hits:[{project_id, slug, title, client_side, server_side, environment, icon_url, latest_version,...}],
   offset, limit, total_hits}`. Accept only a hit whose slug or title normalizes to the mod id. Otherwise show the
   user candidates to choose from.
5. Keep a small curated alias table (`architectury -> architectury-api`, `fabric -> fabric-api`, ...).
6. Then pick a version: `GET /v2/project/{id}/version?loaders=[..]&game_versions=[..]&include_changelog=false`,
   then filter `version_type` and take the first (newest).

## 6. Rate limits, User-Agent, auth

- Documented: **300 requests/minute per IP**. It is the same with or without a token. Contact support for more.
  The current implementation is GCRA (`apps/labrinth/src/util/ratelimit.rs`): burst 300, refill 5 per second, keyed
  by `CF-Connecting-IP` or per-user override for PATs.
- Headers on every response: `X-Ratelimit-Limit` (300), `X-Ratelimit-Remaining`, `X-Ratelimit-Reset` (whole
  **seconds** until the bucket is fully refilled). Live responses always showed `300/300/0`. Some responses are
  Cloudflare-cached (`cf-cache-status: HIT`), and when Redis is down the limiter fails open with `remaining: 1,
  reset: 60`. **Don't trust `Remaining` exactly.**
- **429**: body `{"error":"ratelimit_error","description":"... rate limit exceeded; retry after N milliseconds"}`,
  with `X-Ratelimit-Remaining: 0`. **There is no `Retry-After` header.** Read `X-Ratelimit-Reset`, or parse the ms
  from `description`.
- **410** = API version retired (spec: "Please ensure your application handles these 410 errors").
- **User-Agent is mandatory and must identify you uniquely.** A UA that is only a library name (`okhttp/x`,
  `reqwest/x`) may get blocked. Recommended format: `github_username/project_name/version (contact)`. Use:
  `KingCreeper531/modpack-doctor/<semver> (github.com/KingCreeper531/modpack-doctor)`.
- **No auth needed** for any endpoint in this document (all public reads). Tokens (`Authorization: mrp_...`) are only
  for writes/private data. Do not ship one.
- CORS: `Access-Control-Allow-Origin: *`, so calls from a webview work too.

## 7. Loaders and game versions

- `GET /v2/tag/loader`. Mod and modpack loaders: `fabric`, `forge`, `neoforge`, `quilt`. Mod-only:
  `babric`, `bta-babric`, `java-agent`, `legacy-fabric`, `liteloader`, `modloader`, `nilloader`, `ornithe`, `rift`.
  Plugin loaders (`bukkit`, `paper`, `spigot`, `folia`, `purpur`, `sponge`, `velocity`, `bungeecord`,
  `waterfall`, `geyser`) and `datapack` also show up. Resource packs use `minecraft`. Shaders use `iris`,
  `optifine`, `canvas`, `vanilla`. All values are lowercase.
- `GET /v2/tag/game_version` returns 921 entries `{version, version_type: release|snapshot|alpha|beta, date, major}`,
  newest first. **Minecraft's new year-based numbering is live:** releases now include `26.3`, `26.2`, `26.1.2`,
  `26.1.1`, `26.1`, then `1.21.11`, `1.21.10`, ... Snapshots look like `26.4-snapshot-6`. **Do not assume `1.x.y`.**
  Do not compare versions as semver strings. Use the tag list's `date` order for "newer than".
- Matching is exact string equality (no ranges). Mods that support `1.21.x` list each patch version.
- .mrpack dependency keys are different: `fabric-loader` / `quilt-loader` (not `fabric`/`quilt`).

## 8. `.mrpack` format (formatVersion 1)

Spec: https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack.
A ZIP with MIME type `application/x-modrinth-modpack+zip`.
```
pack.mrpack
├── modrinth.index.json      (UTF-8, at the root)
├── overrides/               (copied into the instance root)
├── client-overrides/        (client installs only)
└── server-overrides/        (server installs only)
```
```json
{"formatVersion":1,"game":"minecraft","versionId":"1.2.0","name":"My Pack","summary":"optional",
 "files":[{"path":"mods/sodium-fabric-0.5.13+mc1.20.1.jar",
   "hashes":{"sha1":"bcdbf37d...","sha512":"81c64f9c..."},
   "env":{"client":"required","server":"unsupported"},
   "downloads":["https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium-fabric-0.5.13%2Bmc1.20.1.jar"],
   "fileSize":971552}],
 "dependencies":{"minecraft":"1.20.1","fabric-loader":"0.16.10"}}
```
- `hashes`: `sha1` **and** `sha512` are both required. Verify after download.
- `env` is optional (missing means required on both sides). Values: `required | optional | unsupported`, the *old*
  3-value system, not the new `environment`. `server` means the dedicated server. For `optional`, the spec suggests
  asking the user.
- `downloads`: HTTPS URLs, tried as alternatives. Follow 3xx redirects (at least 3 recommended). No unencoded
  spaces/illegal characters (RFC 3986).
- `dependencies` keys: `minecraft`, `forge`, `neoforge`, `fabric-loader`, `quilt-loader`. More may be added, so
  readers must tolerate unknown keys.
- **Override precedence:** extract `overrides/` first, then `client-overrides/` (client) or `server-overrides/`
  (server) on top, overwriting files with the same path.
- **Modrinth upload allowlist** for `downloads` hosts: `cdn.modrinth.com`, `github.com`,
  `raw.githubusercontent.com`, `gitlab.com`. Other platforms SHOULD define their own allowlist. We should use this
  same list when importing packs.
- **Path safety:** reject any `files[].path` (and any zip entry under overrides) that contains `..`, or that starts
  with `/`, `\`, or a drive letter (`C:/`, `C:\`). Also resolve the path and check that it stays inside the instance
  directory. Watch out for zip-slip, symlinks, and Windows reserved names. Modrinth validates paths on upload, but
  packs from other sources may not be validated.

## 9. ToS, branding, caching

Source: https://modrinth.com/legal/terms (sections *API Usage*, *Prohibited Uses*, *Trademarks*,
*Linking to the Service*). Also https://github.com/modrinth/code (README branding note).
- API use is granted as a "limited, non-exclusive, non-sublicensable and revocable license". It is conditional on
  following the Terms and the Content Rules. Do not overburden the service.
- **Trademarks:** the Modrinth name and logo cannot be used without prior written permission. Do not imply
  endorsement or association. Plain descriptive text ("Data from Modrinth", "Open on Modrinth") is the safe path.
  **Do not bundle the Modrinth logo**. The monorepo README also reserves branding assets.
- Do not use API content to train AI/ML models (Prohibited Uses).
- **Caching:** the ToS and API docs say nothing about it. Project ids are stable, slugs can change. Version and file
  hashes are immutable, though a version can be deleted or unlisted.
- Mod files belong to their authors under each project's license. Download from the URLs Modrinth gives you. Do not
  re-host files.

---

## Client design recommendations

1. **Pipeline:** hash all jars (sha1, plus sha512 when building an mrpack). Then `POST /version_files` in chunks.
   Then `GET /projects?ids=` for the unique project_ids (chunks of 100). Then `POST /version_files/update` with the
   instance's `loaders` + `[game_version]` + `version_types:["release"]` (offer a "include beta" toggle).
2. **Batch sizes:** `version_files` and `version_files/update` : chunk to **500 hashes per request** (our cap; the API documents none).
   500 sha1 hashes is about 22 KB of body. `projects`/`versions`: chunk to **100 ids per
   request**. A 300-mod pack then costs about 4 requests.
3. **Concurrency:** at most 4 requests in flight. Use a client-side token bucket of about 250/min. That stays under
   the limit even if the headers are wrong.
4. **429/5xx backoff:** on 429, wait `max(X-Ratelimit-Reset s, parsed "retry after N ms", 1 s)` plus jitter, and
   retry up to 5 times. On 5xx or network errors, back off exponentially (1, 2, 4, 8, 16 s, cap 30 s, with jitter).
   Do not retry 400/404. A 410 should show "app update required".
5. **Cache TTLs** (local SQLite/JSON):
   - hash -> version_id: positive results **permanent** (a hash is immutable). Unknown-hash (negative) results for
     **24 h**.
   - version_id -> Version: **7 days** (status/dependencies rarely change).
   - project_id -> Project (title, icon, environment): **24 h**.
   - update lookups (hash + loader + gv + types -> latest): **1 h**, with a "Refresh" button that bypasses it.
   - slug/modid -> project_id guesses: **7 days**, and validate again on use.
   - tags (`loader`, `game_version`): **24 h**.
   - icons: HTTP cache, use `icon_url` (the `_96.webp` CDN variant) for list views.
6. Store **project ids**, not slugs. Key all results by `id` because response order is not guaranteed.
7. A missing key in `/update` means one of two things. Check `/version_files`: if the hash is known, report "no
   version for this loader/MC"; if not, report "not on Modrinth".
8. Read sides from `environment` first. Fall back to `client_side`/`server_side`. Map `environment` to mrpack `env`
   ourselves (for example `client_only` -> client required / server unsupported, `client_or_server_prefers_both` ->
   optional/optional).
9. Downloads: use `files[].url` exactly as given. Check the host against the allowlist (section 8). Verify sha1 *and*
   sha512 after download, and write through a temp file then rename. Choose the primary file, or the first file
   if none is primary. Skip `sources-jar`/`dev-jar`/`javadoc-jar`.
10. Always send the UA with the app version. Send no auth header. Treat the response JSON as untrusted (escape
    names and descriptions in the UI).

## Uncertain

- **Batch caps:** I found no hard maximum for `version_files`, `version_files/update` or `projects?ids=`. Real
  limits come from Cloudflare/actix body and URL size limits that I did not test. Test 500/1000-hash bodies before
  release.
- Rate-limit headers always read `300/300/0` in my tests (caching or fail-open?). The exact meaning of
  `X-Ratelimit-Reset` on a 429 comes from reading the code, not from observing one.
- `/version_files/update` "newest" is by `date_published`. The v3 single-hash path also uses a version `ordering`
  column first. v2 batch could change to that later.
- Whether v2 `client_side`/`server_side` will be removed. Modrinth says v2 gets environment "later", and it is
  already there. The full mapping from environment to legacy side fields is in labrinth `v2_reroute` and I did not
  review it.
- Whether `GET /project/{id}/version` accepts an undocumented `version_types`/`version_type` filter.
- The order between `client-overrides` and `server-overrides` is not defined by the spec (they never both apply on
  one install).
- I found no explicit caching policy or attribution requirement in the ToS. Ask support@modrinth.com before
  publishing if we want to show "Modrinth" branding beyond plain text.
- I did not verify the shader loader list (`iris`/`optifine`/...) live. I filtered the tag output to mod/modpack
  types.
