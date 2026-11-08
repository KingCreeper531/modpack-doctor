//! mclo.gs client tests against wiremock (no real network) and the cut/scrub/redact rules.

use std::fs;
use std::time::Duration;

use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::scrub::CredentialRedactor;
use super::*;
use crate::error::ErrorKind;

const HOME: &str = r"C:\Users\Bob Smith";

fn ok_body(id: &str) -> serde_json::Value {
    serde_json::json!({
        "success": true,
        "id": id,
        "url": format!("https://mclo.gs/{id}"),
        "raw": format!("https://api.mclo.gs/1/raw/{id}"),
        "token": format!("delete-token-{id}"),
    })
}

async fn client(server: &MockServer) -> McLogs {
    McLogs::with_base(&server.uri(), Duration::from_secs(5)).expect("client")
}

/// The `content` field of the one request the server received.
async fn sent_content(server: &MockServer) -> String {
    let reqs: Vec<Request> = server.received_requests().await.expect("recording");
    assert_eq!(reqs.len(), 1, "exactly one upload");
    let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).expect("json body");
    body["content"].as_str().expect("content").to_string()
}

fn no_scrub() -> HomeScrubber {
    HomeScrubber::new(None)
}

fn no_redact() -> CredentialRedactor {
    CredentialRedactor::new::<&str>(&[])
}

fn tail(bytes: &[u8], skipped: u64) -> Tail {
    Tail { bytes: bytes.to_vec(), skipped_lines: skipped, first_line_cut: false }
}

fn prep(bytes: &[u8], skipped: u64, max_bytes: usize, max_lines: usize) -> Prepared {
    prepare(&tail(bytes, skipped), &no_scrub(), &no_redact(), max_bytes, max_lines)
}

fn read_file_tail(f: &std::path::Path) -> Tail {
    read_tail(&mut File::open(f).expect("open")).expect("read")
}

// ── Preparing the text ─────────────────────────────────────────────────────────

#[test]
fn small_log_is_sent_whole_and_scrubbed() {
    let text = "[main/INFO]: Loading C:\\Users\\Bob Smith\\curseforge\\x\n[main/ERROR]: boom\n";
    let p = prepare(&tail(text.as_bytes(), 0), &HomeScrubber::new(Some(HOME)), &no_redact(), MAX_BYTES, MAX_LINES);
    assert_eq!(p.content, "[main/INFO]: Loading ~\\curseforge\\x\n[main/ERROR]: boom\n");
    assert_eq!((p.total_lines, p.sent_lines, p.truncated), (2, 2, false));
}

#[test]
fn a_log_exactly_at_the_limits_is_sent_whole() {
    let text: String = (1..=5).map(|i| format!("line {i}\n")).collect();
    let p = prep(text.as_bytes(), 0, text.len(), 5);
    assert_eq!(p.content, text);
    assert!(!p.truncated);
}

#[test]
fn line_limit_keeps_the_end_and_says_so() {
    let text: String = (1..=10).map(|i| format!("line {i}\n")).collect();
    let p = prep(text.as_bytes(), 0, MAX_BYTES, 5);
    let lines: Vec<&str> = p.content.lines().collect();
    assert_eq!(lines.len(), 5, "note + 4 lines fit the 5-line limit");
    assert_eq!(lines[0], cut_note(6, false));
    assert_eq!(&lines[1..], ["line 7", "line 8", "line 9", "line 10"]);
    assert_eq!((p.total_lines, p.sent_lines, p.truncated), (10, 4, true));
}

#[test]
fn byte_limit_keeps_the_end_and_says_so() {
    let text: String = (1..=100).map(|i| format!("{i:04} {}\n", "x".repeat(95))).collect();
    let max = cut_note(100, true).len() + 1 + 10 * 101;
    let p = prep(text.as_bytes(), 0, max, MAX_LINES);
    assert!(p.content.len() <= max, "{} > {max}", p.content.len());
    assert!(p.truncated);
    assert_eq!(p.sent_lines, 10);
    assert!(p.content.starts_with("[Modpack Doctor] The first 90 lines"));
    assert!(p.content.ends_with(&format!("0100 {}\n", "x".repeat(95))));
}

