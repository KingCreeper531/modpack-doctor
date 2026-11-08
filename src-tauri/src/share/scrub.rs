//! Home folder → `~`, with the same rules as the report scrubber (`src/core/report/text.ts`
//! `homeScrubber`, CONTRACTS invariant 16), ported so a log shared on mclo.gs is scrubbed in Rust
//! and the webview never handles its text:
//! - separators match `\`, `/`, `%5C`, `%2F` or a run of them (`C:\\Users\\Bob` as Java escapes it,
//!   `file:///C:/Users/Bob`, `C%3A%5CUsers%5CBob`);
//! - case-insensitive; text and home are compared in NFC, and every character may also appear
//!   UTF-8 percent-encoded, NFC or NFD (`J%C3%BCrgen`, `Ju%CC%88rgen`);
//! - Windows 8.3 short names of each folder (`C:\Users\BOBSMI~1`);
//! - a drive home also matches through its UNC admin share (`\\host\C$\Users\Bob`);
//! - only whole folder names: `/home/bob` is not replaced inside `/home/bobby`.
//!
//! An empty, root-only or drive-only home replaces nothing.

use regex::Regex;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// A run of path separators: `\`, `/`, or their percent-encodings.
const SEP: &str = r"(?:[\\/]|%5C|%2F)";

/// A following character that would make the match part of a longer folder name: a letter,
/// digit, `_`, `-` or `~`, literal or percent-encoded (checked after each match: the `regex`
/// crate has no lookahead).
const NAME_CONTINUES: &str = r"(?iu)^(?:[\p{L}\p{N}_~-]|%(?:[89A-F][0-9A-F]|3[0-9]|[46][1-9A-F]|[57][0-9A]|5F|2D|7E))";

pub struct HomeScrubber {
    re: Option<(Regex, Regex)>,
}

impl HomeScrubber {
    /// A scrubber for `home` (as `dirs::home_dir` gives it); `None`/empty scrubs nothing.
    pub fn new(home: Option<&str>) -> Self {
        let home: String = home.unwrap_or("").nfc().collect();
        let home = home.trim().trim_end_matches(['\\', '/']).to_string();
        if home.is_empty() || is_drive(&home) {
            return Self { re: None };
        }
        let mut pattern = String::new();
        let mut first = true;
        for (part, is_sep) in split_keep_seps(&home) {
            if is_sep {
                pattern.push_str(SEP);
                pattern.push('+');
            } else if first && is_drive(part) {
                let drive = char_pattern(part.chars().next().unwrap_or('C'));
                let unc = format!(r"{SEP}{{2}}(?:\?{SEP}+UNC{SEP}+)?[^\\/\s]+?{SEP}+{drive}(?:\$|%24)");
                pattern.push_str(&format!("(?:{drive}(?::|%3A)|{unc})"));
            } else {
                pattern.push_str(&segment_pattern(part));
            }
            first = false;
        }
        let re = Regex::new(&format!("(?iu){pattern}")).ok();
        let cont = Regex::new(NAME_CONTINUES).ok();
        Self { re: re.zip(cont) }
    }

    /// `text` (NFC) with every occurrence of the home folder replaced by `~`.
    pub fn scrub(&self, text: &str) -> String {
        let Some((re, cont)) = &self.re else { return text.to_string() };
        let text: String = text.nfc().collect();
        let mut out = String::with_capacity(text.len());
        let mut copied = 0;
        let mut pos = 0;
        while pos <= text.len() {
            let Some(m) = re.find_at(&text, pos) else { break };
            if cont.is_match(&text[m.end()..]) {
                // Part of a longer folder name: try the next start position.
                pos = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
                continue;
            }
            out.push_str(&text[copied..m.start()]);
            out.push('~');
            copied = m.end();
            pos = if m.end() > m.start() { m.end() } else { m.end() + 1 };
        }
        out.push_str(&text[copied..]);
        out
    }
}

fn is_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// `home` split into folder names and separator runs, in order.
fn split_keep_seps(home: &str) -> Vec<(&str, bool)> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_sep: Option<bool> = None;
    for (i, c) in home.char_indices() {
        let sep = c == '\\' || c == '/';
        if in_sep.is_some_and(|s| s != sep) {
            out.push((&home[start..i], !sep));
            start = i;
        }
        in_sep = Some(sep);
    }
    if start < home.len() {
        out.push((&home[start..], in_sep.unwrap_or(false)));
    }
    out
}

fn escape(s: &str) -> String {
    regex::escape(s)
}

/// `%XX` UTF-8 percent-encoding of every code point of `s`.
fn percent_encode(s: &str) -> String {
    s.bytes().map(|b| format!("%{b:02X}")).collect()
}

/// One character of the home path: itself (case-insensitive through the flag), or its UTF-8
/// percent-encoding in NFC or NFD, of either case.
fn char_pattern(ch: char) -> String {
    let lit = escape(&ch.to_string());
    let mut alts: Vec<String> = vec![lit.clone()];
    let mut push = |s: String| {
        if !alts.contains(&s) {
            alts.push(s);
        }
    };
    let mut variants: Vec<String> = Vec::new();
    for v in [ch.to_string(), ch.to_lowercase().collect(), ch.to_uppercase().collect()] {
        if !variants.contains(&v) {
            variants.push(v);
        }
    }
    for v in variants {
        push(percent_encode(&v.nfc().collect::<String>()));
        let nfd: Vec<char> = v.nfd().collect();
        if nfd.len() > 1 {
            push(nfd.iter().map(|cp| format!("(?:{}|{})", escape(&cp.to_string()), percent_encode(&cp.to_string()))).collect());
        } else {
            push(percent_encode(&nfd.iter().collect::<String>()));
        }
    }
    if alts.len() == 1 {
        lit
    } else {
        format!("(?:{})", alts.join("|"))
    }
}

