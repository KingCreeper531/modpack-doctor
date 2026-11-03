//! Small helpers shared by the metadata parsers.

use crate::model::{JarJarInfo, ModMeta, RangeSyntax, RawRange};

/// `ModMeta.metadata_excerpt` limit.
pub(crate) const EXCERPT_MAX: usize = 16 * 1024;

/// What one metadata file contributed to its jar.
#[derive(Debug, Default)]
pub(crate) struct Parsed {
    pub mods: Vec<ModMeta>,
    pub mixins: Vec<String>,
    pub nested: Vec<NestedDecl>,
}

/// A nested jar declared by the parent's metadata.
#[derive(Debug, Clone)]
pub(crate) struct NestedDecl {
    /// Entry path inside the parent, `/`-separated, no leading `/`.
    pub path: String,
    pub jarjar: Option<JarJarInfo>,
}

impl NestedDecl {
    pub fn plain(path: &str) -> Self {
        NestedDecl { path: clean_entry_path(path), jarjar: None }
    }
}

/// `\` → `/` and no leading `/` (zip entry names never start with one).
pub(crate) fn clean_entry_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches('/').to_string()
}

/// Decode metadata bytes: UTF-8 (lossy), BOM stripped.
pub(crate) fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// First ≤ 16 KiB of `text`, cut on a char boundary.
pub(crate) fn excerpt(text: &str) -> String {
    if text.len() <= EXCERPT_MAX {
        return text.to_string();
    }
    let mut end = EXCERPT_MAX;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// True when `s` still contains an unexpanded build-template placeholder (`${mod_id}`).
pub(crate) fn has_placeholder(s: &str) -> bool {
    s.contains("${")
}

/// The MetadataError reason for a mod id that is an unexpanded placeholder.
pub(crate) fn placeholder_id(field: &str, id: &str) -> String {
    format!("{field} \"{id}\" is an unexpanded build-template placeholder")
}

/// A range whose text still holds a `${…}` placeholder: unknown, kept verbatim.
pub(crate) fn placeholder_range(syntax: RangeSyntax, original: String) -> RawRange {
    RawRange { syntax, raw: Vec::new(), unrepresentable: Some(original) }
}

/// Maven range from a spec; a `${…}` placeholder makes it `unrepresentable` (original text).
pub(crate) fn maven_range(spec: Option<&str>) -> RawRange {
    if let Some(s) = spec.filter(|s| has_placeholder(s)) {
        return placeholder_range(RangeSyntax::Maven, s.to_string());
    }
    let raw = match spec.map(str::trim) {
        Some(s) if !s.is_empty() => vec![s.to_string()],
        _ => Vec::new(),
    };
    RawRange { syntax: RangeSyntax::Maven, raw, unrepresentable: None }
}

pub(crate) fn fabric_any() -> RawRange {
    RawRange { syntax: RangeSyntax::Fabric, raw: Vec::new(), unrepresentable: None }
}

/// Parse JSON leniently: JSON5 (comments, trailing commas, single quotes, unquoted keys),
/// BOM tolerated, and — as a fallback — raw control characters inside strings escaped
/// (many real `fabric.mod.json` / `mcmod.info` files contain literal newlines in strings).
pub(crate) fn parse_json_lenient(text: &str) -> Result<serde_json::Value, String> {
    let text = text.trim_start_matches('\u{feff}');
    match json5::from_str::<serde_json::Value>(text) {
        Ok(v) => Ok(v),
        Err(first) => {
            let fixed = escape_raw_controls(text);
            if fixed != text {
                if let Ok(v) = json5::from_str::<serde_json::Value>(&fixed) {
                    return Ok(v);
                }
            }
            Err(format!("invalid JSON: {first}"))
        }
    }
}

/// Escape literal `\n`, `\r`, `\t` that appear inside string literals. Comments are skipped so
/// an apostrophe in `// don't` does not open a string.
fn escape_raw_controls(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let mut chars = text.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => match c {
                '\\' => {
                    out.push(c);
                    if let Some(n) = chars.next() {
                        out.push(n);
                    }
                }
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                _ => {
                    if c == q {
                        quote = None;
                    }
                    out.push(c);
                }
            },
            None => match c {
                '"' | '\'' => {
                    quote = Some(c);
                    out.push(c);
                }
                '/' if chars.peek() == Some(&'/') => {
                    out.push(c);
                    for n in chars.by_ref() {
                        out.push(n);
                        if n == '\n' {
                            break;
                        }
                    }
                }
                '/' if chars.peek() == Some(&'*') => {
                    out.push(c);
                    if let Some(star) = chars.next() {
                        out.push(star);
                    }
                    let mut prev = '\0';
                    for n in chars.by_ref() {
                        out.push(n);
                        if prev == '*' && n == '/' {
                            break;
                        }
                        prev = n;
                    }
                }
                _ => out.push(c),
            },
        }
    }
    out
}

/// Strip a Quilt `mavenGroup:` prefix from a mod id.
pub(crate) fn strip_maven_group(id: &str) -> String {
    match id.rsplit_once(':') {
        Some((_, rest)) if !rest.is_empty() => rest.to_string(),
        _ => id.to_string(),
    }
}

/// Strings of a JSON value that is either a string or an array of strings.
pub(crate) fn string_or_array(v: Option<&serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(xs)) => xs.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_cuts_on_char_boundary() {
        let s = "ä".repeat(EXCERPT_MAX); // 2 bytes each
        let e = excerpt(&s);
        assert!(e.len() <= EXCERPT_MAX);
        assert_eq!(e.len(), EXCERPT_MAX);
        let s = format!("a{}", "€".repeat(EXCERPT_MAX)); // 1 + 3n bytes
        let e = excerpt(&s);
        assert!(e.len() <= EXCERPT_MAX && e.len() > EXCERPT_MAX - 3);
        assert_eq!(excerpt("short"), "short");
    }

    #[test]
    fn lenient_json_handles_raw_newlines_and_comments() {
        let v = parse_json_lenient("{\n // don't\n \"a\": \"line1\nline2\", /* x */ \"b\": 1,\n}").expect("parse");
        assert_eq!(v["a"], "line1\nline2");
        assert_eq!(v["b"], 1);
        assert!(parse_json_lenient("{ nope").is_err());
    }

    #[test]
    fn maven_group_is_stripped() {
        assert_eq!(strip_maven_group("org.quiltmc:qsl"), "qsl");
        assert_eq!(strip_maven_group("qsl"), "qsl");
    }
}