#[test]
fn lines_already_skipped_by_the_reader_are_counted() {
    let p = prep(b"a\nb\n", 1_000, MAX_BYTES, MAX_LINES);
    assert_eq!((p.total_lines, p.sent_lines, p.truncated), (1_002, 2, true));
    assert!(p.content.starts_with(&cut_note(1_000, false)));
}

/// L5: when the last line itself is cut, the note says the start of that line is missing.
#[test]
fn one_huge_line_keeps_its_end_and_the_note_says_the_line_was_cut() {
    let line = format!("{}END", "a".repeat(5_000));
    let p = prep(line.as_bytes(), 0, 1_000, MAX_LINES);
    assert!(p.truncated);
    assert!(p.content.len() <= 1_000);
    assert!(p.content.ends_with("END\n"));
    assert_eq!(p.content.lines().next(), Some(cut_note(0, true).as_str()));
    assert!(p.content.starts_with("[Modpack Doctor] The start of the line below was left out"));

    let p = prep(format!("first\nsecond\n{line}\n").as_bytes(), 0, 1_000, MAX_LINES);
    assert_eq!(p.content.lines().next(), Some(cut_note(2, true).as_str()));
    assert!(p.content.contains("The first 2 lines of this log and the start of the line below were left out"));
    assert_eq!((p.total_lines, p.sent_lines), (3, 1));
}

#[test]
fn notes_read_correctly() {
    assert!(cut_note(1, false).contains("The first line of this log was left out"));
    assert!(cut_note(7, false).contains("The first 7 lines of this log were left out"));
    assert!(cut_note(1, true).contains("The first line of this log and the start of the line below were left out"));
}

#[test]
fn invalid_utf8_lines_are_read_as_windows_1252() {
    let p = prep(b"ok\ncaf\xe9\n", 0, MAX_BYTES, MAX_LINES);
    assert_eq!(p.content, "ok\ncaf\u{e9}\n");
}

#[test]
fn read_tail_reads_only_the_end_of_a_large_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("latest.log");
    let line = format!("{}\n", "y".repeat(1023));
    let lines = (READ_CAP as usize / line.len()) + 1_000;
    fs::write(&f, line.repeat(lines)).expect("write");
    let t = read_file_tail(&f);
    assert!(t.bytes.len() as u64 <= READ_CAP);
    assert!(!t.first_line_cut);
    assert_eq!(t.skipped_lines + (t.bytes.len() / line.len()) as u64, lines as u64, "every line counted once");
    assert!(t.bytes.starts_with(b"yyyy"), "starts on a line boundary");
}

#[test]
fn read_tail_on_a_line_boundary_keeps_the_first_whole_line() {
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("latest.log");
    // The cut falls exactly after a line break: nothing is dropped from the tail.
    let head = "h\n".repeat(10);
    let body = "z".repeat(READ_CAP as usize - 1) + "\n";
    fs::write(&f, format!("{head}{body}")).expect("write");
    let t = read_file_tail(&f);
    assert_eq!((t.skipped_lines, t.first_line_cut, t.bytes.len() as u64), (10, false, READ_CAP));
}

/// L2: one line longer than READ_CAP is kept (its end), not turned into an empty log.
#[test]
fn read_tail_keeps_the_end_of_a_line_longer_than_the_cap() {
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("latest.log");
    let mut text = String::from("first\nsecond\n");
    text.push_str(&"q".repeat(READ_CAP as usize + 1_000));
    text.push_str("END\n");
    fs::write(&f, &text).expect("write");
    let t = read_file_tail(&f);
    assert!(t.first_line_cut);
    assert_eq!(t.skipped_lines, 2);
    assert_eq!(t.bytes.len() as u64, READ_CAP);
    assert!(t.bytes.ends_with(b"END\n"));
    let p = prepare(&t, &no_scrub(), &no_redact(), MAX_BYTES, MAX_LINES);
    assert!(p.content.ends_with("END\n"));
    assert!(p.content.len() <= MAX_BYTES);
    assert_eq!(p.content.lines().next(), Some(cut_note(2, true).as_str()));
    assert_eq!((p.total_lines, p.sent_lines, p.truncated), (3, 1, true));
}

