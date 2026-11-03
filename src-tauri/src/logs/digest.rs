//! Bounded, streaming digest of a crash report, `latest.log`, `debug.log` or `hs_err_pid*.log`.
//!
//! Rust only *selects* lines; `src/core/crash` classifies them. The file is read line by line
//! through a `BufReader` in constant memory (the whole file is never loaded):
//!
//! - every line is read as bytes, CR-stripped, and matched against the TS anchor list *before*
//!   it is decoded or shortened. Decoding is UTF-8, falling back to Windows-1252 for lines that
//!   are not valid UTF-8 (old Windows consoles, mangled mod output);
//! - the first `head` lines are kept, a ring buffer keeps the last `max(tail, context)` lines
//!   for the tail and for the context *before* an anchor hit, and a countdown keeps `context`
//!   lines after it;
//! - structural blocks ([`LogBlock`]) are recognised with fixed prefixes and kept whole (each
//!   block has a line cap so one huge stack trace cannot eat the budget);
//! - selected lines are merged into non-overlapping chunks sorted by start line; each chunk
//!   carries the de-duplicated reasons of every window that touched it;
//! - `max_lines` is a hard cap: `head` and `tail` are reserved first, anchors and blocks share
//!   the rest. Matching never stops; when the budget is full the oldest anchor-only window is
//!   evicted (the oldest block window only when no anchor-only window is left; head never), so
//!   a crash near the end of a noisy log keeps its blocks. `truncated` is set when anything
//!   had to be dropped;
//! - options are clamped ([`clamp_options`]) because they arrive from the webview.
//!
//! Lines longer than `max_line_chars` are cut and suffixed with ` …[+N chars]`. A single line
//! longer than [`MAX_RAW_LINE_BYTES`] is only matched on its first 8 MiB; the remainder is
//! skipped without being buffered and counted (as bytes) in the suffix.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use crate::error::{Error, Result};
use crate::model::{ChunkReason, DigestOptions, LogBlock, LogChunk, LogDigest, LogSource};

const READ_BUF_BYTES: usize = 64 * 1024;
/// Bytes of a single line that are buffered and matched against anchors.
pub const MAX_RAW_LINE_BYTES: usize = 8 * 1024 * 1024;
/// Read size used while skipping the rest of an over-long line.
const SKIP_CHUNK_BYTES: u64 = 1024 * 1024;

/// Defaults documented on [`DigestOptions`].
pub fn default_options() -> DigestOptions {
    DigestOptions { head: 120, tail: 400, context: 12, max_lines: 6000, max_line_chars: 2000 }
}

/// Streams `path` and returns a bounded digest. `anchors` are literal, case-sensitive
/// substrings (from `src/core/crash/anchors.ts`); empty and duplicate anchors are ignored.
pub fn read_digest(
    path: &Path,
    source: LogSource,
    anchors: &[String],
    opts: &DigestOptions,
) -> Result<LogDigest> {
    let file = File::open(path).map_err(|e| Error::io(path, e))?;
    digest_reader(file, source, anchors, opts).map_err(|e| Error::io(path, e))
}

/// [`read_digest`] over any reader (tests, and watch mode on an already open handle).
pub fn digest_reader<R: Read>(
    reader: R,
    source: LogSource,
    anchors: &[String],
    opts: &DigestOptions,
) -> io::Result<LogDigest> {
    let mut lines = LineReader::new(reader);
    let mut digester = Digester::new(anchors, opts);
    let mut raw = Vec::new();
    while let Some(dropped) = lines.next_line(&mut raw)? {
        digester.push_line(&raw, dropped);
    }
    Ok(digester.finish(source))
}

// ---------------------------------------------------------------------------------------------
// Line reading and decoding

struct LineReader<R: Read> {
    inner: BufReader<R>,
    skip: Vec<u8>,
}

impl<R: Read> LineReader<R> {
    fn new(reader: R) -> Self {
        Self { inner: BufReader::with_capacity(READ_BUF_BYTES, reader), skip: Vec::new() }
    }

    /// Reads one line into `buf` without its `\n` / `\r\n` terminator. Returns `None` at end of
    /// file, otherwise the number of bytes dropped because the line exceeded the byte cap.
    fn next_line(&mut self, buf: &mut Vec<u8>) -> io::Result<Option<u64>> {
        buf.clear();
        let limit = MAX_RAW_LINE_BYTES as u64 + 1;
        let n = (&mut self.inner).take(limit).read_until(b'\n', buf)?;
        if n == 0 {
            return Ok(None);
        }
        let mut dropped = 0u64;
        if buf.last() == Some(&b'\n') {
            buf.pop();
        } else if n as u64 == limit {
            dropped += (buf.len() - MAX_RAW_LINE_BYTES) as u64;
            buf.truncate(MAX_RAW_LINE_BYTES);
            loop {
                self.skip.clear();
                let m = (&mut self.inner).take(SKIP_CHUNK_BYTES).read_until(b'\n', &mut self.skip)?;
                if m == 0 {
                    break;
                }
                if self.skip.ends_with(b"\r\n") {
                    dropped += (m - 2) as u64;
                    break;
                }
                if self.skip.last() == Some(&b'\n') {
                    dropped += (m - 1) as u64;
                    break;
                }
                dropped += m as u64;
            }
        }
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        Ok(Some(dropped))
    }
}

/// UTF-8 when valid; Windows-1252 for lines with invalid UTF-8. A sequence cut off at the very
/// end (a line truncated at a byte cap) is decoded lossily instead.
fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(e) if e.error_len().is_none() => String::from_utf8_lossy(bytes).into_owned(),
        Err(_) => encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes).0.into_owned(),
    }
}

