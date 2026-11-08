//! Analysis of one jar held in memory: hashes, metadata, packages, class versions, module
//! name, legacy `@Mod` annotations, and recursion into nested jars under a per-top-level-jar
//! zip-bomb budget.

use std::collections::{BTreeSet, HashSet};
use std::io::{Cursor, Read};

use sha1::{Digest, Sha1};
use sha2::Sha512;
use zip::ZipArchive;

use super::forge::{parse_mods_toml, Manifest};
use super::util::{decode_text, NestedDecl, Parsed};
use super::{annotation, fabric, legacy, module_info, quilt, MAX_NESTED_DEPTH};
use crate::jar_id;
use crate::model::{JarRecord, JarStatus, LoaderKind, MetadataError, ScanIssue};

/// Classes whose header is read for `max_class_major` (evenly spread over the jar).
pub(crate) const CLASS_SAMPLE: usize = 64;
const MIB: u64 = 1024 * 1024;
/// Never pre-allocate more than this for an entry, whatever size it declares.
const MAX_PREALLOC: u64 = MIB;

/// Zip-bomb limits, applied per top-level jar (its nested jars share one budget).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    /// Largest metadata file (mods.toml, fabric.mod.json, module-info.class, …) read.
    pub metadata_cap: u64,
    /// Largest nested jar read.
    pub nested_cap: u64,
    /// Total bytes inflated from zip entries for one top-level jar, nested levels included.
    pub inflated_budget: u64,
    /// Most nested-jar records produced under one top-level jar.
    pub max_nested_records: u32,
    /// `@Mod` search: largest class file read (bigger ones are skipped).
    pub class_cap: u64,
    /// `@Mod` search: total class bytes inflated for one top-level jar (separate from
    /// `inflated_budget`; only top-level jars are searched).
    pub class_budget: u64,
    /// `@Mod` search: most class files read for one top-level jar.
    pub max_class_reads: u32,
    /// `@Mod` search: most annotations kept for one jar.
    pub max_mod_annotations: usize,
}

pub(crate) const DEFAULT_LIMITS: Limits = Limits {
    metadata_cap: 8 * MIB,
    nested_cap: 64 * MIB,
    inflated_budget: 256 * MIB,
    max_nested_records: 512,
    class_cap: 512 * 1024,
    class_budget: 64 * MIB,
    max_class_reads: 65_536,
    max_mod_annotations: 64,
};

/// Remaining allowance while scanning one top-level jar.
#[derive(Debug)]
pub(crate) struct Budget {
    limits: Limits,
    inflated_left: u64,
    records_left: u32,
    class_left: u64,
    inflated_reported: bool,
    records_reported: bool,
}

impl Budget {
    pub fn new(limits: Limits) -> Self {
        Budget {
            limits,
            inflated_left: limits.inflated_budget,
            records_left: limits.max_nested_records,
            class_left: limits.class_budget,
            inflated_reported: false,
            records_reported: false,
        }
    }
}

enum ReadError {
    TooLarge { cap: u64 },
    OverBudget,
    Zip(String),
}

impl ReadError {
    fn describe(&self) -> String {
        match self {
            ReadError::TooLarge { cap } => format!("entry is larger than the {} limit", human(*cap)),
            ReadError::OverBudget => "the jar's total unpacked-size limit was reached".into(),
            ReadError::Zip(e) => e.clone(),
        }
    }
}

fn human(bytes: u64) -> String {
    if bytes >= MIB && bytes.is_multiple_of(MIB) {
        format!("{} MiB", bytes / MIB)
    } else {
        format!("{bytes} bytes")
    }
}

/// Identity of the jar being analysed.
#[derive(Debug, Clone)]
pub(crate) struct JarCtx {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub depth: u32,
    pub parent_id: Option<String>,
    pub disabled: bool,
    pub mtime_ms: u64,
}