/// L3: a file that grows while it is read still yields at most READ_CAP bytes.
#[test]
fn read_tail_never_returns_more_than_the_cap() {
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("latest.log");
    fs::write(&f, "a\n".repeat(10)).expect("write");
    let mut file = File::open(&f).expect("open");
    // Grow the file after it was opened and before it is read.
    fs::write(&f, "b\n".repeat(READ_CAP as usize)).expect("grow");
    let t = read_tail(&mut file).expect("read");
    assert!(t.bytes.len() as u64 <= READ_CAP);
}

// ── Credentials (H1) ──────────────────────────────────────────────────────────

const FAKE_JWT: &str = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ4dWlkIjoiMjUzNTQxMjM0NTY3ODkwMSJ9.ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Rz";
const FAKE_UUID: &str = "8d1f0c5e2b7a4d6c9e3f1a0b2c4d6e8f";
const FAKE_XUID: &str = "2535412345678901";
const FAKE_CLIENT_ID: &str = "c4b0f1e2-1a2b-4c3d-9e8f-001122334455";

fn hs_err_fixture() -> String {
    format!(
        "#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n\
         #  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb1c2d3e4f, pid=20516, tid=11234\n#\n\
         ---------------  S U M M A R Y ------------\n\n\
         Command Line: -Xmx4G -Djava.library.path=C:\\Users\\Joey Pterodactyl\\AppData\\Roaming\\.minecraft\\bin net.fabricmc.loader.impl.launch.knot.KnotClient \
         --username Steve --version fabric-loader-0.15.11-1.20.1 --gameDir C:\\Users\\Joey Pterodactyl\\AppData\\Roaming\\.minecraft \
         --uuid {FAKE_UUID} --accessToken {FAKE_JWT} --clientId {FAKE_CLIENT_ID} --xuid {FAKE_XUID} --userType msa\n\n\
         Host: Intel(R) Core(TM) i7-9700K, 8 cores, 31G,  Windows 10 , 64 bit Build 19041\n\n\
         Environment Variables:\n\
         JAVA_HOME=C:\\Program Files\\Java\\jdk-17\n\
         PATH=C:\\Windows\\system32;C:\\Users\\Joey Pterodactyl\\AppData\\Local\\Microsoft\\WindowsApps\n\
         USERNAME=Joey Pterodactyl\n\
         OS=Windows_NT\n\
         PROCESSOR_IDENTIFIER=Intel64 Family 6 Model 158 Stepping 13, GenuineIntel\n\n\
         [launcher] Session ID is token:{FAKE_JWT}:{FAKE_UUID} (Session ID is token:{FAKE_JWT}:{FAKE_UUID})\n\
         {{\"accessToken\": \"{FAKE_JWT}\", \"clientToken\": \"0123abcd\"}}\n"
    )
}