/// Cuts `text` to `max_chars` chars and appends ` …[+N chars]`, where N counts the cut chars
/// plus `dropped` (bytes that were never decoded).
fn clip(mut text: String, max_chars: usize, dropped: u64) -> String {
    if text.len() <= max_chars && dropped == 0 {
        return text;
    }
    let mut extra = dropped;
    if let Some((cut, _)) = text.char_indices().nth(max_chars) {
        extra += text[cut..].chars().count() as u64;
        text.truncate(cut);
    }
    if extra > 0 {
        text.push_str(&format!(" …[+{extra} chars]"));
    }
    text
}

fn is_blank(line: &[u8]) -> bool {
    line.iter().all(|b| b.is_ascii_whitespace())
}

fn trim_indent(line: &[u8]) -> &[u8] {
    let start = line.iter().position(|b| *b != b'\t' && *b != b' ').unwrap_or(line.len());
    &line[start..]
}

// ---------------------------------------------------------------------------------------------
// Anchor matching: a 2-byte prefix table, so each line is scanned once regardless of how many
// anchors there are.

struct AnchorMatcher {
    anchors: Vec<String>,
    /// Indexed by the anchor's first two bytes; value = bucket index + 1 (0 = no anchor).
    table: Vec<u32>,
    buckets: Vec<Vec<usize>>,
    /// One-byte anchors.
    short: Vec<usize>,
}

fn pair(a: u8, b: u8) -> usize {
    (usize::from(a) << 8) | usize::from(b)
}

impl AnchorMatcher {
    fn new(anchors: &[String]) -> Self {
        let mut list: Vec<String> = Vec::new();
        for a in anchors {
            if !a.is_empty() && !list.contains(a) {
                list.push(a.clone());
            }
        }
        let mut table = vec![0u32; 1 << 16];
        let mut buckets: Vec<Vec<usize>> = Vec::new();
        let mut short = Vec::new();
        for (i, a) in list.iter().enumerate() {
            let b = a.as_bytes();
            if b.len() < 2 {
                short.push(i);
                continue;
            }
            let key = pair(b[0], b[1]);
            if table[key] == 0 {
                buckets.push(Vec::new());
                table[key] = buckets.len() as u32;
            }
            let bucket = table[key] as usize - 1;
            buckets[bucket].push(i);
        }
        Self { anchors: list, table, buckets, short }
    }

    /// Indices (sorted, distinct) of the anchors contained in `line`.
    fn find(&self, line: &[u8], out: &mut Vec<usize>) {
        out.clear();
        if self.anchors.is_empty() {
            return;
        }
        for &i in &self.short {
            let b = self.anchors[i].as_bytes()[0];
            if line.contains(&b) {
                out.push(i);
            }
        }
        if line.len() >= 2 {
            for pos in 0..line.len() - 1 {
                let slot = self.table[pair(line[pos], line[pos + 1])];
                if slot == 0 {
                    continue;
                }
                for &i in &self.buckets[slot as usize - 1] {
                    if !out.contains(&i) && line[pos..].starts_with(self.anchors[i].as_bytes()) {
                        out.push(i);
                    }
                }
            }
        }
        out.sort_unstable();
    }
}

// ---------------------------------------------------------------------------------------------
// Structural blocks

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// `---- Minecraft Crash Report ----` … `A detailed walkthrough of the error`.
    CrashHead,
    /// Forge `Suspected Mod(s):` up to `Stacktrace:`.
    Suspected,
    /// Forge `-- MOD x --` / NeoForge `-- Mod loading issue for: x --` up to a blank line.
    LoadingSection,
    /// `Caused by:` + frames up to a blank line, a new log record or the next `Caused by`.
    CausedBy,
    /// `-- System Details --` up to a blank line.
    SystemDetails,
    /// `\tMod List:` / `\tFabric Mods:` / `\tQuilt Mods:` and their `\t\t` entries.
    TabbedModList,
    /// Quilt report `-- Mod Table --` (older `-- Mods --`).
    QuiltModTable,
    /// Fabric/Quilt latest.log `Loading N mods:` and its `\t- id version` tree.
    LoadingModsLine,
    /// hs_err `#` header block.
    HsErr,
}

impl Shape {
    fn block(self) -> LogBlock {
        match self {
            Shape::CrashHead => LogBlock::CrashHead,
            Shape::Suspected | Shape::LoadingSection => LogBlock::SuspectedMods,
            Shape::CausedBy => LogBlock::CausedByChain,
            Shape::SystemDetails => LogBlock::SystemDetails,
            Shape::TabbedModList | Shape::QuiltModTable | Shape::LoadingModsLine => LogBlock::ModList,
            Shape::HsErr => LogBlock::HsErrHeader,
        }
    }

    /// Maximum lines kept per block instance.
    fn cap(self) -> u32 {
        match self {
            Shape::CrashHead => 300,
            Shape::Suspected => 200,
            Shape::LoadingSection => 150,
            Shape::CausedBy => 60,
            Shape::SystemDetails => 2000,
            Shape::TabbedModList | Shape::QuiltModTable | Shape::LoadingModsLine => 1500,
            Shape::HsErr => 80,
        }
    }

    fn starts(line: &[u8]) -> Option<Shape> {
        let trimmed = trim_indent(line);
        if line.starts_with(b"---- Minecraft Crash Report ----") {
            Some(Shape::CrashHead)
        } else if line.starts_with(b"Suspected Mod") {
            Some(Shape::Suspected)
        } else if line.starts_with(b"-- MOD ") || line.starts_with(b"-- Mod loading issue") {
            Some(Shape::LoadingSection)
        } else if trimmed.starts_with(b"Caused by") {
            Some(Shape::CausedBy)
        } else if line.starts_with(b"-- System Details --") {
            Some(Shape::SystemDetails)
        } else if trimmed.starts_with(b"Mod List:")
            || trimmed.starts_with(b"Fabric Mods:")
            || trimmed.starts_with(b"Quilt Mods:")
        {
            Some(Shape::TabbedModList)
        } else if line.starts_with(b"-- Mod Table --") || line.starts_with(b"-- Mods --") {
            Some(Shape::QuiltModTable)
        } else if is_loading_mods_line(line) {
            Some(Shape::LoadingModsLine)
        } else if line.starts_with(b"# A fatal error has been detected by the Java Runtime Environment")
            || line.starts_with(b"# There is insufficient memory for the Java Runtime Environment")
        {
            Some(Shape::HsErr)
        } else {
            None
        }
    }

