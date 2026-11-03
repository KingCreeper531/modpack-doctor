//! Incremental `latest.log` reader for watch mode.
//!
//! [`LogTail`] keeps a byte offset into the file and, on each [`LogTail::poll`], reads only the
//! bytes appended since (at most [`MAX_POLL_BYTES`] per poll; `more` says whether to poll again
//! right away). Every new *complete* line is decoded lossily (CR stripped) and matched against
//! the watch anchors (literal, case-sensitive substrings). A trailing partial line is kept until
//! its newline arrives; a line longer than [`MAX_LINE_BYTES`] is matched on its first bytes
//! and the rest is skipped.
//!
//! The file is never held open between polls (Windows would then block log4j's rotation), and
//! it is opened with the default std share mode (read, write and delete sharing).
//!
//! The file counts as *replaced* (new launch, log rotation) and is re-read from offset 0 when
//! its size drops below the offset, its creation time changes, or its first bytes differ from
//! the ones recorded (creation time alone is not enough on Windows, where file-system tunnelling
//! keeps the old creation time for a file recreated under the same name).
//!
//! Line numbers are 1-based in the current file. [`LogTail::start_at_end`] counts the lines
//! already present so later hits get their real line numbers.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::model::{AnchorTier, WatchAnchor};

/// Bytes read per poll at most.
pub const MAX_POLL_BYTES: u64 = 4 * 1024 * 1024;
/// Bytes of one line kept for matching.
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// Leading bytes compared to detect a replaced file.
const PREFIX_BYTES: usize = 64;
const COUNT_CHUNK: usize = 1024 * 1024;

/// A new line that contained an anchor (first hit per anchor per poll).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchorHit {
    pub anchor: String,
    pub tier: AnchorTier,
    /// 1-based line number in the current file.
    pub line: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TailPoll {
    pub hits: Vec<AnchorHit>,
    /// The file was replaced or truncated and re-read from the start.
    pub reset: bool,
    /// More unread bytes remain (the per-poll cap was hit).
    pub more: bool,
}

#[derive(Debug)]
pub struct LogTail {
    path: PathBuf,
    anchors: Vec<WatchAnchor>,
    /// Bytes consumed (complete lines + `pending`).
    offset: u64,
    /// Complete lines consumed so far.
    lines: u32,
    pending: Vec<u8>,
    /// The current line already exceeded `MAX_LINE_BYTES` and was matched; skip to its end.
    skipping: bool,
    /// Recorded identity of the file being read; `None` until it was seen.
    created: Option<SystemTime>,
    prefix: Vec<u8>,
    seen: bool,
}

