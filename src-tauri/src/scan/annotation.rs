//! Legacy Forge `@Mod` annotations (Minecraft 1.12.2 and older), read from class files.
//!
//! Legacy FML does not need `mcmod.info`: it scans every class of a mod jar with ASM and makes a
//! mod container for each class annotated with `@Mod` (`Lnet/minecraftforge/fml/common/Mod;` on
//! 1.8+, `Lcpw/mods/fml/common/Mod;` on 1.7.10). The dependency string and
//! `acceptedMinecraftVersions` it enforces come from that annotation
//! (docs/research/loader-enforcement.md, "Legacy FML").
//!
//! Legacy FML has two more sources of mod ids, read here too because dependencies on them are
//! common and they would otherwise look missing:
//! - `@API(owner, provides, apiVersion)` on a `package-info` class: `ModAPIManager` turns each into
//!   a mod container with id `provides` (e.g. RTG's `rtgapi`). Several jars often ship copies of
//!   one API; FML keeps one, so these become `provides` of the jar's entry, never entries.
//! - A coremod's own mod container (`IFMLLoadingPlugin.getModContainerClass`), a subclass of
//!   `DummyModContainer` that sets `ModMetadata.modId = "…"` in code (IvToolkit's `ivtoolkit`,
//!   TNT Utilities' `tnt_utilities_core`). Only the literal `ldc "…"; putfield ModMetadata.modId`
//!   (and `.version` / `.name`) pattern is recognised; ids computed at runtime are not.
//!
//! This module reads just enough of a class file for that: the constant pool, the super class,
//! method `Code` only for `DummyModContainer` subclasses, and the class attributes
//! `RuntimeVisibleAnnotations` / `RuntimeInvisibleAnnotations`. Malformed input yields nothing;
//! the parser never panics, never allocates more than the input implies, and bounds annotation
//! nesting. Which classes are read, and how many bytes in total, is decided by the caller
//! (`jar.rs`), under `Limits::class_cap` / `class_budget` / `max_mod_annotations`.
//!
//! [`merge`] combines the findings with the jar's `mcmod.info` entries (rule on the function).

use super::legacy::parse_dependency_string;
use super::util::{excerpt, has_placeholder, maven_range};
use crate::model::{Dependency, DependencyKind, LoaderKind, ModEnvironment, ModMeta};

/// `@Mod` descriptor on Forge 1.8 – 1.12.2.
pub(crate) const MOD_DESC: &[u8] = b"Lnet/minecraftforge/fml/common/Mod;";
/// `@Mod` descriptor on Forge 1.7.10 and older.
pub(crate) const MOD_DESC_CPW: &[u8] = b"Lcpw/mods/fml/common/Mod;";
const API_DESC: &[u8] = b"Lnet/minecraftforge/fml/common/API;";
const API_DESC_CPW: &[u8] = b"Lcpw/mods/fml/common/API;";
const DUMMY_CONTAINER: &[u8] = b"net/minecraftforge/fml/common/DummyModContainer";
const DUMMY_CONTAINER_CPW: &[u8] = b"cpw/mods/fml/common/DummyModContainer";
const MOD_METADATA_SUFFIX: &[u8] = b"fml/common/ModMetadata";
/// Shared by every name above: a cheap pre-filter before parsing a class.
const NEEDLE: &[u8] = b"fml/common/";
/// Nested annotation / array depth followed inside an element value.
const MAX_DEPTH: u32 = 16;
/// Longest annotation string value kept (longer ones are cut on a char boundary).
const MAX_VALUE: usize = 4096;

/// The `@Mod` values of one class. Strings are as written (empty = absent).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ModAnnotation {
    /// Class file path inside the jar, e.g. `com/example/MyMod.class`.
    pub class_file: String,
    /// The 1.7.10 descriptor (`cpw.mods.fml.common.Mod`) was used.
    pub cpw: bool,
    pub modid: String,
    pub name: String,
    pub version: String,
    pub dependencies: String,
    pub accepted_minecraft_versions: String,
    pub client_side_only: bool,
    pub server_side_only: bool,
    /// `useMetadata` when present (`false` makes FML use the annotation's dependencies even when
    /// mcmod.info sets `useDependencyInformation`).
    pub use_metadata: Option<bool>,
}

/// `@API(owner, provides, apiVersion)` on a `package-info` class.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ApiAnnotation {
    pub class_file: String,
    pub owner: String,
    pub provides: String,
    pub api_version: String,
}

/// What a coremod's `DummyModContainer` subclass sets on its `ModMetadata` (empty = not found).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DummyContainer {
    pub class_file: String,
    pub mod_id: String,
    pub name: String,
    pub version: String,
}

/// Everything one class file contributes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ClassFacts {
    pub mod_annotation: Option<ModAnnotation>,
    pub api: Option<ApiAnnotation>,
    pub container: Option<DummyContainer>,
}

#[cfg(test)]
impl ClassFacts {
    pub fn is_empty(&self) -> bool {
        self.mod_annotation.is_none() && self.api.is_none() && self.container.is_none()
    }
}