/// SHA-1 and SHA-512 (lowercase hex) of `bytes`, both computed in one pass over the buffer.
pub(crate) fn hash_bytes(bytes: &[u8]) -> (String, String) {
    let mut s1 = Sha1::new();
    let mut s512 = Sha512::new();
    for chunk in bytes.chunks(64 * 1024) {
        s1.update(chunk);
        s512.update(chunk);
    }
    (hex::encode(s1.finalize()), hex::encode(s512.finalize()))
}

pub(crate) fn empty_record(ctx: &JarCtx, size: u64, status: JarStatus) -> JarRecord {
    JarRecord {
        id: ctx.id.clone(),
        path: ctx.path.clone(),
        file_name: ctx.file_name.clone(),
        size,
        mtime_ms: ctx.mtime_ms,
        sha1: String::new(),
        sha512: String::new(),
        disabled: ctx.disabled,
        depth: ctx.depth,
        parent_id: ctx.parent_id.clone(),
        status,
        metadata_errors: Vec::new(),
        loaders: Vec::new(),
        mods: Vec::new(),
        packages: Vec::new(),
        mixin_configs: Vec::new(),
        max_class_major: None,
        module_name: None,
        fml_mod_type: None,
        jarjar: None,
        nested: Vec::new(),
    }
}

fn is_meta_inf(name: &str) -> bool {
    name.as_bytes().get(..9).is_some_and(|p| p.eq_ignore_ascii_case(b"META-INF/"))
}

/// `META-INF/versions/<N>/module-info.class` → N.
fn versioned_module_info(name: &str) -> Option<u32> {
    let rest = name.get(18..)?;
    if !name.get(..18)?.eq_ignore_ascii_case("META-INF/versions/") {
        return None;
    }
    let (n, file) = rest.split_once('/')?;
    (file == "module-info.class").then(|| n.parse().ok()).flatten()
}

/// Read a whole entry, refusing anything over `cap` bytes or over the remaining budget. The
/// declared size is only trusted to refuse early, never for allocation.
fn read_entry<R: Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    idx: usize,
    cap: u64,
    budget: &mut Budget,
) -> Result<Vec<u8>, ReadError> {
    read_within(zip, idx, cap, &mut budget.inflated_left)
}

/// [`read_entry`] against an arbitrary allowance `left` (decremented by the bytes inflated).
fn read_within<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, idx: usize, cap: u64, left: &mut u64) -> Result<Vec<u8>, ReadError> {
    let f = zip.by_index(idx).map_err(|e| ReadError::Zip(e.to_string()))?;
    let declared = f.size();
    if declared > cap {
        return Err(ReadError::TooLarge { cap });
    }
    if declared > *left {
        return Err(ReadError::OverBudget);
    }
    let limit = cap.min(*left);
    let mut buf = Vec::with_capacity(usize::try_from(declared.min(MAX_PREALLOC)).unwrap_or(0));
    let res = f.take(limit + 1).read_to_end(&mut buf);
    let n = buf.len() as u64;
    *left = left.saturating_sub(n);
    res.map_err(|e| ReadError::Zip(e.to_string()))?;
    if n > limit {
        return Err(if limit == cap { ReadError::TooLarge { cap } } else { ReadError::OverBudget });
    }
    Ok(buf)
}

/// Class-file major version from the first 8 bytes; None for bad magic or short files.
fn class_major<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, idx: usize) -> Option<u32> {
    let mut f = zip.by_index(idx).ok()?;
    let mut head = [0u8; 8];
    f.read_exact(&mut head).ok()?;
    major_of(&head)
}

fn major_of(head: &[u8]) -> Option<u32> {
    let h = head.get(..8)?;
    (h[..4] == [0xCA, 0xFE, 0xBA, 0xBE]).then(|| u32::from(u16::from_be_bytes([h[6], h[7]])))
}