#[tokio::test]
async fn hs_err_tokens_ids_and_the_user_name_never_reach_the_server() {
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/1/log")).respond_with(ResponseTemplate::new(200).set_body_json(ok_body("hsErr1"))).mount(&server).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("hs_err_pid20516.log");
    fs::write(&f, hs_err_fixture()).expect("write");
    let home = r"C:\Users\Joey Pterodactyl";
    let names = vec!["Joey Pterodactyl".to_string()];
    share_file(&client(&server).await, &f, Some(home), &names).await.expect("share");

    let sent = sent_content(&server).await;
    for secret in [FAKE_JWT, FAKE_UUID, FAKE_XUID, FAKE_CLIENT_ID, "eyJ", "Joey", "Pterodactyl", "0123abcd"] {
        assert!(!sent.contains(secret), "{secret:?} was uploaded:\n{sent}");
    }
    // The player name and the crash itself stay readable.
    assert!(sent.contains("--username Steve --version fabric-loader-0.15.11-1.20.1"));
    assert!(sent.contains("--accessToken <redacted> --clientId <redacted> --xuid <redacted>"));
    assert!(sent.contains("--uuid <redacted>"));
    assert!(sent.contains("USERNAME=<redacted>\nOS=Windows_NT"));
    assert!(sent.contains("--gameDir ~\\AppData\\Roaming\\.minecraft"));
    assert!(sent.contains("(Session ID is token:<redacted>)"));
    assert!(sent.contains("EXCEPTION_ACCESS_VIOLATION"));
}

#[tokio::test]
async fn a_latest_log_with_a_player_name_stays_readable() {
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/1/log")).respond_with(ResponseTemplate::new(200).set_body_json(ok_body("latest1"))).mount(&server).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("latest.log");
    let log = "[12:00:00] [main/INFO]: Launching with args [--username, Steve, --version, 1.20.1, --accessToken, ????????, --uuid, 0123]\n\
               [12:00:01] [main/INFO]: Setting user: Steve\n\
               [12:00:05] [Render thread/ERROR]: Reported exception thrown!\n";
    fs::write(&f, log).expect("write");
    share_file(&client(&server).await, &f, Some(HOME), &["Bob Smith".to_string()]).await.expect("share");
    assert_eq!(
        sent_content(&server).await,
        "[12:00:00] [main/INFO]: Launching with args [--username, Steve, --version, 1.20.1, --accessToken, <redacted>, --uuid, <redacted>]\n\
         [12:00:01] [main/INFO]: Setting user: Steve\n\
         [12:00:05] [Render thread/ERROR]: Reported exception thrown!\n"
    );
}

#[test]
fn redaction_runs_before_the_cut_so_the_limits_hold() {
    let line = format!("--accessToken {FAKE_JWT}\n");
    let text = line.repeat(50);
    let r = CredentialRedactor::new::<&str>(&[]);
    let max = cut_note(50, true).len() + 1 + 10 * "--accessToken <redacted>\n".len();
    let p = prepare(&tail(text.as_bytes(), 0), &no_scrub(), &r, max, MAX_LINES);
    assert!(p.content.len() <= max);
    assert_eq!(p.sent_lines, 10);
    assert!(!p.content.contains("eyJ"));
}

// ── Uploading ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn success_posts_json_with_user_agent_and_builds_the_urls_from_the_id() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/1/log"))
        .and(header("user-agent", crate::USER_AGENT))
        .and(header("content-type", "application/json"))
        // A hostile answer: the URLs are never taken from it.
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "success": true, "id": "WnMMikq", "url": "https://evil.example/x", "raw": "file:///etc/passwd", "token": "tok"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let up = client(&server).await.upload("hello\n").await.expect("upload");
    assert_eq!(up.url, "https://mclo.gs/WnMMikq");
    assert_eq!(up.raw_url, "https://api.mclo.gs/1/raw/WnMMikq");
    assert_eq!((up.id.as_str(), up.token.as_deref()), ("WnMMikq", Some("tok")));
    assert_eq!(sent_content(&server).await, "hello\n");
}