/// True when `bytes` could hold any of the FML names this module looks for (substring check).
pub(crate) fn may_have_mod(bytes: &[u8]) -> bool {
    bytes.windows(NEEDLE.len()).any(|w| w == NEEDLE)
}

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u1(&mut self) -> Option<u8> {
        let v = *self.b.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }

    fn u2(&mut self) -> Option<u16> {
        let s = self.b.get(self.pos..self.pos.checked_add(2)?)?;
        self.pos += 2;
        Some(u16::from_be_bytes([s[0], s[1]]))
    }

    fn u4(&mut self) -> Option<u32> {
        let s = self.b.get(self.pos..self.pos.checked_add(4)?)?;
        self.pos += 4;
        Some(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }

    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.pos..self.pos.checked_add(n)?)?;
        self.pos += n;
        Some(s)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.bytes(n).map(|_| ())
    }

    /// Walk a `fields`/`methods` table. When `code` is given, the body of every `Code`
    /// attribute (named by pool index `code_name`) is collected into it.
    fn members(&mut self, mut code: Option<(&mut Vec<&'a [u8]>, u16)>) -> Option<()> {
        let count = self.u2()?;
        for _ in 0..count {
            self.skip(6)?; // access, name, descriptor
            let attrs = self.u2()?;
            for _ in 0..attrs {
                let name = self.u2()?;
                let len = usize::try_from(self.u4()?).ok()?;
                let body = self.bytes(len)?;
                if let Some((out, code_name)) = code.as_mut() {
                    if name == *code_name {
                        out.push(body);
                    }
                }
            }
        }
        Some(())
    }
}

#[derive(Clone, Copy)]
enum Const<'a> {
    None,
    Utf8(&'a [u8]),
    Int(i32),
    /// CONSTANT_Class → Utf8 name index.
    Class(u16),
    /// CONSTANT_String → Utf8 index.
    Str(u16),
    /// CONSTANT_Fieldref → (Class index, NameAndType index).
    Field(u16, u16),
    /// CONSTANT_NameAndType → Utf8 name index.
    Nat(u16),
}

struct Pool<'a>(Vec<Const<'a>>);

impl<'a> Pool<'a> {
    fn get(&self, idx: u16) -> Const<'a> {
        self.0.get(usize::from(idx)).copied().unwrap_or(Const::None)
    }

    fn utf8(&self, idx: u16) -> Option<&'a [u8]> {
        match self.get(idx) {
            Const::Utf8(b) => Some(b),
            _ => None,
        }
    }

    fn int(&self, idx: u16) -> Option<i32> {
        match self.get(idx) {
            Const::Int(v) => Some(v),
            _ => None,
        }
    }

    fn class_name(&self, idx: u16) -> Option<&'a [u8]> {
        match self.get(idx) {
            Const::Class(n) => self.utf8(n),
            _ => None,
        }
    }

    fn string(&self, idx: u16) -> Option<&'a [u8]> {
        match self.get(idx) {
            Const::Str(n) => self.utf8(n),
            _ => None,
        }
    }

    /// Index of the first Utf8 entry equal to `s` (0 = none).
    fn find_utf8(&self, s: &[u8]) -> u16 {
        self.0.iter().position(|c| matches!(c, Const::Utf8(b) if *b == s)).and_then(|i| u16::try_from(i).ok()).unwrap_or(0)
    }

    /// Fieldref indices of `ModMetadata.<field>`.
    fn metadata_fields(&self, field: &[u8]) -> Vec<u16> {
        (0..self.0.len())
            .filter_map(|i| {
                let i = u16::try_from(i).ok()?;
                let Const::Field(class, nat) = self.get(i) else { return None };
                let Const::Nat(name) = self.get(nat) else { return None };
                (self.class_name(class)?.ends_with(MOD_METADATA_SUFFIX) && self.utf8(name)? == field).then_some(i)
            })
            .collect()
    }
}

/// Java "modified UTF-8" is UTF-8 for everything a mod id or version realistically holds; the
/// rare encoded NUL / surrogate pairs decode lossily.
fn text(b: &[u8]) -> String {
    let s = String::from_utf8_lossy(b);
    if s.len() <= MAX_VALUE {
        return s.into_owned();
    }
    let mut end = MAX_VALUE;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

fn read_pool<'a>(r: &mut Reader<'a>) -> Option<Pool<'a>> {
    let count = usize::from(r.u2()?);
    // Every entry takes at least 3 bytes, so a count the input cannot hold is refused before
    // allocating for it.
    if count.saturating_sub(1).checked_mul(3)? > r.b.len().saturating_sub(r.pos) {
        return None;
    }
    let mut pool: Vec<Const> = vec![Const::None; count.max(1)];
    let mut i = 1;
    while i < count {
        let tag = r.u1()?;
        let mut slots = 1;
        pool[i] = match tag {
            1 => {
                let len = usize::from(r.u2()?);
                Const::Utf8(r.bytes(len)?)
            }
            3 => Const::Int(i32::from_be_bytes(r.u4()?.to_be_bytes())),
            7 => Const::Class(r.u2()?),
            8 => Const::Str(r.u2()?),
            9 => Const::Field(r.u2()?, r.u2()?),
            12 => {
                let name = r.u2()?;
                r.skip(2)?;
                Const::Nat(name)
            }
            16 | 19 | 20 => {
                r.skip(2)?;
                Const::None
            }
            15 => {
                r.skip(3)?;
                Const::None
            }
            4 | 10 | 11 | 17 | 18 => {
                r.skip(4)?;
                Const::None
            }
            5 | 6 => {
                r.skip(8)?;
                slots = 2;
                Const::None
            }
            _ => return None,
        };
        i += slots;
    }
    Some(Pool(pool))
}

/// One `element_value` of `@Mod`: what this module keeps of it.
enum Value<'a> {
    Str(&'a [u8]),
    Bool(bool),
    Other,
}