    /// `line` is not part of the block (checked for lines after the start line).
    fn ends_before(self, line: &[u8]) -> bool {
        match self {
            Shape::CrashHead => false,
            Shape::Suspected => {
                is_blank(line) || line.starts_with(b"Stacktrace:") || line.starts_with(b"-- ")
            }
            Shape::LoadingSection => is_blank(line) || line.starts_with(b"-- "),
            Shape::CausedBy => {
                is_blank(line) || line.starts_with(b"[") || trim_indent(line).starts_with(b"Caused by")
            }
            Shape::SystemDetails => is_blank(line) || line.starts_with(b"#@!@#"),
            Shape::TabbedModList => !line.starts_with(b"\t\t"),
            Shape::QuiltModTable => line.starts_with(b"-- ") || line.starts_with(b"----"),
            Shape::LoadingModsLine => !line.starts_with(b"\t"),
            Shape::HsErr => !line.starts_with(b"#"),
        }
    }

    /// `line` is the last line of the block.
    fn ends_after(self, line: &[u8]) -> bool {
        self == Shape::CrashHead && line.starts_with(b"A detailed walkthrough of the error")
    }
}

/// `… Loading 245 mods:` (Fabric/Quilt startup).
fn is_loading_mods_line(line: &[u8]) -> bool {
    if !line.ends_with(b" mods:") {
        return false;
    }
    let Some(pos) = line.windows(8).rposition(|w| w == b"Loading ") else {
        return false;
    };
    let digits = &line[pos + 8..line.len() - b" mods:".len()];
    !digits.is_empty() && digits.iter().all(u8::is_ascii_digit)
}

// ---------------------------------------------------------------------------------------------
// Option clamping

/// Upper bounds for options coming from the webview; they keep memory constant whatever the UI
/// sends (the ring holds `max(tail, context)` lines of up to `4 * max_line_chars` bytes).
pub const MAX_HEAD: u32 = 2_000;
pub const MAX_TAIL: u32 = 2_000;
pub const MAX_CONTEXT: u32 = 100;
pub const MAX_MAX_LINES: u32 = 20_000;
pub const MAX_LINE_CHARS: u32 = 8_000;

/// `opts` with every field clamped to the bounds above.
pub fn clamp_options(opts: &DigestOptions) -> DigestOptions {
    DigestOptions {
        head: opts.head.min(MAX_HEAD),
        tail: opts.tail.min(MAX_TAIL),
        context: opts.context.min(MAX_CONTEXT),
        max_lines: opts.max_lines.min(MAX_MAX_LINES),
        max_line_chars: opts.max_line_chars.min(MAX_LINE_CHARS),
    }
}

// ---------------------------------------------------------------------------------------------
// Selection

struct ActiveBlock {
    shape: Shape,
    remaining: u32,
}

/// A run of consecutive selected lines and the reasons that selected them.
struct Window {
    start: u32,
    lines: Vec<String>,
    reasons: Vec<ChunkReason>,
    /// Holds head lines: never evicted.
    head: bool,
    /// Holds structural-block lines: evicted only when no anchor-only window is left.
    block: bool,
    /// Lines counted against the middle budget.
    middle: u32,
}

impl Window {
    fn end(&self) -> u32 {
        self.start + self.lines.len() as u32 - 1
    }
}

fn add_reason(reasons: &mut Vec<ChunkReason>, reason: &ChunkReason) {
    if !reasons.contains(reason) {
        reasons.push(reason.clone());
    }
}

#[derive(Default)]
struct RingLine {
    no: u32,
    raw: Vec<u8>,
    dropped: u64,
}

struct Digester {
    matcher: AnchorMatcher,
    head: u32,
    tail: u32,
    context: u32,
    max_line_chars: usize,
    /// Bytes of a line kept in the ring (enough for `max_line_chars` chars of UTF-8).
    ring_keep: usize,
    middle_budget: u32,
    middle_used: u32,
    head_tail_clipped: bool,
    truncated: bool,
    line_no: u32,
    ring: VecDeque<RingLine>,
    ring_cap: usize,
    windows: VecDeque<Window>,
    last_selected: u32,
    blocks: Vec<ActiveBlock>,
    countdown: u32,
    /// Anchor reasons of the window currently being extended (hit line + countdown).
    open_anchors: Vec<ChunkReason>,
    hits: Vec<usize>,
}

impl Digester {
    fn new(anchors: &[String], opts: &DigestOptions) -> Self {
        let requested = opts;
        let opts = clamp_options(opts);
        let head = opts.head.min(opts.max_lines);
        let tail = opts.tail.min(opts.max_lines - head);
        let max_line_chars = opts.max_line_chars as usize;
        Self {
            matcher: AnchorMatcher::new(anchors),
            head,
            tail,
            context: opts.context,
            max_line_chars,
            ring_keep: max_line_chars.saturating_mul(4).saturating_add(4),
            middle_budget: opts.max_lines - head - tail,
            middle_used: 0,
            head_tail_clipped: head < requested.head || tail < requested.tail,
            truncated: false,
            line_no: 0,
            ring: VecDeque::new(),
            ring_cap: tail.max(opts.context) as usize,
            windows: VecDeque::new(),
            last_selected: 0,
            blocks: Vec::new(),
            countdown: 0,
            open_anchors: Vec::new(),
            hits: Vec::new(),
        }
    }