/// What legacy FML would look for in this jar's classes.
#[derive(Debug, Clone, Copy, Default)]
struct ClassSearch {
    /// `@Mod` / `@API` (mod discovery): a top-level jar with no 1.13+ / Fabric / Quilt mod
    /// metadata, and not a coremod or tweaker jar unless its manifest says it also holds a mod
    /// (`FMLCorePluginContainsFMLMod`; FML's `CoreModManager` puts other `FMLCorePlugin` /
    /// `TweakClass` jars on its ignore list for mod discovery).
    mods: bool,
    /// A coremod's own `DummyModContainer` (any `FMLCorePlugin` jar without modern metadata).
    containers: bool,
}

impl ClassSearch {
    fn any(self) -> bool {
        self.mods || self.containers
    }
}

fn fml_class_search(ctx: &JarCtx, zip: &ZipArchive<Cursor<&[u8]>>, manifest: &Manifest) -> ClassSearch {
    if ctx.depth != 0 || [NEOFORGE_TOML, FORGE_TOML, FABRIC_JSON, QUILT_JSON].iter().any(|f| zip.index_for_name(f).is_some()) {
        return ClassSearch::default();
    }
    let set = |k: &str| manifest.get(k).is_some_and(|v| !v.trim().is_empty());
    let coremod = set("FMLCorePlugin");
    ClassSearch { mods: !(coremod || set("TweakClass")) || set("FMLCorePluginContainsFMLMod"), containers: coremod }
}

/// What the class search found in one jar.
#[derive(Debug, Default)]
struct LegacyFacts {
    mods: Vec<annotation::ModAnnotation>,
    apis: Vec<annotation::ApiAnnotation>,
    containers: Vec<annotation::DummyContainer>,
}

impl LegacyFacts {
    fn is_empty(&self) -> bool {
        self.mods.is_empty() && self.apis.is_empty() && self.containers.is_empty()
    }
}

/// Read the jar's classes (outer classes first, then inner `$` classes) looking for what
/// `search` asks for (`@Mod` / `@API` annotations, coremod containers), within
/// `Limits::class_cap` / `class_budget` / `max_class_reads` / `max_mod_annotations` (which counts
/// all three kinds). Records the major version of every `sample` class it reads in `majors`, so
/// those are not opened again. Stopping at a limit adds one `ScanIssue`.
#[allow(clippy::too_many_arguments)]
fn find_legacy_facts(
    ctx: &JarCtx,
    zip: &mut ZipArchive<Cursor<&[u8]>>,
    classes: &[(usize, String)],
    sample: &[usize],
    search: ClassSearch,
    budget: &mut Budget,
    majors: &mut Vec<(usize, Option<u32>)>,
    issues: &mut Vec<ScanIssue>,
) -> LegacyFacts {
    let limits = budget.limits;
    let mut order: Vec<&(usize, String)> = classes.iter().collect();
    order.sort_by_key(|(_, name)| name.contains('$'));
    let mut found = LegacyFacts::default();
    let mut kept: usize = 0;
    let mut stopped: Option<String> = None;
    for (reads, (idx, name)) in (0u32..).zip(order) {
        if kept >= limits.max_mod_annotations {
            stopped = Some(format!("the limit of {} @Mod / @API / mod-container classes per jar was reached", limits.max_mod_annotations));
            break;
        }
        if reads >= limits.max_class_reads {
            stopped = Some(format!("it has more than {} class files", limits.max_class_reads));
            break;
        }
        match read_within(zip, *idx, limits.class_cap, &mut budget.class_left) {
            Ok(bytes) => {
                if sample.contains(idx) {
                    majors.push((*idx, major_of(&bytes)));
                }
                if annotation::may_have_mod(&bytes) {
                    let facts = annotation::parse_class(&bytes, name);
                    let before = found.mods.len() + found.apis.len() + found.containers.len();
                    if search.mods {
                        found.mods.extend(facts.mod_annotation);
                        found.apis.extend(facts.api);
                    }
                    if search.containers {
                        found.containers.extend(facts.container);
                    }
                    kept += found.mods.len() + found.apis.len() + found.containers.len() - before;
                }
            }
            Err(ReadError::OverBudget) => {
                stopped = Some(format!("its classes unpack to more than {}", human(limits.class_budget)));
                break;
            }
            // Oversized or unreadable class: FML could not use it either; skip it.
            Err(_) => {}
        }
    }
    if let Some(why) = stopped {
        issues.push(ScanIssue {
            subject: ctx.id.clone(),
            message: format!(
                "Stopped looking for @Mod classes in {}: {why}. Mods it declares only through @Mod in the remaining classes are not listed.",
                ctx.file_name
            ),
        });
    }
    found
}