/// Parse (and mostly skip) an `element_value`. Only top-level `s` and `Z` values are kept.
fn element_value<'a>(r: &mut Reader<'a>, pool: &Pool<'a>, depth: u32) -> Option<Value<'a>> {
    if depth > MAX_DEPTH {
        return None;
    }
    let tag = r.u1()?;
    match tag {
        b's' => Some(pool.utf8(r.u2()?).map_or(Value::Other, Value::Str)),
        b'Z' => Some(pool.int(r.u2()?).map_or(Value::Other, |v| Value::Bool(v != 0))),
        b'B' | b'C' | b'D' | b'F' | b'I' | b'J' | b'S' | b'c' => {
            r.skip(2)?;
            Some(Value::Other)
        }
        b'e' => {
            r.skip(4)?;
            Some(Value::Other)
        }
        b'@' => {
            skip_annotation(r, pool, depth + 1)?;
            Some(Value::Other)
        }
        b'[' => {
            let n = r.u2()?;
            for _ in 0..n {
                element_value(r, pool, depth + 1)?;
            }
            Some(Value::Other)
        }
        _ => None,
    }
}

fn skip_annotation<'a>(r: &mut Reader<'a>, pool: &Pool<'a>, depth: u32) -> Option<()> {
    r.skip(2)?; // type
    let pairs = r.u2()?;
    for _ in 0..pairs {
        r.skip(2)?;
        element_value(r, pool, depth)?;
    }
    Some(())
}

/// The first `ldc "…"` / `ldc_w "…"` immediately followed by `putfield <one of fields>` in a
/// method's `Code` attribute body. The code bytes are scanned for the pattern, not decoded, and
/// the `ldc` operand must be a String constant.
fn ldc_putfield(code_attr: &[u8], pool: &Pool, fields: &[u16]) -> Option<String> {
    let mut r = Reader { b: code_attr, pos: 0 };
    r.skip(4)?; // max_stack, max_locals
    let len = usize::try_from(r.u4()?).ok()?;
    let code = r.bytes(len)?;
    let u2 = |i: usize| -> Option<u16> { Some(u16::from_be_bytes([*code.get(i)?, *code.get(i + 1)?])) };
    for i in 0..code.len() {
        let (str_idx, put) = match code[i] {
            0x12 => (u16::from(*code.get(i + 1)?), i + 2),
            0x13 => (u2(i + 1)?, i + 3),
            _ => continue,
        };
        if code.get(put) != Some(&0xB5) || !fields.contains(&u2(put + 1)?) {
            continue;
        }
        if let Some(s) = pool.string(str_idx) {
            return Some(text(s));
        }
    }
    None
}

/// The `element_value` pairs of one annotation: string values by key, booleans by key.
type Pairs<'a> = Vec<(&'a [u8], Value<'a>)>;

fn annotation_pairs<'a>(a: &mut Reader<'a>, pool: &Pool<'a>) -> Option<Pairs<'a>> {
    let n = a.u2()?;
    let mut out = Vec::new();
    for _ in 0..n {
        let key = pool.utf8(a.u2()?).unwrap_or_default();
        out.push((key, element_value(a, pool, 1)?));
    }
    Some(out)
}

/// What `class` (a whole `.class` file) declares for legacy FML: a class-level `@Mod` with a
/// non-empty `modid` (the 1.13+ `@Mod("id")` form is ignored), an `@API` with a `provides`, and,
/// for a direct `DummyModContainer` subclass, the literal `ModMetadata` id / name / version it
/// sets. Anything malformed yields empty facts.
pub(crate) fn parse_class(class: &[u8], class_file: &str) -> ClassFacts {
    parse_class_inner(class, class_file).unwrap_or_default()
}