    /// Frees budget by dropping the oldest window that is not the one being built: an anchor-only
    /// window if there is one, else the oldest block window (head windows are never dropped). So
    /// benign hits early in a long log cannot starve the crash near its end.
    fn evict(&mut self) -> bool {
        self.truncated = true;
        let candidates = self.windows.len().saturating_sub(1);
        let pick = self
            .windows
            .iter()
            .take(candidates)
            .position(|w| !w.head && !w.block && w.middle > 0)
            .or_else(|| self.windows.iter().take(candidates).position(|w| !w.head && w.middle > 0));
        match pick.and_then(|i| self.windows.remove(i)) {
            Some(w) => {
                self.middle_used -= w.middle;
                true
            }
            None => false,
        }
    }

    /// Adds a line (in file order) with the reasons that selected it. Returns false when there is
    /// no budget left even after eviction.
    fn select(&mut self, no: u32, text: String, reasons: &[ChunkReason], block: bool) -> bool {
        if no <= self.last_selected {
            if let Some(w) = self.windows.back_mut().filter(|w| no >= w.start) {
                for r in reasons {
                    add_reason(&mut w.reasons, r);
                }
                w.block |= block;
            }
            return true;
        }
        let middle = no > self.head;
        if middle {
            while self.middle_used >= self.middle_budget {
                if !self.evict() {
                    return false;
                }
            }
            self.middle_used += 1;
        }
        let extend = self.windows.back().is_some_and(|w| w.end() + 1 == no);
        if !extend {
            self.windows.push_back(Window {
                start: no,
                lines: Vec::new(),
                reasons: Vec::new(),
                head: false,
                block: false,
                middle: 0,
            });
        }
        let head = self.head;
        let Some(w) = self.windows.back_mut() else {
            return false;
        };
        w.lines.push(text);
        if no <= head {
            w.head = true;
            add_reason(&mut w.reasons, &ChunkReason::Head);
        }
        for r in reasons {
            add_reason(&mut w.reasons, r);
        }
        w.block |= block;
        if middle {
            w.middle += 1;
        }
        self.last_selected = no;
        true
    }

    fn push_line(&mut self, raw: &[u8], dropped: u64) {
        self.line_no = self.line_no.saturating_add(1);
        let no = self.line_no;
        let mut want = no <= self.head;

        // Structural blocks.
        self.blocks.retain(|b| !b.shape.ends_before(raw));
        if let Some(shape) = Shape::starts(raw) {
            if !self.blocks.iter().any(|b| b.shape == shape) {
                self.blocks.push(ActiveBlock { shape, remaining: shape.cap() });
            }
        }
        let in_block = !self.blocks.is_empty();
        want |= in_block;

        // Anchors (matched on every line: eviction keeps the budget for the newest windows).
        let mut hits = std::mem::take(&mut self.hits);
        self.matcher.find(raw, &mut hits);
        if hits.is_empty() {
            if self.countdown > 0 {
                self.countdown -= 1;
                want = true;
            }
        } else {
            for &h in &hits {
                let reason = ChunkReason::Anchor { anchor: self.matcher.anchors[h].clone() };
                add_reason(&mut self.open_anchors, &reason);
            }
            self.countdown = self.context;
            want = true;
            let from = no.saturating_sub(self.context).max(1);
            let skip = self.ring.len().saturating_sub(self.context as usize);
            let before: Vec<(u32, String)> = self
                .ring
                .iter()
                .skip(skip)
                .filter(|r| r.no >= from && r.no > self.last_selected)
                .map(|r| (r.no, clip(decode(&r.raw), self.max_line_chars, r.dropped)))
                .collect();
            let reasons = self.open_anchors.clone();
            for (n, text) in before {
                if !self.select(n, text, &reasons, false) {
                    break;
                }
            }
        }
        self.hits = hits;

        if want {
            let mut reasons = self.open_anchors.clone();
            for b in &self.blocks {
                add_reason(&mut reasons, &ChunkReason::Block { block: b.shape.block() });
            }
            let text = clip(decode(raw), self.max_line_chars, dropped);
            self.select(no, text, &reasons, in_block);
        }

        for b in &mut self.blocks {
            b.remaining = b.remaining.saturating_sub(1);
        }
        self.blocks.retain(|b| b.remaining > 0 && !b.shape.ends_after(raw));
        if self.countdown == 0 {
            self.open_anchors.clear();
        }

        if self.ring_cap > 0 {
            let mut slot = if self.ring.len() >= self.ring_cap {
                self.ring.pop_front().unwrap_or_default()
            } else {
                RingLine::default()
            };
            let keep = raw.len().min(self.ring_keep);
            slot.no = no;
            slot.raw.clear();
            slot.raw.extend_from_slice(&raw[..keep]);
            slot.dropped = dropped + (raw.len() - keep) as u64;
            self.ring.push_back(slot);
        }
    }