impl LogTail {
    /// A tail that has not seen the file yet: the first poll that finds it reads it from 0.
    pub fn new(path: impl Into<PathBuf>, anchors: Vec<WatchAnchor>) -> Self {
        Self {
            path: path.into(),
            anchors: clean_anchors(anchors),
            offset: 0,
            lines: 0,
            pending: Vec::new(),
            skipping: false,
            created: None,
            prefix: Vec::new(),
            seen: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read from `path` from now on (watch mode passes the PathGuard-resolved path of
    /// `latest.log`). The read state is kept; if `path` is another file, the next poll sees it
    /// as replaced and reads it from the start.
    pub fn set_path(&mut self, path: impl Into<PathBuf>) {
        self.path = path.into();
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn set_anchors(&mut self, anchors: Vec<WatchAnchor>) {
        self.anchors = clean_anchors(anchors);
    }

    /// Skip what the file holds now (watch mode starts on a log of a past run): position after
    /// its last complete line and count the lines before it. A missing file is fine (the first
    /// poll that finds it then reads it from the start).
    pub fn start_at_end(&mut self) {
        self.reset_state();
        let Ok(mut f) = File::open(&self.path) else { return };
        let Ok(meta) = f.metadata() else { return };
        let mut buf = vec![0u8; COUNT_CHUNK];
        let (mut pos, mut lines, mut after_last_nl) = (0u64, 0u32, 0u64);
        while pos < meta.len() {
            let Ok(n) = f.read(&mut buf) else { return };
            if n == 0 {
                break;
            }
            for (i, b) in buf[..n].iter().enumerate() {
                if *b == b'\n' {
                    lines = lines.saturating_add(1);
                    after_last_nl = pos + i as u64 + 1;
                }
            }
            pos += n as u64;
        }
        self.offset = after_last_nl;
        self.lines = lines;
        self.created = meta.created().ok();
        self.prefix = read_prefix(&mut f).unwrap_or_default();
        self.seen = true;
    }

    fn reset_state(&mut self) {
        self.offset = 0;
        self.lines = 0;
        self.pending.clear();
        self.skipping = false;
        self.created = None;
        self.prefix.clear();
        self.seen = false;
    }

    /// Read what was appended since the last poll. I/O errors (file missing, permission) leave
    /// the state untouched and return nothing.
    pub fn poll(&mut self) -> TailPoll {
        let mut out = TailPoll::default();
        let Ok(mut f) = File::open(&self.path) else { return out };
        let Ok(meta) = f.metadata() else { return out };
        let size = meta.len();
        let created = meta.created().ok();
        if self.seen && self.replaced(&mut f, size, created) {
            self.reset_state();
            out.reset = true;
        }
        if !self.seen {
            self.seen = true;
            self.created = created;
        }
        if self.prefix.len() < PREFIX_BYTES && (size as usize) > self.prefix.len() {
            if let Some(p) = read_prefix(&mut f) {
                self.prefix = p;
            }
        }
        if size <= self.offset {
            return out;
        }
        let want = (size - self.offset).min(MAX_POLL_BYTES);
        out.more = size - self.offset > MAX_POLL_BYTES;
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return out;
        }
        let mut chunk = Vec::with_capacity(want as usize);
        if f.take(want).read_to_end(&mut chunk).is_err() {
            return out;
        }
        self.offset += chunk.len() as u64;
        let mut seen_anchors = HashSet::new();
        self.consume(&chunk, &mut out.hits, &mut seen_anchors);
        out
    }

    fn replaced(&self, f: &mut File, size: u64, created: Option<SystemTime>) -> bool {
        if size < self.offset || (size as usize) < self.prefix.len() {
            return true;
        }
        if let (Some(a), Some(b)) = (self.created, created) {
            if a != b {
                return true;
            }
        }
        if self.prefix.is_empty() {
            return false;
        }
        let mut head = vec![0u8; self.prefix.len()];
        let ok = f.seek(SeekFrom::Start(0)).is_ok() && f.read_exact(&mut head).is_ok();
        ok && head != self.prefix
    }

    fn consume(&mut self, chunk: &[u8], hits: &mut Vec<AnchorHit>, seen: &mut HashSet<String>) {
        let mut rest = chunk;
        while !rest.is_empty() {
            match rest.iter().position(|b| *b == b'\n') {
                Some(i) => {
                    if !self.skipping {
                        let room = MAX_LINE_BYTES.saturating_sub(self.pending.len());
                        self.pending.extend_from_slice(&rest[..i.min(room)]);
                        self.lines = self.lines.saturating_add(1);
                        self.match_line(self.lines, hits, seen);
                    } else {
                        self.lines = self.lines.saturating_add(1);
                    }
                    self.pending.clear();
                    self.skipping = false;
                    rest = &rest[i + 1..];
                }
                None => {
                    if !self.skipping {
                        let room = MAX_LINE_BYTES.saturating_sub(self.pending.len());
                        self.pending.extend_from_slice(&rest[..rest.len().min(room)]);
                        if self.pending.len() >= MAX_LINE_BYTES {
                            // Over-long line: match what we have now, skip the rest of it.
                            self.match_line(self.lines.saturating_add(1), hits, seen);
                            self.pending.clear();
                            self.skipping = true;
                        }
                    }
                    rest = &[];
                }
            }
        }
    }

    fn match_line(&self, line: u32, hits: &mut Vec<AnchorHit>, seen: &mut HashSet<String>) {
        if self.anchors.is_empty() {
            return;
        }
        let bytes = self.pending.strip_suffix(b"\r").unwrap_or(&self.pending);
        let text = String::from_utf8_lossy(bytes);
        for a in &self.anchors {
            if !seen.contains(&a.text) && text.contains(a.text.as_str()) {
                seen.insert(a.text.clone());
                hits.push(AnchorHit { anchor: a.text.clone(), tier: a.tier, line });
            }
        }
    }
}

fn read_prefix(f: &mut File) -> Option<Vec<u8>> {
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut buf = Vec::with_capacity(PREFIX_BYTES);
    f.take(PREFIX_BYTES as u64).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Drop empty anchors and duplicate texts (a text listed as both tiers counts as fatal).
pub fn clean_anchors(anchors: Vec<WatchAnchor>) -> Vec<WatchAnchor> {
    let mut out: Vec<WatchAnchor> = Vec::new();
    for a in anchors {
        if a.text.is_empty() {
            continue;
        }
        match out.iter_mut().find(|o| o.text == a.text) {
            Some(o) => {
                if a.tier == AnchorTier::Fatal {
                    o.tier = AnchorTier::Fatal;
                }
            }
            None => out.push(a),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn anchors() -> Vec<WatchAnchor> {
        vec![
            WatchAnchor { text: "Incompatible mods found!".into(), tier: AnchorTier::Fatal },
            WatchAnchor { text: "Caused by:".into(), tier: AnchorTier::Contextual },
            WatchAnchor { text: "".into(), tier: AnchorTier::Fatal },
        ]
    }

    fn append(path: &Path, bytes: &[u8]) {
        let mut f = fs::OpenOptions::new().create(true).append(true).open(path).expect("open");
        f.write_all(bytes).expect("write");
    }

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().expect("tempdir");
        let p = t.path().join("latest.log");
        (t, p)
    }

    #[test]
    fn reads_appended_lines_with_line_numbers() {
        let (_t, p) = setup();
        let mut tail = LogTail::new(&p, anchors());
        assert_eq!(tail.poll(), TailPoll::default(), "missing file");
        append(&p, b"[main/INFO]: start\n[main/ERROR]: Incompatible mods found!\n");
        let r = tail.poll();
        assert_eq!(r.hits, vec![AnchorHit { anchor: "Incompatible mods found!".into(), tier: AnchorTier::Fatal, line: 2 }]);
        assert!(!r.reset && !r.more);
        append(&p, b"x\nCaused by: java.lang.RuntimeException\n");
        let r = tail.poll();
        assert_eq!(r.hits, vec![AnchorHit { anchor: "Caused by:".into(), tier: AnchorTier::Contextual, line: 4 }]);
        assert!(tail.poll().hits.is_empty(), "nothing new");
    }

    #[test]
    fn start_at_end_skips_old_content_but_counts_lines() {
        let (_t, p) = setup();
        append(&p, b"Incompatible mods found!\nold\nCaused by: partial");
        let mut tail = LogTail::new(&p, anchors());
        tail.start_at_end();
        assert_eq!(tail.offset(), 29);
        // The partial last line is completed and matched with its real number.
        append(&p, b" thing\nIncompatible mods found!\n");
        let r = tail.poll();
        let lines: Vec<(String, u32)> = r.hits.iter().map(|h| (h.anchor.clone(), h.line)).collect();
        assert_eq!(lines, vec![("Caused by:".into(), 3), ("Incompatible mods found!".into(), 4)]);
    }

    #[test]
    fn partial_lines_wait_for_their_newline() {
        let (_t, p) = setup();
        let mut tail = LogTail::new(&p, anchors());
        append(&p, b"Incompatible mods");
        assert!(tail.poll().hits.is_empty());
        append(&p, b" found!");
        assert!(tail.poll().hits.is_empty());
        append(&p, b"\r\n");
        assert_eq!(tail.poll().hits.len(), 1);
    }

    #[test]
    fn crlf_and_invalid_utf8() {
        let (_t, p) = setup();
        let mut tail = LogTail::new(&p, anchors());
        append(&p, b"caf\xe9 \xff\xfe Caused by: x\r\nIncompatible mods found!\r\n");
        let r = tail.poll();
        assert_eq!(r.hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn truncation_restarts_at_zero() {
        let (_t, p) = setup();
        let mut tail = LogTail::new(&p, anchors());
        append(&p, b"line one is long enough\nline two is long enough\n");
        tail.poll();
        fs::write(&p, b"Incompatible mods found!\n").expect("truncate");
        let r = tail.poll();
        assert!(r.reset);
        assert_eq!(r.hits, vec![AnchorHit { anchor: "Incompatible mods found!".into(), tier: AnchorTier::Fatal, line: 1 }]);
    }

    #[test]
    fn rotation_to_a_larger_file_is_detected_by_its_first_bytes() {
        let (t, p) = setup();
        let mut tail = LogTail::new(&p, anchors());
        append(&p, b"[10:00:00] [main/INFO]: first run\n");
        tail.poll();
        // log4j renames the old file away and starts a new one that is already bigger.
        fs::rename(&p, t.path().join("2026-11-03-1.log")).expect("rename");
        let mut body = b"[10:05:00] [main/INFO]: second run\n".to_vec();
        body.extend_from_slice(&b"filler line\n".repeat(20));
        body.extend_from_slice(b"Incompatible mods found!\n");
        append(&p, &body);
        let r = tail.poll();
        assert!(r.reset);
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].line, 22);
    }

    #[test]
    fn first_hit_per_anchor_per_poll() {
        let (_t, p) = setup();
        let mut tail = LogTail::new(&p, anchors());
        append(&p, b"Caused by: a\nCaused by: b\nCaused by: c\n");
        assert_eq!(tail.poll().hits.len(), 1);
    }

    #[test]
    fn per_poll_reads_are_bounded() {
        let (_t, p) = setup();
        let mut tail = LogTail::new(&p, anchors());
        let filler = vec![b'a'; 1023];
        let mut body = Vec::new();
        for _ in 0..(5 * 1024) {
            body.extend_from_slice(&filler);
            body.push(b'\n');
        }
        body.extend_from_slice(b"Incompatible mods found!\n");
        append(&p, &body);
        let first = tail.poll();
        assert!(first.more && first.hits.is_empty());
        assert_eq!(tail.offset(), MAX_POLL_BYTES);
        let second = tail.poll();
        assert!(!second.more);
        assert_eq!(second.hits.len(), 1);
        assert_eq!(second.hits[0].line, 5 * 1024 + 1);
    }

    #[test]
    fn overlong_line_is_matched_on_its_start_and_counted_once() {
        let (_t, p) = setup();
        let mut tail = LogTail::new(&p, anchors());
        let mut body = b"Caused by: ".to_vec();
        body.extend_from_slice(&vec![b'z'; MAX_LINE_BYTES * 2]);
        body.extend_from_slice(b"\nIncompatible mods found!\n");
        append(&p, &body);
        let mut hits = Vec::new();
        loop {
            let r = tail.poll();
            hits.extend(r.hits);
            if !r.more {
                break;
            }
        }
        let lines: Vec<u32> = hits.iter().map(|h| h.line).collect();
        assert_eq!(lines, vec![1, 2]);
    }

    #[test]
    fn duplicate_anchor_texts_prefer_fatal() {
        let cleaned = clean_anchors(vec![
            WatchAnchor { text: "X".into(), tier: AnchorTier::Contextual },
            WatchAnchor { text: "X".into(), tier: AnchorTier::Fatal },
            WatchAnchor { text: "".into(), tier: AnchorTier::Fatal },
        ]);
        assert_eq!(cleaned, vec![WatchAnchor { text: "X".into(), tier: AnchorTier::Fatal }]);
    }
}