fn parse_class_inner(class: &[u8], class_file: &str) -> Option<ClassFacts> {
    let mut r = Reader { b: class, pos: 0 };
    if r.u4()? != 0xCAFE_BABE {
        return None;
    }
    r.skip(4)?; // minor, major
    let pool = read_pool(&mut r)?;
    let mod_desc = [(pool.find_utf8(MOD_DESC), false), (pool.find_utf8(MOD_DESC_CPW), true)];
    let api_desc = [pool.find_utf8(API_DESC), pool.find_utf8(API_DESC_CPW)];
    r.skip(4)?; // access_flags, this_class
    let super_name = pool.class_name(r.u2()?);
    let is_container = matches!(super_name, Some(DUMMY_CONTAINER) | Some(DUMMY_CONTAINER_CPW));
    let wants_annotations = mod_desc.iter().any(|(i, _)| *i != 0) || api_desc.iter().any(|i| *i != 0);
    if !wants_annotations && !is_container {
        return Some(ClassFacts::default());
    }
    let interfaces = usize::from(r.u2()?);
    r.skip(interfaces.checked_mul(2)?)?;
    r.members(None)?; // fields
    let mut code: Vec<&[u8]> = Vec::new();
    let code_name = pool.find_utf8(b"Code");
    r.members(if is_container && code_name != 0 { Some((&mut code, code_name)) } else { None })?;

    let mut facts = ClassFacts::default();
    if is_container {
        let pick = |field: &[u8]| -> String {
            let fields = pool.metadata_fields(field);
            if fields.is_empty() {
                return String::new();
            }
            code.iter().find_map(|c| ldc_putfield(c, &pool, &fields)).unwrap_or_default()
        };
        let mod_id = pick(b"modId");
        if !mod_id.trim().is_empty() {
            facts.container = Some(DummyContainer { class_file: class_file.to_string(), mod_id, name: pick(b"name"), version: pick(b"version") });
        }
    }
    // The class attributes are always walked, so a truncated class yields nothing at all.
    let attrs = r.u2()?;
    for _ in 0..attrs {
        let name = pool.utf8(r.u2()?);
        let len = usize::try_from(r.u4()?).ok()?;
        let body = r.bytes(len)?;
        if !wants_annotations || !matches!(name, Some(b"RuntimeVisibleAnnotations") | Some(b"RuntimeInvisibleAnnotations")) {
            continue;
        }
        let mut a = Reader { b: body, pos: 0 };
        let count = a.u2()?;
        for _ in 0..count {
            let ty = a.u2()?;
            let pairs = annotation_pairs(&mut a, &pool)?;
            let str_of = |k: &[u8]| -> String {
                pairs.iter().find_map(|(key, v)| match v {
                    Value::Str(s) if *key == k => Some(text(s)),
                    _ => None,
                })
                .unwrap_or_default()
            };
            let bool_of = |k: &[u8]| -> Option<bool> {
                pairs.iter().find_map(|(key, v)| match v {
                    Value::Bool(b) if *key == k => Some(*b),
                    _ => None,
                })
            };
            if let Some((_, cpw)) = mod_desc.iter().find(|(i, _)| *i != 0 && *i == ty) {
                let m = ModAnnotation {
                    class_file: class_file.to_string(),
                    cpw: *cpw,
                    modid: str_of(b"modid"),
                    name: str_of(b"name"),
                    version: str_of(b"version"),
                    dependencies: str_of(b"dependencies"),
                    accepted_minecraft_versions: str_of(b"acceptedMinecraftVersions"),
                    client_side_only: bool_of(b"clientSideOnly") == Some(true),
                    server_side_only: bool_of(b"serverSideOnly") == Some(true),
                    use_metadata: bool_of(b"useMetadata"),
                };
                if facts.mod_annotation.is_none() && !m.modid.trim().is_empty() {
                    facts.mod_annotation = Some(m);
                }
            } else if api_desc.iter().any(|i| *i != 0 && *i == ty) {
                let api = ApiAnnotation {
                    class_file: class_file.to_string(),
                    owner: str_of(b"owner"),
                    provides: str_of(b"provides"),
                    api_version: str_of(b"apiVersion"),
                };
                if facts.api.is_none() && !api.provides.trim().is_empty() {
                    facts.api = Some(api);
                }
            }
        }
    }
    Some(facts)
}

/// `acceptedMinecraftVersions` as FML 1.12.2 reads it: `[1.12]`, `[1.12.1]` and `[1.12,1.12.1]`
/// are widened to `[1.12,1.12.2]` (`FMLModContainer.bindMetadata`). Empty means "the running
/// version" (always accepted), so no range.
fn accepted_mc(raw: &str) -> Option<String> {
    match raw {
        "" => None,
        "[1.12]" | "[1.12.1]" | "[1.12,1.12.1]" => Some("[1.12,1.12.2]".to_string()),
        s if s.trim().is_empty() => None,
        s => Some(s.to_string()),
    }
}

/// Short human-readable rendering of the annotation for evidence display.
fn render(a: &ModAnnotation, notes: &[String]) -> String {
    let class = a.class_file.strip_suffix(".class").unwrap_or(&a.class_file).replace('/', ".");
    let pkg = if a.cpw { "cpw.mods.fml.common.Mod" } else { "net.minecraftforge.fml.common.Mod" };
    let mut lines = vec![format!("// {pkg} on {class}"), "@Mod(".to_string()];
    let mut fields: Vec<String> = Vec::new();
    for (k, v) in [
        ("modid", &a.modid),
        ("name", &a.name),
        ("version", &a.version),
        ("dependencies", &a.dependencies),
        ("acceptedMinecraftVersions", &a.accepted_minecraft_versions),
    ] {
        if !v.is_empty() {
            fields.push(format!("    {k} = {v:?}"));
        }
    }
    for (k, v) in [("clientSideOnly", a.client_side_only), ("serverSideOnly", a.server_side_only)] {
        if v {
            fields.push(format!("    {k} = true"));
        }
    }
    if let Some(v) = a.use_metadata {
        fields.push(format!("    useMetadata = {v}"));
    }
    let n = fields.len();
    for (i, f) in fields.into_iter().enumerate() {
        lines.push(if i + 1 < n { format!("{f},") } else { f });
    }
    lines.push(")".to_string());
    lines.extend(notes.iter().map(|n| format!("// {n}")));
    excerpt(&lines.join("\n"))
}

fn usable(s: &str) -> Option<&str> {
    let t = s.trim();
    (!t.is_empty() && !has_placeholder(t)).then_some(t)
}

