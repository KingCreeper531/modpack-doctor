//! Static jar scan results. FROZEN (M1).
//!
//! Rust extracts raw facts only. Version ranges are passed through as raw strings tagged
//! with their syntax; `src/core/version` parses them. Rust may *restructure* a range
//! (Quilt objects → OR-of-AND form) but never evaluates one.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::instance::LoaderKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum RangeSyntax {
    /// Forge / NeoForge / mcmod.info: Maven version ranges (`[47,)`, `[1.20,1.20.2)`).
    Maven,
    /// Fabric / Quilt predicates (`>=0.15`, `~1.20.1`, `1.20.x`).
    Fabric,
}

/// A declared version range in disjunctive normal form.
///
/// - Maven: `raw` has exactly one entry (the full spec, e.g. `[1.20,1.21),[1.21.1]`).
/// - Fabric: each `raw` entry is OR-ed; inside an entry, space-separated predicates are AND-ed
///   (Fabric semantics). Quilt `versions` are normalised to this form by the scanner:
///   a string → one entry; an array or `{"any": [...]}` → one entry each; `{"all": [...]}` →
///   predicates joined by a space; nesting is distributed into DNF (capped at 64 entries —
///   beyond that `raw` is empty and `unrepresentable` holds the original JSON).
/// - Empty `raw` (and no `unrepresentable`) or a `*` entry means "any version".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RawRange {
    pub syntax: RangeSyntax,
    pub raw: Vec<String>,
    pub unrepresentable: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DependencyKind {
    Required,
    Optional,
    Recommended,
    /// Forge/NeoForge `type="incompatible"`, Quilt `breaks`.
    Incompatible,
    /// Fabric `breaks`.
    Breaks,
    /// Fabric `conflicts`, NeoForge `type="discouraged"`.
    Conflicts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ModEnvironment {
    Client,
    Server,
    Both,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub mod_id: String,
    pub kind: DependencyKind,
    pub range: RawRange,
    /// Forge `side` ("CLIENT"/"SERVER"/"BOTH") or Fabric env key, if declared.
    pub side: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModMeta {
    pub mod_id: String,
    pub version: String,
    pub name: Option<String>,
    /// The loader this metadata entry belongs to. For `META-INF/mods.toml` it is decided by the
    /// dependency mod ids (`neoforge` dep → Neoforge, `forge` dep → Forge, neither → Forge).
    pub loader: LoaderKind,
    /// Fabric/Quilt `provides`; empty for Forge.
    pub provides: Vec<String>,
    pub environment: ModEnvironment,
    /// Range of the dependency on `minecraft` (also kept in `deps`).
    pub mc_range: Option<RawRange>,
    /// Range of the dependency on the loader itself: the `forge` / `neoforge` dependency in
    /// mods.toml, `fabricloader` in fabric.mod.json, `quilt_loader` in quilt.mod.json
    /// (also kept in `deps`). Compared against `LoaderInfo.version`.
    pub loader_range: Option<RawRange>,
    /// Forge/NeoForge top-level `modLoader` (`javafml`, `lowcodefml`, `kotlinforforge`, …).
    pub language_loader: Option<String>,
    /// Forge/NeoForge top-level `loaderVersion`. This is the *language loader / FML* version
    /// (e.g. NeoForge `[4,)`), NOT the Forge/NeoForge version — never compare it with
    /// `LoaderInfo.version`.
    pub language_range: Option<RawRange>,
    pub deps: Vec<Dependency>,
    /// Path of the metadata file inside the jar, e.g. `META-INF/neoforge.mods.toml`.
    pub metadata_file: String,
    /// First ≤ 16 KiB of that file, for evidence display.
    pub metadata_excerpt: String,
}

/// A metadata file inside a jar that could not be parsed (empty, invalid TOML/JSON, unexpanded
/// build-template placeholders such as `${mod_id}`, …). Whether it matters depends on which file
/// the pack's loader reads, which only `src/core` knows: e.g. NeoForge ≥ 1.20.5 reads only
/// `META-INF/neoforge.mods.toml`, so a broken leftover `META-INF/mods.toml` is harmless there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MetadataError {
    /// Path inside the jar, e.g. `META-INF/mods.toml`.
    pub file: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum JarStatus {
    Ok,
    /// Not a valid zip, or it has metadata files and NONE of them parsed. A jar where at least
    /// one metadata file parsed is `Ok`; the failed ones are listed in `metadata_errors`.
    Corrupt { reason: String },
    /// I/O or permission error.
    Unreadable { reason: String },
}

/// JarJar identity of a nested jar (Forge/NeoForge `META-INF/jarjar/metadata.json`).
/// The loader keeps only one copy per `group:artifact`, so checks de-duplicate by it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JarJarInfo {
    pub group: String,
    pub artifact: String,
    /// Declared acceptable range (Maven syntax).
    pub range: Option<String>,
    /// Version the parent ships.
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JarRecord {
    /// Stable across enable/disable. Top-level: path relative to the scan root (the instance
    /// game dir, or the `.mrpack` root), always `/`-separated, with any `.disabled` suffix
    /// stripped: `mods/sodium-0.5.8.jar` whether or not it is disabled,
    /// `client-overrides/mods/y.jar`. If both `x.jar` and `x.jar.disabled` exist, the enabled
    /// one is `mods/x.jar` and the disabled one `mods/x.jar#disabled`.
    /// Nested: `<parentId>!/<entry path>`.
    ///
    /// Rust resolves an id back to a file deterministically (no stored state): `#disabled` →
    /// `<path>.disabled`; otherwise `<path>` if present, else `<path>.disabled`.
    pub id: String,
    /// Actual current path relative to the scan root, `/`-separated (includes `.disabled`).
    /// For nested jars, the entry path inside the parent.
    pub path: String,
    pub file_name: String,
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
    /// Unix epoch milliseconds; 0 for nested jars.
    #[specta(type = specta_typescript::Number)]
    pub mtime_ms: u64,
    /// Lowercase hex.
    pub sha1: String,
    /// Lowercase hex.
    pub sha512: String,
    /// `*.jar.disabled`: listed, excluded from checks.
    pub disabled: bool,
    /// 0 = top-level, 1+ = nested.
    pub depth: u32,
    pub parent_id: Option<String>,
    pub status: JarStatus,
    /// Metadata files present in the jar that failed to parse (see `MetadataError`). Empty for
    /// healthy jars. Never makes the jar `Corrupt` on its own if another metadata file parsed.
    pub metadata_errors: Vec<MetadataError>,
    /// Union of `mods[].loader`; empty when no metadata file was found.
    pub loaders: Vec<LoaderKind>,
    pub mods: Vec<ModMeta>,
    /// Sorted, de-duplicated Java packages of this jar's *own* `.class` files (dot form),
    /// excluding `META-INF/**` (incl. multi-release `META-INF/versions/N/`).
    pub packages: Vec<String>,
    /// Mixin config file names declared by the jar (`foo.mixins.json`).
    pub mixin_configs: Vec<String>,
    /// Highest class-file major version among this jar's own classes outside `META-INF/**`
    /// (multi-release overlays excluded), e.g. 65 = Java 21. Sampled; None if no classes.
    pub max_class_major: Option<u32>,
    /// JPMS module name, for mapping `Module X reads package …` errors to jars: the
    /// `module-info.class` name if present, else MANIFEST `Automatic-Module-Name`. None
    /// otherwise; `src/core` derives the JDK automatic name from the file name itself.
    pub module_name: Option<String>,
    /// MANIFEST `FMLModType` attribute verbatim (`MOD`, `LIBRARY`, `GAMELIBRARY`, `LANGPROVIDER`),
    /// trimmed; None if absent. FML 1.17+ loads a jar without mods metadata only if this is set
    /// (docs/research/loader-enforcement.md, third round).
    pub fml_mod_type: Option<String>,
    /// Set for nested jars declared in `META-INF/jarjar/metadata.json`.
    pub jarjar: Option<JarJarInfo>,
    /// Ids of directly nested jars.
    pub nested: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    /// Jar id, or a directory path relative to the scan root.
    pub subject: String,
    pub message: String,
}

/// A file declared by a `.mrpack` index; diagnosed by hash without downloading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredFile {
    pub path: String,
    pub sha1: String,
    pub sha512: String,
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
    /// `required` | `optional` | `unsupported`, or None when `env` is absent.
    pub client: Option<String>,
    pub server: Option<String>,
    pub downloads: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub instance_id: String,
    #[specta(type = specta_typescript::Number)]
    pub started_at_ms: u64,
    pub duration_ms: u32,
    /// All jars, top-level and nested (flattened; use `depth`/`parentId`).
    pub jars: Vec<JarRecord>,
    /// `.mrpack` only; empty otherwise.
    pub declared: Vec<DeclaredFile>,
    /// `.mrpack` only: download URLs of index entries that were skipped (bad hash, unsafe or
    /// folder path) or shadowed by a later entry with the same path. A launcher may still install
    /// them, so W-MRPACK-DOWNLOAD checks these too (CONTRACTS invariant 15). Same sentinels as
    /// `DeclaredFile.downloads`.
    pub unverified_downloads: Vec<UnverifiedDownload>,
    pub issues: Vec<ScanIssue>,
    /// Instance config files that change what the loader enforces (`config/fml.toml`,
    /// `config/connector.json`), as raw facts; `src/core` interprets them. Omitted when neither
    /// file exists (and for `.mrpack` packs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub loader_config: Option<LoaderConfig>,
}

/// Raw facts from the instance's loader config files (read by `instance_config`, capped at
/// 256 KiB each; a broken file is a `ScanIssue`, never a failed scan).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoaderConfig {
    /// Game-dir-relative paths of the config files that exist (`config/fml.toml`,
    /// `config/connector.json`), whether or not they could be used.
    pub source_files: Vec<String>,
    /// `config/fml.toml` `dependencyOverrides` (NeoForge FML): one item per target mod id, the
    /// strings exactly as written (`"-dep"`, `"+dep"`; a single string becomes one entry), sorted
    /// by mod id. Empty when the file, the table or the entries are absent or unusable.
    pub fml_dependency_overrides: Vec<FmlDependencyOverride>,
    /// `config/connector.json` (Sinytra Connector) when it exists and is a JSON object; None
    /// otherwise (Connector then runs with its defaults).
    pub connector: Option<ConnectorConfigFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FmlDependencyOverride {
    /// The TOML key: the mod whose dependencies are overridden (case-sensitive, as written).
    pub mod_id: String,
    /// Raw override strings, in file order.
    pub entries: Vec<String>,
}

/// The fields of `config/connector.json` that matter to the checks, as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorConfigFile {
    /// `hiddenMods`; None when absent or not a list of strings.
    pub hidden_mods: Option<Vec<String>>,
    /// `globalModAliases` (`{ "id": "alias" | ["alias", …] }`), sorted by mod id; None when absent
    /// or not of that shape.
    pub global_mod_aliases: Option<Vec<ConnectorAlias>>,
    /// Top-level fields that are present but not what Connector's config codec accepts: wrong JSON
    /// type, or a `version` other than 1. Sorted.
    pub invalid_fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAlias {
    pub mod_id: String,
    pub aliases: Vec<String>,
}

/// A download URL from a `.mrpack` index entry that is not in `ScanResult.declared`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnverifiedDownload {
    /// The entry's `path` as written in the index (may be unsafe; display only), or
    /// `files[<i>]` when it has none.
    pub entry: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JarStub {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub disabled: bool,
}

/// Event: emitted once before any `ScanProgress`, listing every top-level jar in display
/// order (sorted by file name, case-insensitive) so the grid can lay out all tiles at once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ScanStarted {
    pub instance_id: String,
    pub jars: Vec<JarStub>,
}

/// Event: one top-level jar finished scanning (completion order, not display order).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub instance_id: String,
    pub done: u32,
    pub total: u32,
    pub jar_id: String,
    /// False when the jar is corrupt/unreadable.
    pub parsed: bool,
}