/// Read a metadata entry as text. None when absent; read failures are recorded in `errors`.
fn read_text(zip: &mut ZipArchive<Cursor<&[u8]>>, name: &str, budget: &mut Budget, errors: &mut Vec<MetadataError>) -> Option<String> {
    let idx = zip.index_for_name(name)?;
    let cap = budget.limits.metadata_cap;
    match read_entry(zip, idx, cap, budget) {
        Ok(b) => Some(decode_text(&b)),
        Err(e) => {
            errors.push(MetadataError { file: name.to_string(), reason: e.describe() });
            None
        }
    }
}

/// Parse one mod-metadata file, turning an empty file into a readable error.
fn parse_file(text: &str, parse: impl FnOnce(&str) -> Result<Parsed, String>) -> Result<Parsed, String> {
    if text.trim().is_empty() {
        return Err("the file is empty".into());
    }
    parse(text)
}

/// Scan `bytes` as the jar described by `ctx`, appending its record and those of all nested
/// jars to `out`, and any problems to `issues`. `budget` is shared by a top-level jar and all
/// of its nested jars. Never panics.
pub(crate) fn scan_into(ctx: &JarCtx, bytes: &[u8], budget: &mut Budget, out: &mut Vec<JarRecord>, issues: &mut Vec<ScanIssue>) {
    let mut rec = empty_record(ctx, bytes.len() as u64, JarStatus::Ok);
    let (sha1, sha512) = hash_bytes(bytes);
    rec.sha1 = sha1;
    rec.sha512 = sha512;

    let mut zip = match ZipArchive::new(Cursor::new(bytes)) {
        Ok(z) => z,
        Err(e) => {
            let reason = format!("not a valid jar (zip) file: {e}");
            issues.push(ScanIssue { subject: ctx.id.clone(), message: format!("{} is damaged: {reason}.", ctx.file_name) });
            rec.status = JarStatus::Corrupt { reason };
            out.push(rec);
            return;
        }
    };

    // The manifest first: it decides whether legacy FML would search the classes for @Mod.
    let mut errors: Vec<MetadataError> = Vec::new();
    let manifest = read_text(&mut zip, MANIFEST, budget, &mut errors).map(|t| Manifest::parse(&t)).unwrap_or_default();
    let search = fml_class_search(ctx, &zip, &manifest);

    // Packages, class sample and module-info location, from entry names only.
    let mut packages = BTreeSet::new();
    let mut classes = Vec::new();
    let mut class_names: Vec<(usize, String)> = Vec::new();
    let mut module_info_idx: Option<usize> = None;
    let mut versioned_mi: Option<(u32, usize)> = None;
    for i in 0..zip.len() {
        let Some(Ok(name)) = zip.name_for_index(i) else { continue };
        if !name.ends_with(".class") {
            continue;
        }
        if is_meta_inf(&name) {
            if let Some(v) = versioned_module_info(&name) {
                if versioned_mi.is_none_or(|(best, _)| v < best) {
                    versioned_mi = Some((v, i));
                }
            }
            continue;
        }
        if name == "module-info.class" {
            module_info_idx = Some(i);
        } else if search.any() {
            class_names.push((i, name.to_string()));
        }
        classes.push(i);
        if let Some((dir, _)) = name.rsplit_once('/') {
            if !dir.is_empty() {
                packages.insert(dir.replace('/', "."));
            }
        }
    }
    rec.packages = packages.into_iter().collect();
    let sample: Vec<usize> = if classes.len() <= CLASS_SAMPLE {
        classes
    } else {
        (0..CLASS_SAMPLE).map(|k| classes[k * classes.len() / CLASS_SAMPLE]).collect()
    };
    // One pass over the class files: the @Mod search reads whole classes and records the major
    // version of the sampled ones; only sampled classes it skipped get their header read.
    let mut majors: Vec<(usize, Option<u32>)> = Vec::new();
    let legacy_facts = if search.any() {
        find_legacy_facts(ctx, &mut zip, &class_names, &sample, search, budget, &mut majors, issues)
    } else {
        LegacyFacts::default()
    };
    rec.max_class_major = sample
        .into_iter()
        .filter_map(|i| match majors.iter().find(|(j, _)| *j == i) {
            Some((_, m)) => *m,
            None => class_major(&mut zip, i),
        })
        .max();

    // Metadata. Each file is parsed on its own: a broken file is listed in `metadata_errors`
    // and only makes the jar Corrupt when no mod-metadata file produced a ModMeta.
    let mi_name = module_info_idx.or(versioned_mi.map(|(_, i)| i)).and_then(|i| {
        let cap = budget.limits.metadata_cap;
        read_entry(&mut zip, i, cap, budget).ok().and_then(|b| module_info::module_name(&b))
    });
    rec.module_name = mi_name.or_else(|| {
        manifest.get("Automatic-Module-Name").map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    });
    // Main-section attribute, verbatim but trimmed (`MOD`, `LIBRARY`, `GAMELIBRARY`, …).
    rec.fml_mod_type = manifest.get("FMLModType").map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

    type ParseFn = fn(&str, &Manifest) -> Result<Parsed, String>;
    let formats: [(&str, ParseFn); 5] = [
        (NEOFORGE_TOML, |t, m| parse_mods_toml(t, NEOFORGE_TOML, true, m)),
        (FORGE_TOML, |t, m| parse_mods_toml(t, FORGE_TOML, false, m)),
        (FABRIC_JSON, |t, _| fabric::parse_fabric(t, FABRIC_JSON)),
        (QUILT_JSON, |t, _| quilt::parse_quilt(t, QUILT_JSON)),
        (MCMOD_INFO, |t, _| legacy::parse_mcmod_info(t, MCMOD_INFO)),
    ];
    let mut parsed: Vec<Parsed> = Vec::new();
    let mut mod_files_present = false;
    let mut mod_file_errors: Vec<String> = Vec::new();
    for (file, parse) in formats {
        if zip.index_for_name(file).is_none() {
            continue;
        }
        mod_files_present = true;
        let before = errors.len();
        let Some(text) = read_text(&mut zip, file, budget, &mut errors) else {
            mod_file_errors.extend(errors[before..].iter().map(|e| format!("{}: {}", e.file, e.reason)));
            continue;
        };
        match parse_file(&text, |t| parse(t, &manifest)) {
            Ok(p) => parsed.push(p),
            Err(reason) => {
                mod_file_errors.push(format!("{file}: {reason}"));
                errors.push(MetadataError { file: file.to_string(), reason });
            }
        }
    }
    let mut decls: Vec<NestedDecl> = Vec::new();
    if let Some(t) = read_text(&mut zip, JARJAR, budget, &mut errors) {
        match legacy::parse_jarjar(&t) {
            Ok(d) => decls.extend(d),
            Err(reason) => errors.push(MetadataError { file: JARJAR.to_string(), reason }),
        }
    }

    let mut mixins: BTreeSet<String> = manifest.mixin_configs().into_iter().collect();
    let mut opted_in: Vec<String> = Vec::new();
    for p in parsed {
        mixins.extend(p.mixins);
        rec.mods.extend(p.mods);
        decls.extend(p.nested);
        opted_in.extend(p.uses_dependency_information);
    }
    if !legacy_facts.is_empty() {
        let LegacyFacts { mods, apis, containers } = legacy_facts;
        annotation::merge(&mut rec.mods, &opted_in, mods, containers, apis, MCMOD_INFO);
    }
    // One record per entry path; JarJar declarations come first, so their info wins.
    let mut seen: HashSet<String> = HashSet::new();
    decls.retain(|d| seen.insert(d.path.clone()));

    rec.mixin_configs = mixins.into_iter().collect();
    let mut loaders: Vec<LoaderKind> = Vec::new();
    for m in &rec.mods {
        if !loaders.contains(&m.loader) {
            loaders.push(m.loader);
        }
    }
    rec.loaders = loaders;

    if mod_files_present && rec.mods.is_empty() {
        let reason = mod_file_errors.join("; ");
        issues.push(ScanIssue {
            subject: ctx.id.clone(),
            message: format!("{} has no readable mod metadata ({reason}).", ctx.file_name),
        });
        rec.status = JarStatus::Corrupt { reason };
    }
    rec.metadata_errors = errors;

    // Nested jars.
    let mut children: Vec<JarRecord> = Vec::new();
    for decl in decls {
        let child_id = jar_id::nested_id(&ctx.id, &decl.path);
        if ctx.depth + 1 > MAX_NESTED_DEPTH {
            issues.push(ScanIssue {
                subject: child_id,
                message: format!("Nested jar {} was not scanned: jars nested more than {MAX_NESTED_DEPTH} levels deep are skipped.", decl.path),
            });
            continue;
        }
        if budget.records_left == 0 {
            if !budget.records_reported {
                budget.records_reported = true;
                issues.push(ScanIssue {
                    subject: ctx.id.clone(),
                    message: format!(
                        "Stopped scanning nested jars in {}: more than {} nested jars were found, which looks like a zip bomb.",
                        ctx.file_name, budget.limits.max_nested_records
                    ),
                });
            }
            break;
        }
        let Some(idx) = zip.index_for_name(&decl.path) else {
            issues.push(ScanIssue {
                subject: ctx.id.clone(),
                message: format!("{} declares the nested jar {}, but the file is missing from the jar.", ctx.file_name, decl.path),
            });
            continue;
        };
        let cap = budget.limits.nested_cap;
        let inner = match read_entry(&mut zip, idx, cap, budget) {
            Ok(b) => b,
            Err(ReadError::OverBudget) => {
                if !budget.inflated_reported {
                    budget.inflated_reported = true;
                    issues.push(ScanIssue {
                        subject: ctx.id.clone(),
                        message: format!(
                            "Stopped scanning nested jars in {}: they unpack to more than {} in total, which looks like a zip bomb.",
                            ctx.file_name,
                            human(budget.limits.inflated_budget)
                        ),
                    });
                }
                break;
            }
            Err(e) => {
                issues.push(ScanIssue {
                    subject: child_id,
                    message: format!("Nested jar {} in {} was not scanned: {}.", decl.path, ctx.file_name, e.describe()),
                });
                continue;
            }
        };
        budget.records_left -= 1;
        let child_ctx = JarCtx {
            id: child_id.clone(),
            path: decl.path.clone(),
            file_name: decl.path.rsplit('/').next().unwrap_or(&decl.path).to_string(),
            depth: ctx.depth + 1,
            parent_id: Some(ctx.id.clone()),
            disabled: ctx.disabled,
            mtime_ms: 0,
        };
        let start = children.len();
        scan_into(&child_ctx, &inner, budget, &mut children, issues);
        if let Some(first) = children.get_mut(start) {
            first.jarjar = decl.jarjar;
        }
        rec.nested.push(child_id);
    }
    out.push(rec);
    out.append(&mut children);
}

const MANIFEST: &str = "META-INF/MANIFEST.MF";
const JARJAR: &str = "META-INF/jarjar/metadata.json";
const NEOFORGE_TOML: &str = "META-INF/neoforge.mods.toml";
const FORGE_TOML: &str = "META-INF/mods.toml";
const FABRIC_JSON: &str = "fabric.mod.json";
const QUILT_JSON: &str = "quilt.mod.json";
const MCMOD_INFO: &str = "mcmod.info";