#[tokio::test]
async fn share_file_scrubs_and_truncates_what_it_sends() {
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/1/log")).respond_with(ResponseTemplate::new(200).set_body_json(ok_body("abc123"))).mount(&server).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("latest.log");
    let mut text: String = (1..=MAX_LINES + 100).map(|i| format!("[main/INFO]: line {i}\n")).collect();
    text.push_str("[main/ERROR]: crashed in C:\\Users\\Bob Smith\\AppData\\Roaming\\.minecraft\n");
    fs::write(&f, &text).expect("write");

    let shared = share_file(&client(&server).await, &f, Some(HOME), &[]).await.expect("share");
    assert_eq!(shared.url, "https://mclo.gs/abc123");
    assert_eq!(shared.raw_url, "https://api.mclo.gs/1/raw/abc123");
    assert!(shared.truncated);
    assert_eq!(shared.total_lines as usize, MAX_LINES + 101);
    assert_eq!(shared.sent_lines as usize, MAX_LINES - 1);

    let sent = sent_content(&server).await;
    assert!(sent.lines().count() <= MAX_LINES);
    assert!(sent.len() <= MAX_BYTES);
    assert_eq!(sent.lines().next(), Some(cut_note(102, false).as_str()));
    assert!(sent.ends_with("[main/ERROR]: crashed in ~\\AppData\\Roaming\\.minecraft\n"), "the end is kept, home scrubbed");
    assert!(!sent.contains("Bob Smith"));
}

#[tokio::test]
async fn client_errors_carry_mclogs_message() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({"success": false, "error": "Required field 'content' is empty."})))
        .mount(&server)
        .await;
    let err = client(&server).await.upload("x").await.expect_err("400");
    assert_eq!(err, ShareError::Refused { status: 400, message: "Required field 'content' is empty".into() });
    let app: AppError = err.into();
    assert_eq!(app.message, "mclo.gs refused the upload (HTTP 400: Required field 'content' is empty). Nothing was uploaded.");
}

#[tokio::test]
async fn too_large_rate_limit_and_server_errors() {
    for (status, retry, expected) in [
        (413, None, ShareError::TooLarge),
        (429, Some("17"), ShareError::RateLimited { retry_after_s: 17 }),
        (429, None, ShareError::RateLimited { retry_after_s: 60 }),
        (500, None, ShareError::Server { status: 500 }),
        (503, None, ShareError::Server { status: 503 }),
    ] {
        let server = MockServer::start().await;
        let mut t = ResponseTemplate::new(status).set_body_string("<html>nope</html>");
        if let Some(r) = retry {
            t = t.insert_header("retry-after", r);
        }
        Mock::given(method("POST")).respond_with(t).mount(&server).await;
        let err = client(&server).await.upload("x").await.expect_err("error status");
        assert_eq!(err, expected, "HTTP {status}");
        let app: AppError = err.into();
        assert!(app.message.ends_with('.'), "{}", app.message);
    }
    let app: AppError = ShareError::RateLimited { retry_after_s: 17 }.into();
    assert_eq!((app.kind, app.retry_after_s), (ErrorKind::RateLimited, Some(17)));
}

/// L10: a redirect is an error, and its target is never contacted.
#[tokio::test]
async fn redirects_are_refused_and_never_followed() {
    for status in [301u16, 302, 303, 307, 308] {
        let target = MockServer::start().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_json(ok_body("evil"))).expect(0).mount(&target).await;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(status).insert_header("location", format!("{}/1/log", target.uri()).as_str()))
            .mount(&server)
            .await;
        assert_eq!(client(&server).await.upload("x").await, Err(ShareError::BadAnswer), "HTTP {status}");
        assert!(target.received_requests().await.expect("recording").is_empty(), "HTTP {status} followed");
    }
}

#[tokio::test]
async fn answers_without_a_plain_id_are_refused() {
    for body in [
        serde_json::json!({"success": true, "id": "../../x"}),
        serde_json::json!({"success": true, "id": ""}),
        serde_json::json!({"success": false, "id": "abc"}),
        serde_json::json!({"success": true}),
        serde_json::json!({"success": true, "id": "a".repeat(65)}),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_json(body.clone())).mount(&server).await;
        assert_eq!(client(&server).await.upload("x").await, Err(ShareError::BadAnswer), "{body}");
    }
    let server = MockServer::start().await;
    Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_string("not json")).mount(&server).await;
    assert_eq!(client(&server).await.upload("x").await, Err(ShareError::BadAnswer));
}

