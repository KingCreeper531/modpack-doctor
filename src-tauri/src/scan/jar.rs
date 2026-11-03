//! Analysis of one jar held in memory: hashes, metadata, packages, class versions, and
//! recursion into nested jars.

use std::collections::BTreeSet;
use std::io::{Cursor, Read};

use sha1::{Digest, Sha1};
use sha2::Sha512;
use zip::ZipArchive;

use super::forge::{parse_mods_toml, Manifest};
use super::util::{decode_text, NestedDecl, Parsed};
use super::{fabric, legacy, quilt, MAX_NESTED_DEPTH};
use crate::jar_id;
use crate::model::{JarRecord, JarStatus, LoaderKind, ScanIssue};

/// Classes whose header is read for `max_class_major` (evenly spread over the jar).
pub(crate) const CLASS_SAMPLE: usize = 64;
/// Metadata files larger than this are refused (zip-bomb guard).
const METADATA_CAP: u64 = 8 * 1024 * 1024;
/// Nested jars larger than this are refused.
const NESTED_CAP: u64 = 512 * 1024 * 1024;

const MANIFEST: &str = "META-INF/MANIFEST.MF";
const JARJAR: &str = "META-INF/jarjar/metadata.json";
const NEOFORGE_TOML: &str = "META-INF/neoforge.mods.toml";
const FORGE_TOML: &str = "META-INF/mods.toml";
const FABRIC_JSON: &str = "fabric.mod.json";
const QUILT_JSON: &str = "quilt.mod.json";
const MCMOD_INFO: &str = "mcmod.info";

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
        loaders: Vec::new(),
        mods: Vec::new(),
        packages: Vec::new(),
        mixin_configs: Vec::new(),
        max_class_major: None,
        module_name: None,
        jarjar: None,
        nested: Vec::new(),
    }
}

fn is_meta_inf(name: &str) -> bool {
    name.as_bytes().get(..9).is_some_and(|p| p.eq_ignore_ascii_case(b"META-INF/"))
}

/// Read a whole entry, refusing anything over `cap` bytes.
fn read_entry<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, idx: usize, cap: u64) -> Result<Vec<u8>, String> {
    let f = zip.by_index(idx).map_err(|e| e.to_string())?;
    if f.size() > cap {
        return Err(format!("entry is too large ({} bytes)", f.size()));
    }
    let mut buf = Vec::with_capacity(usize::try_from(f.size()).unwrap_or(0));
    f.take(cap + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > cap {
        return Err("entry is too large".into());
    }
    Ok(buf)
}

/// Class-file major version from the first 8 bytes; None for bad magic or short files.
fn class_major<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, idx: usize) -> Option<u32> {
    let mut f = zip.by_index(idx).ok()?;
    let mut head = [0u8; 8];
    f.read_exact(&mut head).ok()?;
    (head[..4] == [0xCA, 0xFE, 0xBA, 0xBE]).then(|| u32::from(u16::from_be_bytes([head[6], head[7]])))
}

/// Read a metadata entry as text. None when absent; read failures are recorded in `errors`.
fn read_text(zip: &mut ZipArchive<Cursor<&[u8]>>, name: &str, errors: &mut Vec<String>) -> Option<String> {
    let idx = zip.index_for_name(name)?;
    match read_entry(zip, idx, METADATA_CAP) {
        Ok(b) => Some(decode_text(&b)),
        Err(e) => {
            errors.push(format!("{name}: {e}"));
            None
        }
    }
}