/// Turn the `@Mod` annotations found in a jar into `ModMeta`, merged with the jar's entries.
///
/// Merge rule with `mcmod.info` (what legacy FML's `FMLModContainer.bindMetadata` does):
/// - The `@Mod` annotation is what makes a mod: an annotation with `modid` X replaces the
///   `mcmod.info` entry for X (if any), and the result's `metadata_file` is the annotated class
///   (e.g. `com/example/MyMod.class`), its excerpt a rendering of the annotation.
/// - **Name:** `mcmod.info` wins; the annotation's `name` is used when it has none.
/// - **Version:** the annotation's `version` (FML's `internalVersion`, which dependency checks
///   compare), else `mcmod.info`'s. A value with a `${…}` placeholder counts as absent.
/// - **Dependencies:** the annotation's `dependencies` string, unless the `mcmod.info` entry sets
///   `"useDependencyInformation": true` (and the annotation does not set `useMetadata = false`):
///   then FML uses the `mcmod.info` lists, which the `mcmod.info` parser already emitted.
/// - **Minecraft range:** always the annotation's `acceptedMinecraftVersions` (`mcmod.info`
///   `mcversion` is never enforced), with FML's `[1.12]` widening; also added to `deps` as a
///   required `minecraft` dependency, as the other formats do.
/// - **Environment:** `clientSideOnly` → client, `serverSideOnly` → server.
/// - `mcmod.info` entries without a matching annotation stay as they are (a coremod can still
///   register that id through its own mod container).
///
/// Then, for the other legacy FML mod sources:
/// - A coremod container id (`containers`) that no entry of the jar already declares becomes its
///   own entry (`metadata_file` = the container class; no dependencies, no ranges).
/// - An `@API` `provides` id (`apis`) is added to `provides` of the jar's legacy entry whose id is
///   the API's `owner`, else of its first legacy entry; a jar with no legacy entry gets nothing
///   (known gap). FML keeps one container per API, so this never creates a duplicate id.
///
/// `opted_in` lists the `mcmod.info` mod ids with `"useDependencyInformation": true`. Within one
/// jar the first annotation per `modid` wins. Annotation-only entries are appended in class order.
pub(crate) fn merge(
    mods: &mut Vec<ModMeta>,
    opted_in: &[String],
    annotations: Vec<ModAnnotation>,
    containers: Vec<DummyContainer>,
    apis: Vec<ApiAnnotation>,
    mcmod_file: &str,
) {
    let mut seen: Vec<String> = Vec::new();
    for a in annotations {
        let modid = a.modid.trim().to_string();
        if has_placeholder(&modid) || seen.contains(&modid) {
            continue;
        }
        seen.push(modid.clone());
        let info_idx = mods.iter().position(|m| m.metadata_file == mcmod_file && m.mod_id == modid);
        let info = info_idx.map(|i| mods[i].clone());
        let mut notes: Vec<String> = Vec::new();

        let info_name = info.as_ref().and_then(|m| m.name.clone()).filter(|n| !n.trim().is_empty());
        if info_name.is_some() && info_name.as_deref() != usable(&a.name) {
            notes.push("name from mcmod.info".to_string());
        }
        let name = info_name.or_else(|| usable(&a.name).map(str::to_string));
        let version = match usable(&a.version) {
            Some(v) => v.to_string(),
            None => info.as_ref().map(|m| m.version.clone()).unwrap_or_default(),
        };
        let mcmod_deps = info.is_some() && opted_in.contains(&modid) && a.use_metadata != Some(false);
        let mut deps: Vec<Dependency> = if mcmod_deps {
            notes.push("dependencies from mcmod.info (useDependencyInformation: true)".to_string());
            info.as_ref().map(|m| m.deps.clone()).unwrap_or_default()
        } else {
            parse_dependency_string(&a.dependencies)
        };
        let mc_range = accepted_mc(&a.accepted_minecraft_versions).map(|s| maven_range(Some(&s)));
        if let Some(r) = &mc_range {
            deps.retain(|d| d.mod_id != "minecraft");
            deps.insert(0, Dependency { mod_id: "minecraft".to_string(), kind: DependencyKind::Required, range: r.clone(), side: None });
        }
        let loader_range = deps
            .iter()
            .find(|d| d.mod_id.eq_ignore_ascii_case("forge") && !d.range.raw.is_empty())
            .map(|d| d.range.clone());
        let environment = match (a.client_side_only, a.server_side_only) {
            (true, false) => ModEnvironment::Client,
            (false, true) => ModEnvironment::Server,
            _ => ModEnvironment::Unknown,
        };
        let meta = ModMeta {
            mod_id: modid,
            version,
            name,
            loader: LoaderKind::Legacyforge,
            provides: Vec::new(),
            environment,
            mc_range,
            loader_range,
            language_loader: None,
            language_range: None,
            deps,
            metadata_file: a.class_file.clone(),
            metadata_excerpt: render(&a, &notes),
        };
        match info_idx {
            Some(i) => mods[i] = meta,
            None => mods.push(meta),
        }
    }

    for c in containers {
        let id = c.mod_id.trim().to_string();
        if has_placeholder(&id) || mods.iter().any(|m| m.mod_id == id) {
            continue;
        }
        let class = c.class_file.strip_suffix(".class").unwrap_or(&c.class_file).replace('/', ".");
        let mut lines = vec![format!("// coremod mod container {class} (extends DummyModContainer)"), format!("modId = {id:?}")];
        if !c.name.is_empty() {
            lines.push(format!("name = {:?}", c.name));
        }
        if !c.version.is_empty() {
            lines.push(format!("version = {:?}", c.version));
        }
        mods.push(ModMeta {
            mod_id: id,
            version: usable(&c.version).unwrap_or_default().to_string(),
            name: usable(&c.name).map(str::to_string),
            loader: LoaderKind::Legacyforge,
            provides: Vec::new(),
            environment: ModEnvironment::Unknown,
            mc_range: None,
            loader_range: None,
            language_loader: None,
            language_range: None,
            deps: Vec::new(),
            metadata_file: c.class_file.clone(),
            metadata_excerpt: excerpt(&lines.join("\n")),
        });
    }

    for api in apis {
        let provides = api.provides.trim().to_string();
        if has_placeholder(&provides) {
            continue;
        }
        let legacy = |m: &ModMeta| m.loader == LoaderKind::Legacyforge;
        let target = mods
            .iter()
            .position(|m| legacy(m) && m.mod_id == api.owner.trim())
            .or_else(|| mods.iter().position(legacy));
        let Some(t) = target else { continue };
        let m = &mut mods[t];
        if m.mod_id == provides || m.provides.contains(&provides) {
            continue;
        }
        m.provides.push(provides.clone());
        if m.metadata_file.ends_with(".class") {
            let note = format!("\n// also provides {provides:?} (@API in {}, apiVersion {:?})", api.class_file, api.api_version);
            m.metadata_excerpt = excerpt(&format!("{}{note}", m.metadata_excerpt));
        }
    }
}