    fn finish(self, source: LogSource) -> LogDigest {
        let total = self.line_no;
        let mut truncated = self.truncated;
        let mut windows: Vec<Window> = self.windows.into_iter().collect();
        let tail_from = (self.tail > 0 && total > 0).then(|| total.saturating_sub(self.tail) + 1);
        if let Some(tail_from) = tail_from {
            let ranges: Vec<(u32, u32)> = windows.iter().map(|w| (w.start, w.end())).collect();
            for r in self.ring.iter().filter(|r| r.no >= tail_from) {
                let i = ranges.partition_point(|&(_, end)| end < r.no);
                let covered = ranges.get(i).is_some_and(|&(start, _)| start <= r.no);
                if !covered {
                    let text = clip(decode(&r.raw), self.max_line_chars, r.dropped);
                    windows.push(Window {
                        start: r.no,
                        lines: vec![text],
                        reasons: Vec::new(),
                        head: false,
                        block: false,
                        middle: 0,
                    });
                }
            }
            windows.sort_by_key(|w| w.start);
        }

        let mut chunks: Vec<LogChunk> = Vec::new();
        for w in windows {
            match chunks.last_mut() {
                Some(c) if c.start_line + c.lines.len() as u32 == w.start => {
                    c.lines.extend(w.lines);
                    for r in &w.reasons {
                        add_reason(&mut c.reasons, r);
                    }
                }
                _ => chunks.push(LogChunk { start_line: w.start, lines: w.lines, reasons: w.reasons }),
            }
        }
        if let Some(tail_from) = tail_from {
            for c in chunks.iter_mut().rev() {
                if c.start_line + (c.lines.len() as u32) <= tail_from {
                    break;
                }
                add_reason(&mut c.reasons, &ChunkReason::Tail);
            }
        }
        let kept: usize = chunks.iter().map(|c| c.lines.len()).sum();
        // Requested head/tail were shortened to fit max_lines and lines were left out.
        if self.head_tail_clipped && (kept as u64) < u64::from(total) {
            truncated = true;
        }
        LogDigest { source, total_lines: total, truncated, chunks }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LogKind;
    use std::io::Write;
    use std::time::Instant;

    fn source() -> LogSource {
        LogSource { id: "logs/latest.log".into(), kind: LogKind::LatestLog, modified_ms: 0, size: 0 }
    }

    fn opts(head: u32, tail: u32, context: u32, max_lines: u32) -> DigestOptions {
        DigestOptions { head, tail, context, max_lines, max_line_chars: 2000 }
    }

    fn anchors(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn digest(text: &[u8], list: &[&str], o: &DigestOptions) -> LogDigest {
        digest_reader(text, source(), &anchors(list), o).unwrap()
    }

    fn filler(lines: &mut String, from: u32, to: u32) {
        for i in from..=to {
            lines.push_str(&format!("[12:00:00] [main/INFO]: filler line {i}\n"));
        }
    }

    fn line(d: &LogDigest, n: u32) -> Option<&str> {
        d.chunks.iter().find_map(|c| {
            let i = n.checked_sub(c.start_line)? as usize;
            c.lines.get(i).map(String::as_str)
        })
    }

    fn chunk_of(d: &LogDigest, n: u32) -> Option<&LogChunk> {
        d.chunks.iter().find(|c| n >= c.start_line && n < c.start_line + c.lines.len() as u32)
    }

    fn ranges(d: &LogDigest) -> Vec<(u32, u32)> {
        d.chunks.iter().map(|c| (c.start_line, c.start_line + c.lines.len() as u32 - 1)).collect()
    }

    fn line_count(d: &LogDigest) -> usize {
        d.chunks.iter().map(|c| c.lines.len()).sum()
    }

    fn block(b: LogBlock) -> ChunkReason {
        ChunkReason::Block { block: b }
    }

    fn assert_invariants(d: &LogDigest, max_lines: u32) {
        assert!(line_count(d) <= max_lines as usize, "{} > {max_lines}", line_count(d));
        for w in d.chunks.windows(2) {
            let end = w[0].start_line + w[0].lines.len() as u32;
            assert!(end < w[1].start_line, "chunks overlap or touch: {:?}", ranges(d));
        }
        for c in &d.chunks {
            assert!(!c.lines.is_empty());
            assert!(!c.reasons.is_empty(), "chunk without reason at {}", c.start_line);
        }
    }

    #[test]
    fn defaults_match_documented_values() {
        let o = default_options();
        assert_eq!((o.head, o.tail, o.context, o.max_lines, o.max_line_chars), (120, 400, 12, 6000, 2000));
    }

    #[test]
    fn head_and_tail_only() {
        let mut s = String::new();
        filler(&mut s, 1, 1000);
        let d = digest(s.as_bytes(), &["NEVER"], &opts(10, 20, 3, 100));
        assert_eq!(d.total_lines, 1000);
        assert!(!d.truncated);
        assert_eq!(ranges(&d), vec![(1, 10), (981, 1000)]);
        assert_eq!(d.chunks[0].reasons, vec![ChunkReason::Head]);
        assert_eq!(d.chunks[1].reasons, vec![ChunkReason::Tail]);
        assert_eq!(line(&d, 1000), Some("[12:00:00] [main/INFO]: filler line 1000"));
        assert_invariants(&d, 100);
    }

    #[test]
    fn anchor_windows_and_merging() {
        let mut s = String::new();
        filler(&mut s, 1, 99);
        s.push_str("[12:00:00] [main/ERROR]: Mixin apply failed a.mixins.json:M -> X\n"); // 100
        filler(&mut s, 101, 104);
        s.push_str("Caused by: java.lang.NullPointerException\n"); // 105
        filler(&mut s, 106, 199);
        s.push_str("Caused by: java.lang.IllegalStateException\n"); // 200
        filler(&mut s, 201, 300);
        let d = digest(s.as_bytes(), &["Mixin apply failed", "NullPointer", "IllegalState"], &opts(0, 0, 3, 1000));
        // 97..108 (two overlapping windows, plus the CausedBy block ends at the next record)
        // and 197..203.
        assert_eq!(ranges(&d), vec![(97, 108), (197, 203)]);
        let r = &d.chunks[0].reasons;
        assert!(r.contains(&ChunkReason::Anchor { anchor: "Mixin apply failed".into() }));
        assert!(r.contains(&ChunkReason::Anchor { anchor: "NullPointer".into() }));
        assert!(r.contains(&block(LogBlock::CausedByChain)));
        assert!(d.chunks[1].reasons.contains(&ChunkReason::Anchor { anchor: "IllegalState".into() }));
        assert!(!d.chunks[1].reasons.contains(&ChunkReason::Anchor { anchor: "NullPointer".into() }));
        assert_invariants(&d, 1000);
    }

    #[test]
    fn adjacent_windows_merge_and_repeated_anchor_is_listed_once() {
        let mut s = String::new();
        for i in 1..=60u32 {
            if i == 20 || i == 27 {
                s.push_str("boom here\n");
            } else {
                s.push_str(&format!("plain {i}\n"));
            }
        }
        let d = digest(s.as_bytes(), &["boom", "boom"], &opts(0, 0, 3, 1000));
        // 17..23 and 24..30 touch → one chunk.
        assert_eq!(ranges(&d), vec![(17, 30)]);
        assert_eq!(d.chunks[0].reasons, vec![ChunkReason::Anchor { anchor: "boom".into() }]);
    }

    #[test]
    fn anchors_at_first_and_last_line() {
        let mut s = String::from("ERROR first\n");
        filler(&mut s, 2, 99);
        s.push_str("ERROR last");
        let d = digest(s.as_bytes(), &["ERROR"], &opts(0, 0, 3, 1000));
        assert_eq!(d.total_lines, 100);
        assert_eq!(ranges(&d), vec![(1, 4), (97, 100)]);
        assert_eq!(line(&d, 100), Some("ERROR last"));
        assert_eq!(line(&d, 1), Some("ERROR first"));
    }

    #[test]
    fn crash_report_blocks() {
        let report = "\
---- Minecraft Crash Report ----
// Who set us up the TNT?

Time: 2026-05-16 21:27:12
Description: Ticking block entity

java.lang.NullPointerException: Cannot invoke \"Object.toString()\"
\tat com.example.cool.Foo.bar(Foo.java:12) ~[coolmod-1.2.3.jar%23187!/:1.2.3] {re:classloading}
\tat net.minecraft.world.level.Level.tick(Level.java:1) ~[client-1.20.1-srg.jar%23302!/:?]
Caused by: java.lang.IllegalStateException: inner
\tat com.example.cool.Bar.baz(Bar.java:3)
\t... 4 more


A detailed walkthrough of the error, its code path and all known details is as follows:
---------------------------------------------------------------------------------------

-- Head --
Thread: Render thread
Suspected Mod:
\tCoolMod (coolmod), Version: 1.2.3
\t\tat TRANSFORMER/coolmod@1.2.3/com.example.cool.Foo.bar(Foo.java:12)
Stacktrace:
\tat com.example.cool.Foo.bar(Foo.java:12)
\tat net.minecraft.A.b(A.java:1)
\tat net.minecraft.A.c(A.java:1)

-- Block entity being ticked --
Details:
\tName: coolmod:thing
Stacktrace:
\tat net.minecraft.A.d(A.java:1)

-- System Details --
Details:
\tMinecraft Version: 1.20.1
\tMemory: 1 bytes (1 MiB) / 2 bytes (2 MiB) up to 4 bytes (4 MiB)
\tMod List:
\t\tcoolmod-1.2.3.jar   |CoolMod  |coolmod  |1.2.3  |DONE  |Manifest: NOSIGNATURE
\t\tother-2.0.jar       |Other    |other    |2.0    |DONE  |Manifest: NOSIGNATURE
\tCrash Report UUID: 3c3e
\tForge: net.minecraftforge:47.2.0

";
        let mut s = report.to_owned();
        for i in 0..200 {
            s.push_str(&format!("padding {i}\n"));
        }
        let d = digest(s.as_bytes(), &[], &opts(0, 0, 0, 6000));
        let head = chunk_of(&d, 1).expect("crash head");
        assert!(head.reasons.contains(&block(LogBlock::CrashHead)));
        assert!(head.reasons.contains(&block(LogBlock::CausedByChain)));
        // Crash head runs through the walkthrough line.
        assert!(line(&d, 15).is_some_and(|l| l.starts_with("A detailed walkthrough")));
        assert!(line(&d, 16).is_none());
        let suspected = chunk_of(&d, 20).expect("suspected");
        assert!(suspected.reasons.contains(&block(LogBlock::SuspectedMods)));
        assert_eq!(line(&d, 22), Some("\t\tat TRANSFORMER/coolmod@1.2.3/com.example.cool.Foo.bar(Foo.java:12)"));
        assert!(line(&d, 23).is_none(), "Stacktrace: ends the suspected block");
        let sys = chunk_of(&d, 34).expect("system details");
        assert_eq!(line(&d, 34), Some("-- System Details --"));
        assert!(sys.reasons.contains(&block(LogBlock::SystemDetails)));
        assert!(sys.reasons.contains(&block(LogBlock::ModList)));
        assert_eq!(line(&d, 42), Some("\tForge: net.minecraftforge:47.2.0"));
        assert!(line(&d, 43).is_none() && line(&d, 44).is_none(), "system details end at the blank line");
        assert_invariants(&d, 6000);
    }

    #[test]
    fn loading_sections_hs_err_and_mod_lists() {
        let text = "\
-- Mod loading issue for: coolmod --
Details:
\tMod file: /home/u/mods/coolmod-1.2.3.jar
\tFailure message: CoolMod (coolmod) encountered an error
\tException message: java.lang.IllegalStateException: x
Stacktrace:
\tat com.example.cool.Foo.bar(Foo.java:12)

filler a
filler b
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb, pid=1, tid=2
# Problematic frame:
# C  [atio6axx.dll+0x1b3e4f]
#
---------------  S U M M A R Y ------------
filler c
[12:00:00] [main/INFO]: Loading 3 mods:
\t- coolmod 1.0
\t- fabricloader 0.16.0
\t- minecraft 1.21
[12:00:01] [main/INFO]: next
filler d
-- Mod Table --
| Index | Mod | ID | Version | Plugin | File(s) |
| 0 | Cool | coolmod | 1.0 | | <mods>/coolmod.jar |
-- Mod Details --
filler e
";
        let d = digest(text.as_bytes(), &[], &opts(0, 0, 0, 6000));
        assert_eq!(ranges(&d), vec![(1, 7), (12, 17), (20, 23), (26, 28)]);
        assert_eq!(d.chunks[0].reasons, vec![block(LogBlock::SuspectedMods)]);
        assert_eq!(d.chunks[1].reasons, vec![block(LogBlock::HsErrHeader)]);
        assert_eq!(d.chunks[2].reasons, vec![block(LogBlock::ModList)]);
        assert_eq!(d.chunks[3].reasons, vec![block(LogBlock::ModList)]);
    }

    #[test]
    fn max_lines_is_enforced_and_tail_survives() {
        let mut s = String::new();
        for i in 1..=10_000u32 {
            s.push_str(&format!("Caused by: x{i}\n"));
        }
        let d = digest(s.as_bytes(), &["Caused by"], &opts(10, 10, 5, 100));
        assert!(d.truncated);
        assert_eq!(d.total_lines, 10_000);
        assert_eq!(line_count(&d), 100);
        assert_eq!(line(&d, 10_000), Some("Caused by: x10000"));
        assert_eq!(line(&d, 1), Some("Caused by: x1"));
        assert!(chunk_of(&d, 10_000).is_some_and(|c| c.reasons.contains(&ChunkReason::Tail)));
        assert_invariants(&d, 100);
    }

    #[test]
    fn budget_running_out_inside_a_context_window_keeps_the_reason() {
        let mut s = String::new();
        filler(&mut s, 1, 9);
        s.push_str("boom\n"); // 10
        filler(&mut s, 11, 30);
        let d = digest(s.as_bytes(), &["boom"], &opts(0, 0, 5, 3));
        assert!(d.truncated);
        assert_eq!(ranges(&d), vec![(5, 7)]);
        assert_eq!(d.chunks[0].reasons, vec![ChunkReason::Anchor { anchor: "boom".into() }]);
        assert_invariants(&d, 3);
    }

    #[test]
    fn benign_hits_do_not_starve_a_crash_near_the_end() {
        // 300 benign WARN traces (anchor hits plus CausedBy blocks), then a crash with Suspected
        // Mods and a Caused-by chain 1000 lines before EOF (outside the 400-line tail).
        let mut s = String::new();
        let mut n = 0u32;
        let mut add = |s: &mut String, text: &str| {
            s.push_str(text);
            s.push('\n');
            n += 1;
            n
        };
        for i in 0..300 {
            add(&mut s, &format!("[12:00:00] [Worker-Main-2/WARN] [compat/]: optional integration {i} missing"));
            add(&mut s, "java.lang.ClassNotFoundException: org.optional.Api");
            add(&mut s, "\tat dev.example.Compat.load(Compat.java:10)");
            add(&mut s, "Caused by: java.lang.ClassNotFoundException: org.optional.Api");
            add(&mut s, "\t... 4 more");
            for k in 0..35 {
                add(&mut s, &format!("[12:00:01] [Render thread/INFO] [x/]: filler {i}.{k}"));
            }
        }
        add(&mut s, "Suspected Mods: ");
        let suspect = add(&mut s, "\tCrate Logic (crates), Version: 2.2");
        add(&mut s, "Stacktrace:");
        add(&mut s, "java.lang.IllegalStateException: crate lost its owner");
        let cause = add(&mut s, "Caused by: java.lang.NullPointerException: owner");
        add(&mut s, "\tat org.crates.logic.Crate.tick(Crate.java:42)");
        for k in 0..1000 {
            add(&mut s, &format!("[12:10:00] [Render thread/INFO] [x/]: after {k}"));
        }
        let list = ["ClassNotFoundException", "Caused by: ", "Suspected Mods: "];
        let o = default_options();
        let d = digest(s.as_bytes(), &list, &o);
        assert!(d.truncated);
        assert_invariants(&d, o.max_lines);
        assert_eq!(line(&d, cause), Some("Caused by: java.lang.NullPointerException: owner"));
        assert!(chunk_of(&d, cause).is_some_and(|c| c.reasons.contains(&block(LogBlock::CausedByChain))));
        assert!(chunk_of(&d, suspect).is_some_and(|c| c.reasons.contains(&block(LogBlock::SuspectedMods))));
        // Head survives eviction.
        assert!(line(&d, 1).is_some());
    }

    #[test]
    fn options_from_the_ui_are_clamped() {
        let huge = DigestOptions { head: u32::MAX, tail: u32::MAX, context: u32::MAX, max_lines: u32::MAX, max_line_chars: u32::MAX };
        let c = clamp_options(&huge);
        assert_eq!((c.head, c.tail, c.context, c.max_lines, c.max_line_chars), (MAX_HEAD, MAX_TAIL, MAX_CONTEXT, MAX_MAX_LINES, MAX_LINE_CHARS));
        assert_eq!(clamp_options(&default_options()), default_options());
        let mut s = String::new();
        for i in 1..=30_000u32 {
            s.push_str(&format!("Caused by: x{i} {}\n", "y".repeat(50)));
        }
        let d = digest(s.as_bytes(), &["Caused by"], &huge);
        assert!(d.truncated);
        assert!(line_count(&d) <= MAX_MAX_LINES as usize);
        assert_eq!(d.total_lines, 30_000);
        let long = "z".repeat(20_000);
        let d = digest(format!("{long}\n").as_bytes(), &[], &huge);
        assert!(line(&d, 1).is_some_and(|l| l.ends_with(&format!(" …[+{} chars]", 20_000 - MAX_LINE_CHARS))));
    }

    #[test]
    fn head_plus_tail_larger_than_max_lines() {
        let mut s = String::new();
        filler(&mut s, 1, 500);
        let d = digest(s.as_bytes(), &[], &opts(80, 80, 0, 100));
        assert_eq!(line_count(&d), 100);
        assert!(d.truncated);
        assert_eq!(ranges(&d), vec![(1, 80), (481, 500)]);
    }

    #[test]
    fn crlf_is_stripped() {
        let d = digest(b"first\r\nsecond Caused by\r\nthird\r\n", &["Caused by"], &opts(0, 0, 1, 100));
        assert_eq!(d.total_lines, 3);
        assert_eq!(d.chunks[0].lines, vec!["first", "second Caused by", "third"]);
    }

    #[test]
    fn invalid_utf8_falls_back_to_windows_1252() {
        let d = digest(b"caf\xe9 \x93quoted\x94 ERROR\nok \xc3\xa9\n", &["ERROR"], &opts(0, 0, 1, 100));
        assert_eq!(line(&d, 1), Some("café “quoted” ERROR"));
        assert_eq!(line(&d, 2), Some("ok é"));
    }

    #[test]
    fn no_trailing_newline_and_empty_file() {
        let d = digest(b"a\nb", &[], &opts(5, 0, 0, 100));
        assert_eq!(d.total_lines, 2);
        assert_eq!(d.chunks[0].lines, vec!["a", "b"]);
        let e = digest(b"", &["x"], &opts(5, 5, 5, 100));
        assert_eq!(e.total_lines, 0);
        assert!(e.chunks.is_empty());
        assert!(!e.truncated);
    }

    #[test]
    fn five_megabyte_line_is_matched_then_clipped() {
        let mut s = Vec::with_capacity(5 * 1024 * 1024 + 64);
        s.extend_from_slice(b"short\n");
        s.extend(std::iter::repeat_n(b'x', 5 * 1024 * 1024));
        s.extend_from_slice(b" Mixin apply failed\nafter\n");
        let d = digest(&s, &["Mixin apply failed"], &opts(0, 0, 1, 100));
        let long = line(&d, 2).unwrap();
        let expected_extra = 5 * 1024 * 1024 + " Mixin apply failed".len() - 2000;
        assert!(long.starts_with(&"x".repeat(2000)));
        assert!(long.ends_with(&format!(" …[+{expected_extra} chars]")), "{}", &long[2000..]);
        assert_eq!(line(&d, 3), Some("after"));
        assert!(d.chunks[0].reasons.contains(&ChunkReason::Anchor { anchor: "Mixin apply failed".into() }));
    }

    #[test]
    fn line_over_the_byte_cap_is_skipped_without_buffering() {
        let mut s = Vec::with_capacity(MAX_RAW_LINE_BYTES + 1024 * 1024);
        s.extend_from_slice(b"ERROR ");
        s.extend(std::iter::repeat_n(b'y', MAX_RAW_LINE_BYTES + 1000));
        s.extend_from_slice(b"\r\nnext\n");
        let d = digest(&s, &["ERROR"], &opts(0, 0, 1, 100));
        assert_eq!(d.total_lines, 2);
        let first = line(&d, 1).unwrap();
        let expected_extra = 6 + MAX_RAW_LINE_BYTES + 1000 - 2000;
        assert!(first.ends_with(&format!(" …[+{expected_extra} chars]")), "{}", &first[2000..]);
        assert_eq!(line(&d, 2), Some("next"));
    }

    #[test]
    fn read_digest_missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_digest(&dir.path().join("nope.log"), source(), &[], &default_options()).unwrap_err();
        assert!(matches!(err, Error::NotFound { .. }), "{err:?}");
    }

    /// Writes `blocks` MiB of log text plus a final crash marker. Each 1 MiB block is built once
    /// and written repeatedly, so generation costs little more than the disk write.
    fn generate(path: &Path, blocks: usize) -> u32 {
        let mut block = String::with_capacity(1 << 20);
        let mut lines_per_block = 0u32;
        let mut i = 0u32;
        while block.len() < (1 << 20) - 200 {
            i += 1;
            if i == 5000 {
                block.push_str("[12:00:00] [Worker-Main-3/WARN]: Caused by: java.lang.ClassNotFoundException: x.Y\n");
            } else {
                block.push_str(&format!(
                    "[12:00:00] [Render thread/INFO]: Loaded chunk section {i} of region r.0.0.mca with 4096 entities\n"
                ));
            }
            lines_per_block += 1;
        }
        let file = File::create(path).unwrap();
        let mut w = std::io::BufWriter::with_capacity(1 << 20, file);
        for _ in 0..blocks {
            w.write_all(block.as_bytes()).unwrap();
        }
        w.write_all(b"[12:00:01] [Render thread/FATAL]: Crash report saved to crash.txt\n").unwrap();
        w.flush().unwrap();
        lines_per_block * blocks as u32 + 1
    }

    fn big_file_case(blocks: usize) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latest.log");
        let t0 = Instant::now();
        let expected_lines = generate(&path, blocks);
        let generated = t0.elapsed();
        let o = default_options();
        let list = anchors(&["Caused by: ", "Crash report saved to", "Mixin apply failed", "ResolutionException"]);
        let t1 = Instant::now();
        let d = read_digest(&path, source(), &list, &o).unwrap();
        let elapsed = t1.elapsed();
        eprintln!("digest of {blocks} MiB: generate {generated:?}, digest {elapsed:?}, {} lines kept", line_count(&d));
        assert_eq!(d.total_lines, expected_lines);
        assert_invariants(&d, o.max_lines);
        let last = line(&d, expected_lines).unwrap();
        assert!(last.contains("Crash report saved to"));
        let c = chunk_of(&d, expected_lines).unwrap();
        assert!(c.reasons.contains(&ChunkReason::Tail));
        if !d.truncated {
            assert!(c.reasons.contains(&ChunkReason::Anchor { anchor: "Crash report saved to".into() }));
        }
        // Memory bound: what is returned never depends on the file size.
        let bytes: usize = d.chunks.iter().flat_map(|c| c.lines.iter()).map(String::len).sum();
        assert!(bytes <= o.max_lines as usize * (o.max_line_chars as usize * 4 + 32));
    }

    #[test]
    fn fifty_megabyte_log_stays_bounded() {
        big_file_case(50);
    }

    #[test]
    #[ignore = "writes a 1 GiB file; run with --ignored"]
    fn one_gigabyte_log_stays_bounded() {
        big_file_case(1024);
    }
}