fn first_upper(s: &str, n: usize) -> String {
    s.chars().take(n).collect::<String>().to_uppercase()
}

/// Windows 8.3 short-name stems and extensions of one folder name (see the TS original).
fn short_stems(name: &str) -> (Vec<String>, Vec<String>) {
    let squeezed: String = name.chars().filter(|c| !c.is_whitespace()).collect();
    let squeezed = squeezed.trim_start_matches('.');
    let dot = squeezed.rfind('.').filter(|&d| d > 0);
    let bases: Vec<&str> = match dot {
        Some(d) => vec![&squeezed[..d], squeezed],
        None => vec![squeezed],
    };
    let ext = dot.map(|d| &squeezed[d + 1..]).unwrap_or("");
    let variants = |s: &str| -> Vec<String> {
        vec![
            s.chars().filter(char::is_ascii_alphanumeric).collect(),
            s.nfd().filter(|c| !is_combining_mark(*c)).filter(char::is_ascii_alphanumeric).collect(),
            s.chars()
                .filter(|c| *c != '.')
                .map(|c| if !('\x21'..='\x7e').contains(&c) || "+,;=[]\"*/:<>?\\|".contains(c) { '_' } else { c })
                .collect(),
            s.chars().filter(|c| c.is_alphanumeric()).collect(),
        ]
    };
    let mut stems: Vec<String> = Vec::new();
    for b in &bases {
        for v in variants(b) {
            let s = first_upper(&v, 6);
            if !s.is_empty() && !stems.contains(&s) {
                stems.push(s);
            }
        }
    }
    let mut exts: Vec<String> = Vec::new();
    if !ext.is_empty() {
        for v in variants(ext) {
            let s = first_upper(&v, 3);
            if !s.is_empty() && !exts.contains(&s) {
                exts.push(s);
            }
        }
    }
    (stems, exts)
}

/// One folder name of the home path: as written (each character maybe encoded), or 8.3 short.
fn segment_pattern(name: &str) -> String {
    let literal: String = name.chars().map(char_pattern).collect();
    let (stems, exts) = short_stems(name);
    if stems.is_empty() {
        return literal;
    }
    let ext = if exts.is_empty() {
        String::new()
    } else {
        format!(r"(?:\.(?:{}))?", exts.iter().map(|e| escape(e)).collect::<Vec<_>>().join("|"))
    };
    let short = format!(r"(?:{})(?:~|%7E)\d+{ext}", stems.iter().map(|s| escape(s)).collect::<Vec<_>>().join("|"));
    format!("(?:{literal}|{short})")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scrub(home: &str, text: &str) -> String {
        HomeScrubber::new(Some(home)).scrub(text)
    }

    // Cases mirror src/core/report/__tests__ (homeScrubber).
    #[test]
    fn windows_home_in_every_spelling() {
        let h = r"C:\Users\Bob Smith";
        assert_eq!(scrub(h, r"at C:\Users\Bob Smith\curseforge\x"), r"at ~\curseforge\x");
        assert_eq!(scrub(h, "c:/users/bob smith/AppData"), "~/AppData");
        assert_eq!(scrub(h, r"C:\\Users\\Bob Smith\\AppData"), r"~\\AppData");
        assert_eq!(scrub(h, "file:///C:/Users/Bob%20Smith/x"), "file:///~/x");
        assert_eq!(scrub(h, "C%3A%5CUsers%5CBob%20Smith%5Cx"), "~%5Cx");
        assert_eq!(scrub(h, r"C:\Users\BOBSMI~1\AppData\Local\Temp"), r"~\AppData\Local\Temp");
        assert_eq!(scrub(h, r"\\desk\C$\Users\Bob Smith\x"), r"~\x");
        assert_eq!(scrub(h, r"C:\Users\Bob Smithers\x"), r"C:\Users\Bob Smithers\x");
        assert_eq!(scrub(h, r"C:\Users\Bob Smith_old"), r"C:\Users\Bob Smith_old");
    }

    #[test]
    fn unix_and_unicode_homes() {
        assert_eq!(scrub("/home/bob", "/home/bob/.minecraft and /home/bobby/x"), "~/.minecraft and /home/bobby/x");
        let j = "/Users/J\u{fc}rgen";
        assert_eq!(scrub(j, "/Users/Ju\u{308}rgen/Library"), "~/Library", "NFD text");
        assert_eq!(scrub(j, "/Users/J%C3%BCrgen/x"), "~/x");
        assert_eq!(scrub(j, "/Users/Ju%CC%88rgen/x"), "~/x");
        assert_eq!(scrub(r"C:\Users\Jürgen", r"C:\Users\JRGEN~1\x"), r"~\x");
    }

    #[test]
    fn empty_root_or_drive_home_replaces_nothing() {
        for h in ["", "/", "\\", "C:", "C:\\"] {
            assert_eq!(scrub(h, r"C:\Users\x /home/y"), r"C:\Users\x /home/y", "{h:?}");
        }
        assert_eq!(HomeScrubber::new(None).scrub("a"), "a");
    }
}