/// Scan `bytes` as the jar described by `ctx`, appending its record and those of all nested
/// jars to `out`, and any problems to `issues`. Never panics.
pub(crate) fn scan_into(ctx: &JarCtx, bytes: &[u8], out: &mut Vec<JarRecord>, issues: &mut Vec<ScanIssue>) {
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

    // Packages and class sample, from entry names only.
    let mut packages = BTreeSet::new();
    let mut classes = Vec::new();
    for i in 0..zip.len() {
        let Some(Ok(name)) = zip.name_for_index(i) else { continue };
        if !name.ends_with(".class") || is_meta_inf(&name) {
            continue;
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
    rec.max_class_major = sample.into_iter().filter_map(|i| class_major(&mut zip, i)).max();

    // Metadata.
    let mut errors: Vec<String> = Vec::new();
    let manifest = read_text(&mut zip, MANIFEST, &mut errors).map(|t| Manifest::parse(&t)).unwrap_or_default();

    let mut parsed: Vec<Parsed> = Vec::new();
    let mut add = |file: &str, r: Result<Parsed, String>, errors: &mut Vec<String>| match r {
        Ok(p) => parsed.push(p),
        Err(e) => errors.push(format!("{file}: {e}")),
    };
    if let Some(t) = read_text(&mut zip, NEOFORGE_TOML, &mut errors) {
        add(NEOFORGE_TOML, parse_mods_toml(&t, NEOFORGE_TOML, true, &manifest), &mut errors);
    }
    if let Some(t) = read_text(&mut zip, FORGE_TOML, &mut errors) {
        add(FORGE_TOML, parse_mods_toml(&t, FORGE_TOML, false, &manifest), &mut errors);
    }
    if let Some(t) = read_text(&mut zip, FABRIC_JSON, &mut errors) {
        add(FABRIC_JSON, fabric::parse_fabric(&t, FABRIC_JSON), &mut errors);
    }
    if let Some(t) = read_text(&mut zip, QUILT_JSON, &mut errors) {
        add(QUILT_JSON, quilt::parse_quilt(&t, QUILT_JSON), &mut errors);
    }
    if let Some(t) = read_text(&mut zip, MCMOD_INFO, &mut errors) {
        add(MCMOD_INFO, legacy::parse_mcmod_info(&t, MCMOD_INFO), &mut errors);
    }
    let mut decls: Vec<NestedDecl> = Vec::new();
    if let Some(t) = read_text(&mut zip, JARJAR, &mut errors) {
        match legacy::parse_jarjar(&t) {
            Ok(d) => decls.extend(d),
            Err(e) => errors.push(format!("{JARJAR}: {e}")),
        }
    }

    let mut mixins: BTreeSet<String> = manifest.mixin_configs().into_iter().collect();
    for p in parsed {
        mixins.extend(p.mixins);
        rec.mods.extend(p.mods);
        for d in p.nested {
            // JarJar metadata wins when both declare the same path.
            if !decls.iter().any(|x| x.path == d.path) {
                decls.push(d);
            }
        }
    }
    rec.mixin_configs = mixins.into_iter().collect();
    let mut loaders: Vec<LoaderKind> = Vec::new();
    for m in &rec.mods {
        if !loaders.contains(&m.loader) {
            loaders.push(m.loader);
        }
    }
    rec.loaders = loaders;

    if !errors.is_empty() {
        let reason = errors.join("; ");
        issues.push(ScanIssue {
            subject: ctx.id.clone(),
            message: format!("{} has invalid metadata ({reason}).", ctx.file_name),
        });
        rec.status = JarStatus::Corrupt { reason };
    }

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
        let Some(idx) = zip.index_for_name(&decl.path) else {
            issues.push(ScanIssue {
                subject: ctx.id.clone(),
                message: format!("{} declares the nested jar {}, but the file is missing from the jar.", ctx.file_name, decl.path),
            });
            continue;
        };
        let inner = match read_entry(&mut zip, idx, NESTED_CAP) {
            Ok(b) => b,
            Err(e) => {
                issues.push(ScanIssue {
                    subject: child_id,
                    message: format!("Nested jar {} in {} could not be read: {e}.", decl.path, ctx.file_name),
                });
                continue;
            }
        };
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
        scan_into(&child_ctx, &inner, &mut children, issues);
        if let Some(first) = children.get_mut(start) {
            first.jarjar = decl.jarjar;
        }
        rec.nested.push(child_id);
    }
    out.push(rec);
    out.append(&mut children);
}
