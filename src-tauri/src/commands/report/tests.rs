//! The testable parts of `save_report`: default-name sanitizing, extension enforcement and the
//! temp + rename write. The native dialog itself cannot be driven from tests.

use super::*;

const MD: ReportFormat = ReportFormat::Markdown;
const JSON: ReportFormat = ReportFormat::Json;

#[test]
fn default_names_are_sanitized() {
    let cases = [
        ("Better MC report", MD, "Better MC report.md"),
        ("Better MC report", JSON, "Better MC report.json"),
        ("report.md", MD, "report.md"),
        ("report.MD", MD, "report.md"),
        ("report.md", JSON, "report.md.json"),
        ("../../etc/passwd", MD, "-..-etc-passwd.md"),
        ("C:\\Users\\me\\x", MD, "C--Users-me-x.md"),
        ("a<b>c:d\"e|f?g*h", MD, "a-b-c-d-e-f-g-h.md"),
        ("tab\there\u{0}nul\nline", MD, "tabherenulline.md"),
        ("  .hidden. ", MD, "hidden.md"),
        ("CON", MD, "report-CON.md"),
        ("nul.txt", MD, "report-nul.txt.md"),
        ("com1", JSON, "report-com1.json"),
        ("", MD, "modpack-doctor-report.md"),
        ("...", JSON, "modpack-doctor-report.json"),
        ("///", MD, "---.md"),
        ("Pack ü 名前", MD, "Pack ü 名前.md"),
    ];
    for (input, format, want) in cases {
        assert_eq!(default_file_name(input, format), want, "{input:?}");
    }
}

#[test]
fn default_names_are_at_most_120_characters() {
    for format in [MD, JSON] {
        for input in ["x".repeat(500), "ü".repeat(300), format!("{}. . .", "a".repeat(200)), format!("{}.md", "名".repeat(200))] {
            let name = default_file_name(&input, format);
            assert!(name.chars().count() <= MAX_NAME_CHARS, "{} chars", name.chars().count());
            assert!(name.ends_with(&format!(".{}", extension(format))));
            assert!(!name.trim_end_matches(&format!(".{}", extension(format))).ends_with(['.', ' ']));
        }
    }
}

#[test]
fn extension_is_enforced() {
    let p = |s: &str| PathBuf::from(s);
    assert_eq!(enforce_extension(p("/d/report.md"), MD), p("/d/report.md"));
    assert_eq!(enforce_extension(p("/d/report.MD"), MD), p("/d/report.MD"));
    assert_eq!(enforce_extension(p("/d/report"), MD), p("/d/report.md"));
    assert_eq!(enforce_extension(p("/d/report.txt"), MD), p("/d/report.txt.md"));
    assert_eq!(enforce_extension(p("/d/report.md"), JSON), p("/d/report.md.json"));
    assert_eq!(enforce_extension(p("/d/report.json"), JSON), p("/d/report.json"));
}

fn entries(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> =
        fs::read_dir(dir).expect("read_dir").map(|e| e.expect("entry").file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[test]
fn writes_via_temp_and_rename_and_leaves_nothing_else() {
    let t = tempfile::tempdir().expect("tempdir");
    let dest = t.path().join("report.md");
    let saved = write_report(&dest, b"# Report\n", true).expect("write");
    assert_eq!(saved, dest);
    assert_eq!(fs::read(&dest).expect("read"), b"# Report\n");
    assert_eq!(entries(t.path()), vec!["report.md"]);

    // A confirmed replacement overwrites; an unconfirmed one is refused.
    write_report(&dest, b"v2", true).expect("replace");
    assert_eq!(fs::read(&dest).expect("read"), b"v2");
    let err = write_report(&dest, b"v3", false).expect_err("not confirmed");
    assert!(matches!(err, Error::Conflict(_)));
    assert_eq!(fs::read(&dest).expect("read"), b"v2");
    assert_eq!(entries(t.path()), vec!["report.md"]);
}

#[test]
fn refuses_folders_oversized_contents_and_bad_paths() {
    let t = tempfile::tempdir().expect("tempdir");
    let folder = t.path().join("x.md");
    fs::create_dir_all(&folder).expect("mkdir");
    assert!(matches!(write_report(&folder, b"x", true), Err(Error::Invalid(_))));

    let big = vec![b'a'; MAX_REPORT_BYTES + 1];
    assert!(matches!(write_report(&t.path().join("big.md"), &big, true), Err(Error::Invalid(_))));
    assert!(write_report(&t.path().join("max.md"), &big[..MAX_REPORT_BYTES], true).is_ok());

    assert!(write_report(Path::new("report.md"), b"x", true).is_err(), "a bare name has no folder");
    let missing = t.path().join("missing").join("r.md");
    assert!(write_report(&missing, b"x", true).is_err());
    assert_eq!(entries(t.path()), vec!["max.md", "x.md"], "no temp file is left behind");
}
