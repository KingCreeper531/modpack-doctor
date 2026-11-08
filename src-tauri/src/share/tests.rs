//! mclo.gs client tests against wiremock (no real network) and the cut/scrub rules.

use std::fs;
use std::time::Duration;

use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::*;
use crate::error::ErrorKind;

const HOME: &str = r"C:\Users\Bob Smith";

fn ok_body(id: &str) -> serde_json::Value {
    serde_json::json!({
        "success": true,
        "id": id,
        "url": format!("https://mclo.gs/{id}"),
        "raw": format!("https://api.mclo.gs/1/raw/{id}"),
        "token": "secret-deletion-token",
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

// ── Preparing the text ─────────────────────────────────────────────────────────

#[test]
fn small_log_is_sent_whole_and_scrubbed() {
    let text = "[main/INFO]: Loading C:\\Users\\Bob Smith\\curseforge\\x\n[main/ERROR]: boom\n";
    let p = prepare(text.as_bytes(), 0, &HomeScrubber::new(Some(HOME)), MAX_BYTES, MAX_LINES);
    assert_eq!(p.content, "[main/INFO]: Loading ~\\curseforge\\x\n[main/ERROR]: boom\n");
    assert_eq!((p.total_lines, p.sent_lines, p.truncated), (2, 2, false));
}

#[test]
fn line_limit_keeps_the_end_and_says_so() {
    let text: String = (1..=10).map(|i| format!("line {i}\n")).collect();
    let p = prepare(text.as_bytes(), 0, &no_scrub(), MAX_BYTES, 5);
    let lines: Vec<&str> = p.content.lines().collect();
    assert_eq!(lines.len(), 5, "note + 4 lines fit the 5-line limit");
    assert_eq!(lines[0], cut_note(6));
    assert_eq!(&lines[1..], ["line 7", "line 8", "line 9", "line 10"]);
    assert_eq!((p.total_lines, p.sent_lines, p.truncated), (10, 4, true));
}

#[test]
fn byte_limit_keeps_the_end_and_says_so() {
    let text: String = (1..=100).map(|i| format!("{i:04} {}\n", "x".repeat(95))).collect();
    let max = cut_note(100).len() + 1 + 10 * 101;
    let p = prepare(text.as_bytes(), 0, &no_scrub(), max, MAX_LINES);
    assert!(p.content.len() <= max, "{} > {max}", p.content.len());
    assert!(p.truncated);
    assert_eq!(p.sent_lines, 10);
    assert!(p.content.starts_with("[Modpack Doctor] The first 90 lines"));
    assert!(p.content.ends_with(&format!("0100 {}\n", "x".repeat(95))));
}

#[test]
fn lines_already_skipped_by_the_reader_are_counted() {
    let p = prepare(b"a\nb\n", 1_000, &no_scrub(), MAX_BYTES, MAX_LINES);
    assert_eq!((p.total_lines, p.sent_lines, p.truncated), (1_002, 2, true));
    assert!(p.content.starts_with(&cut_note(1_000)));
}

#[test]
fn one_huge_line_keeps_its_end() {
    let line = format!("{}END", "a".repeat(5_000));
    let p = prepare(line.as_bytes(), 0, &no_scrub(), 1_000, MAX_LINES);
    assert!(p.truncated);
    assert!(p.content.len() <= 1_000);
    assert!(p.content.ends_with("END\n"));
}

#[test]
fn invalid_utf8_lines_are_read_as_windows_1252() {
    let p = prepare(b"ok\ncaf\xe9\n", 0, &no_scrub(), MAX_BYTES, MAX_LINES);
    assert_eq!(p.content, "ok\ncaf\u{e9}\n");
}

#[test]
fn read_tail_reads_only_the_end_of_a_large_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let f = dir.path().join("latest.log");
    let line = format!("{}\n", "y".repeat(1023));
    let lines = (READ_CAP as usize / line.len()) + 1_000;
    fs::write(&f, line.repeat(lines)).expect("write");
    let (bytes, skipped) = read_tail(&f).expect("read");
    assert!(bytes.len() as u64 <= READ_CAP);
    assert_eq!(skipped + (bytes.len() / line.len()) as u64, lines as u64, "every line counted once");
    assert!(bytes.starts_with(b"yyyy"), "starts on a line boundary");
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
            "success": true, "id": "WnMMikq", "url": "https://evil.example/x", "raw": "file:///etc/passwd"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let (url, raw) = client(&server).await.upload("hello\n").await.expect("upload");
    assert_eq!(url, "https://mclo.gs/WnMMikq");
    assert_eq!(raw, "https://api.mclo.gs/1/raw/WnMMikq");
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

    let shared = share_file(&client(&server).await, &f, Some(HOME)).await.expect("share");
    assert_eq!(shared.url, "https://mclo.gs/abc123");
    assert_eq!(shared.raw_url, "https://api.mclo.gs/1/raw/abc123");
    assert!(shared.truncated);
    assert_eq!(shared.total_lines as usize, MAX_LINES + 101);
    assert_eq!(shared.sent_lines as usize, MAX_LINES - 1);

    let sent = sent_content(&server).await;
    assert!(sent.lines().count() <= MAX_LINES);
    assert!(sent.len() <= MAX_BYTES);
    assert_eq!(sent.lines().next(), Some(cut_note(102).as_str()));
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
        (302, None, ShareError::BadAnswer),
    ] {
        let server = MockServer::start().await;
        let mut t = ResponseTemplate::new(status).set_body_string("<html>nope</html>");
        if let Some(r) = retry {
            t = t.insert_header("retry-after", r);
        }
        if status == 302 {
            t = t.insert_header("location", "https://evil.example/");
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

#[tokio::test]
async fn timeout_is_reported_as_such() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_body("late")).set_delay(Duration::from_secs(3)))
        .mount(&server)
        .await;
    let c = McLogs::with_base(&server.uri(), Duration::from_millis(300)).expect("client");
    assert_eq!(c.upload("x").await, Err(ShareError::Timeout));
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
    let err = share_file(&client(&server).await, &f, None).await.expect_err("empty");
    assert_eq!(err.kind, ErrorKind::Invalid);
}
