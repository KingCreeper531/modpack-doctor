//! Input validation for everything that ends up in a URL, a request body or a file name.

use crate::error::{Error, Result};

fn is_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A SHA-1 hex digest, returned lower-cased.
pub(crate) fn sha1(s: &str) -> Result<String> {
    let t = s.trim();
    if t.len() == 40 && is_hex(t) {
        Ok(t.to_ascii_lowercase())
    } else {
        Err(Error::Invalid(format!("\"{}\" is not a SHA-1 hash (40 hex characters)", clip(s))))
    }
}

/// A SHA-512 hex digest, returned lower-cased.
pub(crate) fn sha512(s: &str) -> Result<String> {
    let t = s.trim();
    if t.len() == 128 && is_hex(t) {
        Ok(t.to_ascii_lowercase())
    } else {
        Err(Error::Invalid(format!("\"{}\" is not a SHA-512 hash (128 hex characters)", clip(s))))
    }
}

/// Modrinth project and version ids: exactly 8 base62 characters.
pub(crate) fn is_base62_id(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub(crate) fn version_id(s: &str) -> Result<()> {
    if is_base62_id(s) {
        Ok(())
    } else {
        Err(Error::Invalid(format!("\"{}\" is not a Modrinth version id (8 letters or digits)", clip(s))))
    }
}

/// A project id or slug (also used for loader mod-id guesses such as `cloth_config`).
pub(crate) fn id_or_slug(s: &str) -> Result<()> {
    // A leading dot also rules out `.`, `..` and all-dot names, which would act as URL path
    // segments in `/v2/project/{id}/version`.
    let ok = !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('.')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+'));
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(format!("\"{}\" is not a Modrinth project id or slug", clip(s))))
    }
}

/// A loader, game version or version type filter value.
pub(crate) fn filter_value(kind: &str, s: &str) -> Result<String> {
    let t = s.trim();
    let ok = !t.is_empty() && t.len() <= 64 && t.chars().all(|c| !c.is_control() && !c.is_whitespace());
    if ok {
        Ok(t.to_string())
    } else {
        Err(Error::Invalid(format!("\"{}\" is not a valid {kind}", clip(s))))
    }
}

pub(crate) fn version_type(s: &str) -> Result<String> {
    let t = s.trim().to_ascii_lowercase();
    if matches!(t.as_str(), "release" | "beta" | "alpha") {
        Ok(t)
    } else {
        Err(Error::Invalid(format!("\"{}\" is not a version type (release, beta or alpha)", clip(s))))
    }
}

/// A plain file name that is safe to create on Windows, macOS and Linux.
pub(crate) fn file_name(s: &str) -> Result<()> {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
        "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let bad_char = s.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let ok = !s.is_empty()
        && s.len() <= 200
        && !bad_char
        && !s.starts_with('.')
        && !s.ends_with('.')
        && !s.ends_with(' ')
        && !RESERVED.contains(&stem.as_str());
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(format!("\"{}\" is not a safe file name", clip(s))))
    }
}

/// Keep user-facing error messages short when the input is garbage.
fn clip(s: &str) -> String {
    let mut out: String = s.chars().filter(|c| !c.is_control()).take(48).collect();
    if s.chars().count() > 48 {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes() {
        assert_eq!(sha1(&"AB".repeat(20)).unwrap(), "ab".repeat(20));
        assert!(sha1("abc").is_err());
        assert!(sha1(&"zz".repeat(20)).is_err());
        assert!(sha512(&"0".repeat(128)).is_ok());
        assert!(sha512(&"0".repeat(127)).is_err());
    }

    #[test]
    fn ids() {
        assert!(is_base62_id("AANobbMI"));
        assert!(!is_base62_id("AANobbM"));
        assert!(!is_base62_id("../../x1"));
        assert!(version_id("OihdIimA").is_ok());
        assert!(id_or_slug("fabric-api").is_ok());
        assert!(id_or_slug("cloth_config").is_ok());
        assert!(id_or_slug("a/b").is_err());
        for dots in [".", "..", "...", ".hidden"] {
            assert!(id_or_slug(dots).is_err(), "{dots} accepted");
        }
        assert!(id_or_slug("mod.v2").is_ok());
        assert!(id_or_slug("").is_err());
    }

    #[test]
    fn file_names() {
        assert!(file_name("sodium-fabric-0.5.13+mc1.20.1.jar").is_ok());
        for bad in ["", "..", ".hidden", "a/b.jar", "a\\b.jar", "CON.jar", "nul", "x.jar.", "c:x.jar"] {
            assert!(file_name(bad).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn version_types() {
        assert_eq!(version_type("Release").unwrap(), "release");
        assert!(version_type("snapshot").is_err());
    }
}
