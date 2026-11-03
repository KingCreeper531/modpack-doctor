//! Scanner performance check. Run with:
//! `cargo test --release --lib scan::perf -- --ignored --nocapture`

use std::io::{Cursor, Write};
use std::time::Instant;

use rayon::prelude::*;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::*;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn fill(&mut self, n: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(n + 8);
        while v.len() < n {
            v.extend_from_slice(&self.next().to_le_bytes());
        }
        v.truncate(n);
        v
    }
}

/// A jar with `classes` classes (~1 KiB each, deflated), a stored random blob of `blob` bytes,
/// fabric metadata and optionally a nested jar.
fn make_jar(seed: u64, classes: usize, blob: usize, nested: Option<Vec<u8>>) -> Vec<u8> {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let jars = if nested.is_some() { r#","jars":[{"file":"META-INF/jars/inner.jar"}]"# } else { "" };
    let meta = format!(r#"{{"schemaVersion":1,"id":"mod{seed}","version":"1.0.{seed}","depends":{{"minecraft":"~1.20.1","fabricloader":">=0.15"}},"mixins":["mod{seed}.mixins.json"]{jars}}}"#);
    zip.start_file("fabric.mod.json", deflated).expect("start");
    zip.write_all(meta.as_bytes()).expect("write");
    for c in 0..classes {
        zip.start_file(format!("com/example/mod{seed}/pkg{}/C{c}.class", c % 12), deflated).expect("start");
        let mut body = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 61];
        let noise = rng.fill(256);
        for _ in 0..4 {
            body.extend_from_slice(&noise);
        }
        zip.write_all(&body).expect("write");
    }
    zip.start_file("assets/blob.bin", stored).expect("start");
    zip.write_all(&rng.fill(blob)).expect("write");
    if let Some(inner) = nested {
        zip.start_file("META-INF/jars/inner.jar", stored).expect("start");
        zip.write_all(&inner).expect("write");
    }
    zip.finish().expect("finish").into_inner()
}

#[test]
#[ignore = "performance; run in release with --ignored"]
fn perf_300_jars() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mods = tmp.path().join("mods");
    std::fs::create_dir_all(&mods).expect("mkdir");

    let t_gen = Instant::now();
    let total_bytes: u64 = (0..300u64)
        .into_par_iter()
        .map(|i| {
            // 0.75 – 2.25 MB, averaging ~1.5 MB.
            let blob = 750_000 + ((i * 7919) % 300) as usize * 5_000;
            let nested = (i % 5 == 0).then(|| make_jar(10_000 + i, 50, 100_000, None));
            let bytes = make_jar(i, 200, blob, nested);
            std::fs::write(mods.join(format!("mod-{i:03}.jar")), &bytes).expect("write");
            bytes.len() as u64
        })
        .sum();
    println!("generated 300 jars, {:.1} MB total, in {:?}", total_bytes as f64 / 1e6, t_gen.elapsed());

    let t = Instant::now();
    let res = scan_mods_dir(tmp.path(), "perf", |_| {}, |_| {}).expect("scan");
    let elapsed = t.elapsed();
    println!(
        "scan_mods_dir: {} records ({} top-level) in {:?} ({:.0} MB/s), {} rayon threads",
        res.jars.len(),
        res.jars.iter().filter(|r| r.depth == 0).count(),
        elapsed,
        total_bytes as f64 / 1e6 / elapsed.as_secs_f64(),
        rayon::current_num_threads()
    );
    assert_eq!(res.jars.iter().filter(|r| r.depth == 0).count(), 300);
    assert_eq!(res.jars.len(), 360);
    assert!(res.jars.iter().all(|r| r.status == JarStatus::Ok));
    assert!(res.jars.iter().filter(|r| r.depth == 0).all(|r| r.packages.len() == 12 && r.max_class_major == Some(61)));
    assert!(elapsed.as_secs_f64() < 5.0, "scan took {elapsed:?}");
}
