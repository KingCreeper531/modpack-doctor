//! Shared test infrastructure (compiled only for tests). FROZEN API (M1): agents may add
//! helpers in their own modules but must not change these signatures.

#![cfg(test)]

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;

/// Builds a jar (zip) in memory.
#[derive(Default, Clone)]
pub struct JarBuilder {
    entries: Vec<(String, Vec<u8>)>,
}

impl JarBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an arbitrary entry.
    pub fn file(mut self, path: &str, contents: impl AsRef<[u8]>) -> Self {
        self.entries.push((path.to_string(), contents.as_ref().to_vec()));
        self
    }

    /// Add a fake `.class` file with a valid magic + the given class-file major version
    /// (e.g. 61 = Java 17, 65 = Java 21). `path` like `com/example/Foo.class`.
    pub fn class(self, path: &str, major: u16) -> Self {
        let mut bytes = vec![0xCA, 0xFE, 0xBA, 0xBE, 0x00, 0x00];
        bytes.extend_from_slice(&major.to_be_bytes());
        self.file(path, bytes)
    }

    /// Embed another jar at `path` (e.g. `META-INF/jarjar/inner.jar`).
    pub fn nested(self, path: &str, inner: JarBuilder) -> Self {
        let bytes = inner.build();
        self.file(path, bytes)
    }

    pub fn fabric_mod_json(self, json: &str) -> Self {
        self.file("fabric.mod.json", json)
    }

    pub fn quilt_mod_json(self, json: &str) -> Self {
        self.file("quilt.mod.json", json)
    }

    pub fn mods_toml(self, toml: &str) -> Self {
        self.file("META-INF/mods.toml", toml)
    }

    pub fn neoforge_mods_toml(self, toml: &str) -> Self {
        self.file("META-INF/neoforge.mods.toml", toml)
    }

    pub fn mcmod_info(self, json: &str) -> Self {
        self.file("mcmod.info", json)
    }

    /// Serialize to zip bytes. Panics only on in-memory write failure (tests only).
    pub fn build(self) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (path, bytes) in self.entries {
            zip.start_file(path, opts).expect("start_file");
            zip.write_all(&bytes).expect("write entry");
        }
        zip.finish().expect("finish zip").into_inner()
    }

    /// Write to `dir/name` and return the full path.
    pub fn write_to(self, dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("create dir");
        let path = dir.join(name);
        std::fs::write(&path, self.build()).expect("write jar");
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_readable_zip_with_nested_jar() {
        let inner = JarBuilder::new().fabric_mod_json(r#"{"id":"inner","version":"1.0"}"#);
        let bytes = JarBuilder::new()
            .fabric_mod_json(r#"{"id":"outer","version":"2.0"}"#)
            .class("com/example/Foo.class", 65)
            .nested("META-INF/jars/inner.jar", inner)
            .build();
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).expect("valid zip");
        assert_eq!(z.len(), 3);
        let mut class = Vec::new();
        std::io::Read::read_to_end(&mut z.by_name("com/example/Foo.class").expect("entry"), &mut class)
            .expect("read");
        assert_eq!(&class[6..8], &65u16.to_be_bytes());
    }
}