/// L4: at most 64 KiB of an answer is read; a huge answer is not JSON we accept.
#[tokio::test]
async fn huge_answers_are_read_only_in_part() {
    let server = MockServer::start().await;
    let mut body = serde_json::to_string(&ok_body("big")).expect("json");
    body.push_str(&" ".repeat(MAX_ANSWER_BYTES * 4));
    Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_string(body)).mount(&server).await;
    // The JSON value is complete within the first 64 KiB, trailing spaces are cut off.
    assert_eq!(client(&server).await.upload("x").await.map(|u| u.id), Ok("big".to_string()));

    let server = MockServer::start().await;
    let padded = serde_json::json!({"success": true, "pad": "p".repeat(MAX_ANSWER_BYTES * 2), "id": "late"});
    Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_json(padded)).mount(&server).await;
    assert_eq!(client(&server).await.upload("x").await, Err(ShareError::BadAnswer));
}

#[tokio::test]
async fn timeout_is_reported_as_maybe_uploaded() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body("late")).set_delay(Duration::from_secs(3)))
        .mount(&server)
        .await;
    let c = McLogs::with_base(&server.uri(), Duration::from_millis(300)).expect("client");
    let err = c.upload("x").await.expect_err("timeout");
    assert_eq!(err, ShareError::Timeout);
    let app: AppError = err.into();
    assert!(app.message.contains("may have been uploaded"), "{}", app.message);
    assert!(!app.message.contains("Nothing was uploaded"), "{}", app.message);
}

/// M5: the whole-request time grows with the body (1 s per 256 KiB), capped at 5 minutes.
#[test]
fn request_timeout_scales_with_the_body() {
    assert_eq!(request_timeout(BASE_TIMEOUT, 10), BASE_TIMEOUT);
    assert_eq!(request_timeout(BASE_TIMEOUT, 256 * 1024), BASE_TIMEOUT + Duration::from_secs(1));
    assert_eq!(request_timeout(BASE_TIMEOUT, MAX_BYTES), BASE_TIMEOUT + Duration::from_secs(40));
    assert_eq!(request_timeout(BASE_TIMEOUT, 1 << 30), MAX_TIMEOUT);
    assert_eq!(request_timeout(Duration::from_millis(300), 0), Duration::from_millis(300));
}

/// M5: a connection that breaks after it was made may have delivered the log.
#[tokio::test]
async fn a_connection_closed_mid_request_may_have_uploaded() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0u8; 64];
            let _ = sock.read(&mut buf).await;
            drop(sock);
        }
    });
    let c = McLogs::with_base(&format!("http://127.0.0.1:{port}"), Duration::from_secs(5)).expect("client");
    let err = c.upload(&"x".repeat(1024 * 1024)).await.expect_err("closed");
    assert_eq!(err, ShareError::Interrupted);
    let app: AppError = err.into();
    assert!(app.message.contains("may have been uploaded"), "{}", app.message);
}

#[tokio::test]
async fn no_connection_is_offline_with_a_clear_sentence() {
    // A port nothing listens on.
    let port = std::net::TcpListener::bind("127.0.0.1:0").expect("bind").local_addr().expect("addr").port();
    let c = McLogs::with_base(&format!("http://127.0.0.1:{port}"), Duration::from_secs(5)).expect("client");
    let err = c.upload("x").await.expect_err("refused");
    assert_eq!(err, ShareError::Offline);
    let app: AppError = err.into();
    assert_eq!(app.kind, ErrorKind::Offline);
    assert!(app.message.starts_with("Could not reach mclo.gs"), "{}", app.message);
}

#[tokio::test]
async fn empty_log_is_not_uploaded() {
    let server = MockServer::start().await;
    Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_json(ok_body("x"))).expect(0).mount(&server).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("latest.log");
    fs::write(&f, "\n  \n").expect("write");
    let err = share_file(&client(&server).await, &f, None, &[]).await.expect_err("empty");
    assert_eq!(err.kind, ErrorKind::Invalid);
}

// ── Deleting (M4) ──────────────────────────────────────────────────────────────