/// Test helper: a minimal valid class file `class_name` (internal form, `a/b/C`) carrying one
/// class-level annotation of type `descriptor` with the given string and boolean elements, plus
/// one field, one method and an unrelated annotation, so the parser has to skip them.
#[cfg(test)]
pub(crate) fn build_class(class_name: &str, descriptor: &str, strings: &[(&str, &str)], bools: &[(&str, bool)], visible: bool) -> Vec<u8> {
    struct Pool {
        bytes: Vec<u8>,
        n: u16,
    }
    impl Pool {
        fn utf8(&mut self, s: &str) -> u16 {
            self.bytes.push(1);
            self.bytes.extend_from_slice(&(s.len() as u16).to_be_bytes());
            self.bytes.extend_from_slice(s.as_bytes());
            self.n += 1;
            self.n
        }
        fn raw(&mut self, b: &[u8], slots: u16) -> u16 {
            self.bytes.extend_from_slice(b);
            self.n += slots;
            self.n + 1 - slots
        }
    }
    let mut p = Pool { bytes: Vec::new(), n: 0 };
    p.raw(&[5, 0, 0, 0, 0, 0, 0, 0, 7], 2); // a Long (two slots)
    let this_name = p.utf8(class_name);
    let this_class = p.raw(&[7, (this_name >> 8) as u8, this_name as u8], 1);
    let obj = p.utf8("java/lang/Object");
    let super_class = p.raw(&[7, (obj >> 8) as u8, obj as u8], 1);
    let field_name = p.utf8("INSTANCE");
    let field_desc = p.utf8(&format!("L{class_name};"));
    let code = p.utf8("Code");
    let init = p.utf8("<init>");
    let void = p.utf8("()V");
    let attr = p.utf8(if visible { "RuntimeVisibleAnnotations" } else { "RuntimeInvisibleAnnotations" });
    let source = p.utf8("SourceFile");
    let other = p.utf8("Ljava/lang/Deprecated;");
    let ty = p.utf8(descriptor);
    let mut pairs: Vec<u8> = Vec::new();
    let mut n_pairs = 0u16;
    for (k, v) in strings {
        let k = p.utf8(k);
        let v = p.utf8(v);
        pairs.extend_from_slice(&k.to_be_bytes());
        pairs.push(b's');
        pairs.extend_from_slice(&v.to_be_bytes());
        n_pairs += 1;
    }
    for (k, v) in bools {
        let k = p.utf8(k);
        let v = p.raw(&[3, 0, 0, 0, u8::from(*v)], 1);
        pairs.extend_from_slice(&k.to_be_bytes());
        pairs.push(b'Z');
        pairs.extend_from_slice(&v.to_be_bytes());
        n_pairs += 1;
    }
    // An array element with a nested annotation, which the parser must skip.
    let arr_key = p.utf8("guiFactoryExtras");
    pairs.extend_from_slice(&arr_key.to_be_bytes());
    pairs.extend_from_slice(&[b'[', 0, 2, b'@']);
    pairs.extend_from_slice(&other.to_be_bytes());
    pairs.extend_from_slice(&[0, 0, b'I']);
    pairs.extend_from_slice(&3u16.to_be_bytes()); // points at the Class entry: only skipped
    n_pairs += 1;

    let mut b = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52];
    b.extend_from_slice(&(p.n + 1).to_be_bytes());
    b.extend_from_slice(&p.bytes);
    b.extend_from_slice(&[0, 0x21]);
    b.extend_from_slice(&this_class.to_be_bytes());
    b.extend_from_slice(&super_class.to_be_bytes());
    b.extend_from_slice(&[0, 0]); // interfaces
    // fields: one, with no attributes
    b.extend_from_slice(&[0, 1, 0, 0x19]);
    b.extend_from_slice(&field_name.to_be_bytes());
    b.extend_from_slice(&field_desc.to_be_bytes());
    b.extend_from_slice(&[0, 0]);
    // methods: one, with a (fake) Code attribute
    b.extend_from_slice(&[0, 1, 0, 1]);
    b.extend_from_slice(&init.to_be_bytes());
    b.extend_from_slice(&void.to_be_bytes());
    b.extend_from_slice(&[0, 1]);
    b.extend_from_slice(&code.to_be_bytes());
    b.extend_from_slice(&5u32.to_be_bytes());
    b.extend_from_slice(&[0, 1, 0, 1, 0xB1]);
    // class attributes: SourceFile, then the annotations
    let mut ann: Vec<u8> = Vec::new();
    ann.extend_from_slice(&[0, 2]);
    ann.extend_from_slice(&other.to_be_bytes()); // @Deprecated first, no pairs
    ann.extend_from_slice(&[0, 0]);
    ann.extend_from_slice(&ty.to_be_bytes());
    ann.extend_from_slice(&n_pairs.to_be_bytes());
    ann.extend_from_slice(&pairs);
    b.extend_from_slice(&[0, 2]);
    b.extend_from_slice(&source.to_be_bytes());
    b.extend_from_slice(&2u32.to_be_bytes());
    b.extend_from_slice(&this_name.to_be_bytes());
    b.extend_from_slice(&attr.to_be_bytes());
    b.extend_from_slice(&(ann.len() as u32).to_be_bytes());
    b.extend_from_slice(&ann);
    b
}