async fn share_one(server: &MockServer, id: &str) -> SharedLog {
    Mock::given(method("POST")).and(path("/1/log")).respond_with(ResponseTemplate::new(200).set_body_json(ok_body(id))).mount(server).await;
    let prepared = prep(b"hello\n", 0, MAX_BYTES, MAX_LINES);
    upload_prepared(&client(server).await, &prepared).await.expect("upload")
}

#[tokio::test]
async fn the_delete_token_is_kept_in_rust_and_used_once() {
    let server = MockServer::start().await;
    let shared = share_one(&server, "DelOk1").await;
    // The UI's result carries no token.
    let json = serde_json::to_string(&shared).expect("json");
    assert!(!json.contains("delete-token"), "{json}");
    assert!(has_delete_token("DelOk1"));

    Mock::given(method("DELETE"))
        .and(path("/1/log/DelOk1"))
        .and(header("authorization", "Bearer delete-token-DelOk1"))
        .and(header("user-agent", crate::USER_AGENT))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true})))
        .expect(1)
        .mount(&server)
        .await;
    delete_uploaded(&client(&server).await, "DelOk1").await.expect("delete");
    assert!(!has_delete_token("DelOk1"), "forgotten after the deletion");
    // A second delete has no token any more and sends nothing.
    let err = delete_uploaded(&client(&server).await, "DelOk1").await.expect_err("no token");
    assert_eq!(err.kind, ErrorKind::NotFound);
}

#[tokio::test]
async fn deleting_an_unknown_log_sends_nothing() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE")).respond_with(ResponseTemplate::new(200)).expect(0).mount(&server).await;
    for id in ["NeverUploaded", "../x", ""] {
        let err = delete_uploaded(&client(&server).await, id).await.expect_err("no token");
        assert_eq!(err.kind, ErrorKind::NotFound, "{id:?}");
        assert!(err.message.contains("90 days"), "{}", err.message);
    }
}

#[tokio::test]
async fn a_refused_delete_keeps_the_token_and_says_the_log_is_still_online() {
    let server = MockServer::start().await;
    share_one(&server, "DelNo1").await;
    Mock::given(method("DELETE"))
        .and(path("/1/log/DelNo1"))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({"success": false, "error": "Invalid token."})))
        .mount(&server)
        .await;
    let err = delete_uploaded(&client(&server).await, "DelNo1").await.expect_err("refused");
    assert_eq!(err.message, "mclo.gs refused to delete the log (HTTP 403: Invalid token), so it is still online.");
    assert!(has_delete_token("DelNo1"), "kept for another try");

    // 200 with success: false is a refusal too.
    let server = MockServer::start().await;
    share_one(&server, "DelNo2").await;
    Mock::given(method("DELETE"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": false, "error": "Invalid token."})))
        .mount(&server)
        .await;
    assert!(delete_uploaded(&client(&server).await, "DelNo2").await.is_err());
}

#[tokio::test]
async fn a_log_already_gone_counts_as_deleted() {
    let server = MockServer::start().await;
    share_one(&server, "DelGone1").await;
    Mock::given(method("DELETE")).and(path("/1/log/DelGone1")).respond_with(ResponseTemplate::new(404)).mount(&server).await;
    delete_uploaded(&client(&server).await, "DelGone1").await.expect("gone is deleted");
    assert!(!has_delete_token("DelGone1"));
}

#[tokio::test]
async fn unusable_tokens_are_not_kept() {
    for (id, token) in [("TokBad1", serde_json::json!("a b")), ("TokBad2", serde_json::json!("")), ("TokBad3", serde_json::json!(42))] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success": true, "id": id, "token": token})))
            .mount(&server)
            .await;
        let prepared = prep(b"hello\n", 0, MAX_BYTES, MAX_LINES);
        // A non-string token makes the answer unreadable; a bad string is dropped.
        let _ = upload_prepared(&client(&server).await, &prepared).await;
        assert!(!has_delete_token(id), "{id}");
    }
}