/// Test helper: a minimal valid class `class_name` extending `super_name` whose constructor does
/// `meta.<field> = "<value>"` (`aload_1; ldc "value"; putfield ModMetadata.<field>`) for each pair,
/// the first with `ldc`, the rest with `ldc_w`.
#[cfg(test)]
pub(crate) fn build_container_class(class_name: &str, super_name: &str, sets: &[(&str, &str)]) -> Vec<u8> {
    let mut pool: Vec<u8> = Vec::new();
    let mut n: u16 = 0;
    let mut utf8 = |pool: &mut Vec<u8>, s: &str| -> u16 {
        pool.push(1);
        pool.extend_from_slice(&(s.len() as u16).to_be_bytes());
        pool.extend_from_slice(s.as_bytes());
        n += 1;
        n
    };
    let this_name = utf8(&mut pool, class_name);
    let super_utf8 = utf8(&mut pool, super_name);
    let meta_utf8 = utf8(&mut pool, "net/minecraftforge/fml/common/ModMetadata");
    let code_name = utf8(&mut pool, "Code");
    let init = utf8(&mut pool, "<init>");
    let void = utf8(&mut pool, "()V");
    let string_desc = utf8(&mut pool, "Ljava/lang/String;");
    let mut refs: Vec<(u16, u16)> = Vec::new(); // (string index, fieldref index)
    let mut fields_utf8: Vec<(u16, u16)> = Vec::new();
    for (field, value) in sets {
        fields_utf8.push((utf8(&mut pool, field), utf8(&mut pool, value)));
    }
    // Non-Utf8 entries after the Utf8 ones (indices continue from `n`).
    let mut next = n;
    let mut push = |pool: &mut Vec<u8>, bytes: &[u8]| -> u16 {
        pool.extend_from_slice(bytes);
        next += 1;
        next
    };
    let be = |v: u16| v.to_be_bytes();
    let this_class = push(&mut pool, &[7, be(this_name)[0], be(this_name)[1]]);
    let super_class = push(&mut pool, &[7, be(super_utf8)[0], be(super_utf8)[1]]);
    let meta_class = push(&mut pool, &[7, be(meta_utf8)[0], be(meta_utf8)[1]]);
    for (name, value) in fields_utf8 {
        let nat = push(&mut pool, &[12, be(name)[0], be(name)[1], be(string_desc)[0], be(string_desc)[1]]);
        let field = push(&mut pool, &[9, be(meta_class)[0], be(meta_class)[1], be(nat)[0], be(nat)[1]]);
        let s = push(&mut pool, &[8, be(value)[0], be(value)[1]]);
        refs.push((s, field));
    }
    let mut code: Vec<u8> = Vec::new();
    for (i, (s, field)) in refs.iter().enumerate() {
        code.push(0x2B); // aload_1
        if i == 0 {
            code.extend_from_slice(&[0x12, *s as u8]);
        } else {
            code.push(0x13);
            code.extend_from_slice(&be(*s));
        }
        code.push(0xB5);
        code.extend_from_slice(&be(*field));
    }
    code.push(0xB1); // return
    let mut code_attr: Vec<u8> = vec![0, 2, 0, 2];
    code_attr.extend_from_slice(&(code.len() as u32).to_be_bytes());
    code_attr.extend_from_slice(&code);
    code_attr.extend_from_slice(&[0, 0, 0, 0]); // exception table, attributes

    let mut b = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52];
    b.extend_from_slice(&be(next + 1));
    b.extend_from_slice(&pool);
    b.extend_from_slice(&[0, 0x21]);
    b.extend_from_slice(&be(this_class));
    b.extend_from_slice(&be(super_class));
    b.extend_from_slice(&[0, 0, 0, 0]); // interfaces, fields
    b.extend_from_slice(&[0, 1, 0, 1]); // one public method
    b.extend_from_slice(&be(init));
    b.extend_from_slice(&be(void));
    b.extend_from_slice(&[0, 1]);
    b.extend_from_slice(&be(code_name));
    b.extend_from_slice(&(code_attr.len() as u32).to_be_bytes());
    b.extend_from_slice(&code_attr);
    b.extend_from_slice(&[0, 0]); // class attributes
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    const DESC: &str = "Lnet/minecraftforge/fml/common/Mod;";

    fn sample() -> Vec<u8> {
        build_class(
            "com/example/MyMod",
            DESC,
            &[("modid", "examplemod"), ("name", "Example"), ("version", "1.2"), ("dependencies", "required-after:forge@[14.23.5,);after:jei")],
            &[("clientSideOnly", true)],
            true,
        )
    }

    fn mod_of(b: &[u8], path: &str) -> Option<ModAnnotation> {
        parse_class(b, path).mod_annotation
    }

    #[test]
    fn reads_the_annotation() {
        let a = mod_of(&sample(), "com/example/MyMod.class").expect("annotation");
        assert_eq!(a.modid, "examplemod");
        assert_eq!(a.name, "Example");
        assert_eq!(a.version, "1.2");
        assert_eq!(a.dependencies, "required-after:forge@[14.23.5,);after:jei");
        assert!(a.client_side_only && !a.server_side_only && !a.cpw);
        assert_eq!(a.use_metadata, None);
        assert!(may_have_mod(&sample()));
    }

    #[test]
    fn invisible_annotations_and_cpw_descriptor() {
        let b = build_class("a/B", "Lcpw/mods/fml/common/Mod;", &[("modid", "old")], &[("useMetadata", false)], false);
        let a = mod_of(&b, "a/B.class").expect("annotation");
        assert!(a.cpw);
        assert_eq!(a.modid, "old");
        assert_eq!(a.use_metadata, Some(false));
    }

    #[test]
    fn other_annotations_and_modern_form_are_ignored() {
        let b = build_class("a/B", "Lnet/minecraftforge/fml/common/Mod$EventBusSubscriber;", &[("modid", "x")], &[], true);
        assert!(parse_class(&b, "a/B.class").is_empty());
        // 1.13+ `@Mod("id")`: no modid element.
        let b = build_class("a/B", DESC, &[("value", "modern")], &[], true);
        assert!(parse_class(&b, "a/B.class").is_empty());
        let b = build_class("a/B", DESC, &[("modid", "  ")], &[], true);
        assert!(parse_class(&b, "a/B.class").is_empty());
    }

    #[test]
    fn api_annotation() {
        for desc in ["Lnet/minecraftforge/fml/common/API;", "Lcpw/mods/fml/common/API;"] {
            let b = build_class("rtg/api/package-info", desc, &[("owner", "rtg"), ("provides", "rtgapi"), ("apiVersion", "1.0")], &[], true);
            let f = parse_class(&b, "rtg/api/package-info.class");
            assert_eq!(f.mod_annotation, None);
            let api = f.api.expect("api");
            assert_eq!((api.owner.as_str(), api.provides.as_str(), api.api_version.as_str()), ("rtg", "rtgapi", "1.0"));
        }
        let b = build_class("a/package-info", "Lnet/minecraftforge/fml/common/API;", &[("owner", "x")], &[], true);
        assert!(parse_class(&b, "a/package-info.class").is_empty(), "no provides");
    }

    #[test]
    fn dummy_mod_container() {
        let b = build_container_class("ivorius/ivtoolkit/IvToolkitCoreContainer", "net/minecraftforge/fml/common/DummyModContainer", &[("modId", "ivtoolkit"), ("version", "1.3.3"), ("name", "IvToolkit")]);
        let c = parse_class(&b, "ivorius/ivtoolkit/IvToolkitCoreContainer.class").container.expect("container");
        assert_eq!((c.mod_id.as_str(), c.version.as_str(), c.name.as_str()), ("ivtoolkit", "1.3.3", "IvToolkit"));
        let b = build_container_class("old/Core", "cpw/mods/fml/common/DummyModContainer", &[("modId", "oldcore")]);
        let c = parse_class(&b, "old/Core.class").container.expect("1.7.10 container");
        assert_eq!((c.mod_id.as_str(), c.version.as_str()), ("oldcore", ""));
        // Not a DummyModContainer subclass, or no literal modId: nothing.
        let b = build_container_class("a/Other", "java/lang/Object", &[("modId", "x")]);
        assert!(parse_class(&b, "a/Other.class").is_empty());
        let b = build_container_class("a/NoId", "net/minecraftforge/fml/common/DummyModContainer", &[("version", "1")]);
        assert!(parse_class(&b, "a/NoId.class").is_empty());
        // Truncations never panic and never invent an id.
        let good = build_container_class("a/C", "net/minecraftforge/fml/common/DummyModContainer", &[("modId", "c")]);
        for n in 0..good.len() {
            assert!(parse_class(&good[..n], "a/C.class").is_empty(), "truncated at {n}");
        }
    }

    #[test]
    fn truncated_and_garbage_input_never_panics() {
        let good = sample();
        for n in 0..good.len() {
            assert!(parse_class(&good[..n], "x.class").is_empty(), "truncated at {n}");
        }
        // Every single-byte corruption: any result, but no panic.
        for i in 0..good.len() {
            for v in [0x00, 0x01, 0x7F, 0xFF] {
                let mut b = good.clone();
                b[i] = v;
                let _ = parse_class(&b, "x.class");
            }
        }
        // Pseudo-random garbage after a valid magic.
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for len in [0usize, 10, 100, 1000, 10_000] {
            let mut b = vec![0xCA, 0xFE, 0xBA, 0xBE];
            for _ in 0..len {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                b.push(x as u8);
            }
            let _ = parse_class(&b, "x.class");
        }
        assert!(parse_class(b"not a class", "x.class").is_empty());
    }

    #[test]
    fn hostile_counts_do_not_allocate_or_recurse() {
        // Constant pool count 65535 with no entries behind it.
        let b = [0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52, 0xFF, 0xFF];
        assert!(parse_class(&b, "x.class").is_empty());
        // Deeply nested arrays inside @Mod: refused at MAX_DEPTH, no stack overflow.
        let mut b = build_class("a/B", DESC, &[("modid", "deep")], &[], true);
        let pos = b.windows(4).position(|w| w == [b'[', 0, 2, b'@']).expect("array");
        let mut nested = Vec::new();
        for _ in 0..100_000 {
            nested.extend_from_slice(&[b'[', 0, 1]);
        }
        nested.extend_from_slice(&[b'I', 0, 3]);
        b.splice(pos..pos + 1, nested.iter().copied()); // corrupts the lengths: must just fail
        let _ = parse_class(&b, "a/B.class");
    }

    #[test]
    fn accepted_mc_widening() {
        assert_eq!(accepted_mc("[1.12]").as_deref(), Some("[1.12,1.12.2]"));
        assert_eq!(accepted_mc("[1.12.1]").as_deref(), Some("[1.12,1.12.2]"));
        assert_eq!(accepted_mc("[1.12,1.12.1]").as_deref(), Some("[1.12,1.12.2]"));
        assert_eq!(accepted_mc("[1.12.2]").as_deref(), Some("[1.12.2]"));
        assert_eq!(accepted_mc(""), None);
        assert_eq!(accepted_mc("  "), None);
    }
}
