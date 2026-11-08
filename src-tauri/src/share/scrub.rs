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
//!
//! [`CredentialRedactor`] then removes login tokens and the computer's user name (run after the
//! home scrubber, before the upload).

use regex::Regex;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// A run of path separators: `\`, `/`, or their percent-encodings.
const SEP: &str = r"(?:[\\/]|%5C|%2F)";

/// What may follow the home path: the end of the text, or one character that does **not**
/// continue a folder name. That is the complement of the TS `NAME_CONTINUES` (a letter, digit,
/// `_`, `-` or `~`, literal or percent-encoded): any other character, or a `%` that is not the
/// percent-encoding of one of those.
///
/// The `regex` crate has no lookahead, so the pattern consumes this character and only the
/// `home` group is replaced. Because the whole pattern must match, the engine first tries the
/// other ways of matching at the same start, as the TS lookahead does. For example, with home
/// `C:\Users\Bob`, the literal `BOB` in `C:\Users\BOB~1` is rejected and the 8.3 short name
/// `BOB~1` matches instead.
const NAME_ENDS: &str = r"(?:\z|[^\p{L}\p{N}_~%-]|%(?:\z|[^0-9A-F]|[0-9A-F](?:\z|[^0-9A-F])|[01][0-9A-F]|2[0-9A-CEF]|3[A-F]|40|5[B-E]|60|7[B-DF]))";

pub struct HomeScrubber {
    re: Option<Regex>,
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
        Self { re: Regex::new(&format!("(?iu)(?P<home>{pattern}){NAME_ENDS}")).ok() }
    }

    /// `text` (NFC) with every occurrence of the home folder replaced by `~`.
    pub fn scrub(&self, text: &str) -> String {
        let Some(re) = &self.re else { return text.to_string() };
        let text: String = text.nfc().collect();
        let mut out = String::with_capacity(text.len());
        let mut copied = 0;
        let mut pos = 0;
        while pos <= text.len() {
            let Some(home) = re.captures_at(&text, pos).and_then(|c| c.name("home")) else { break };
            out.push_str(&text[copied..home.start()]);
            out.push('~');
            copied = home.end();
            // The character after the home path was only checked, so the next match may start there.
            pos = if home.end() > home.start() { home.end() } else { home.end() + 1 };
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
    let short = format!(r"(?:{})(?:~|%7E)[0-9]+{ext}", stems.iter().map(|s| escape(s)).collect::<Vec<_>>().join("|"));
    format!("(?:{literal}|{short})")
}

// ── Credentials ──────────────────────────────────────────────────────────────────────────────

/// What replaces a removed credential or user name.
pub const REDACTED: &str = "<redacted>";

/// Bare user names (outside `USERNAME=` lines) shorter than this many characters are not
/// replaced: a short name such as `Bob` or `max` would hit ordinary words in the log.
pub const MIN_BARE_NAME_CHARS: usize = 4;

/// Login secrets, as launchers and the JVM write them into logs (the java command line in an
/// hs_err file or a launcher log, launch-argument dumps, auth JSON). `$1`/`$2` keep the key.
const SECRET_RULES: &[(&str, &str)] = &[
    // `--accessToken eyJ…`, `--uuid 0123…`, `--xuid 2535…`, `--clientId …`, also as list items
    // (`--accessToken, eyJ…,`) and quoted (`"--accessToken", "eyJ…"`).
    (r#"(?i)(--(?:accessToken|session|uuid|xuid|clientId))("?[ ,=]+"?)[^\s,\]\)"]+"#, "${1}${2}<redacted>"),
    // Vanilla's `(Session ID is token:<accessToken>:<uuid>)`, with or without the brackets.
    (r"(Session ID is token:)[^)\s]*", "${1}<redacted>"),
    // `"accessToken": "…"` in launcher JSON and auth dumps.
    (
        r#"(?i)("(?:accessToken|authToken|refreshToken|clientToken|access_token|refresh_token|id_token)"\s*:\s*)"[^"]*""#,
        r#"${1}"<redacted>""#,
    ),
    // Any JSON Web Token (Microsoft / Minecraft login tokens), wherever it appears.
    (r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "<redacted>"),
];

/// An environment variable naming the OS user (hs_err `Environment Variables:`, launcher dumps).
const USER_ENV_LINE: &str = r"(?m)^([ \t]*(?:USERNAME|USER|LOGNAME)[ \t]*=)([^\r\n]*)";

fn secret_rules() -> &'static [(regex::Regex, &'static str)] {
    static RULES: std::sync::LazyLock<Vec<(Regex, &'static str)>> =
        std::sync::LazyLock::new(|| SECRET_RULES.iter().filter_map(|(re, rep)| Regex::new(re).ok().map(|r| (r, *rep))).collect());
    &RULES
}

fn user_env_line() -> Option<&'static Regex> {
    static RE: std::sync::LazyLock<Option<Regex>> = std::sync::LazyLock::new(|| Regex::new(USER_ENV_LINE).ok());
    RE.as_ref()
}

/// Removes login secrets and the computer's user name from a log before it is uploaded:
/// - `--accessToken` / `--session` / `--uuid` / `--xuid` / `--clientId` values, `(Session ID is
///   token:…)`, `"accessToken": "…"`-style JSON fields and any JSON Web Token (`eyJ….….…`);
/// - the value of `USERNAME=`, `USER=` and `LOGNAME=` lines (hs_err environment variables);
/// - the OS user name anywhere else as a whole word (case-insensitive): the given names (the
///   home folder's last part, the user name environment variables) and the values of those
///   lines. Names shorter than [`MIN_BARE_NAME_CHARS`] are not replaced outside those lines.
///
/// The Minecraft player name (`--username`, `Setting user:`) is left as it is, unless it is
/// the same as the computer's user name.
pub struct CredentialRedactor {
    names: Vec<String>,
}

impl CredentialRedactor {
    /// `names`: the computer's user name(s); blank and duplicate names are dropped.
    pub fn new<S: AsRef<str>>(names: &[S]) -> Self {
        let mut r = Self { names: Vec::new() };
        for n in names {
            r.add_name(n.as_ref());
        }
        r
    }

    fn add_name(&mut self, name: &str) {
        let name = name.trim();
        if name.chars().count() >= MIN_BARE_NAME_CHARS && !self.names.iter().any(|n| n.to_lowercase() == name.to_lowercase()) {
            self.names.push(name.to_string());
        }
    }

    /// `text` with every credential and user name replaced by [`REDACTED`].
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_string();
        for (re, rep) in secret_rules() {
            if re.is_match(&out) {
                out = re.replace_all(&out, *rep).into_owned();
            }
        }
        let mut names = Self { names: self.names.clone() };
        if let Some(env) = user_env_line() {
            for c in env.captures_iter(&out) {
                if let Some(v) = c.get(2) {
                    names.add_name(v.as_str());
                }
            }
            if env.is_match(&out) {
                out = env.replace_all(&out, "${1}<redacted>").into_owned();
            }
        }
        names.replace_bare_names(&out)
    }

    /// Whole-word, case-insensitive replacement of the user names (longest first).
    fn replace_bare_names(&self, text: &str) -> String {
        if self.names.is_empty() {
            return text.to_string();
        }
        let mut names = self.names.clone();
        names.sort_by_key(|n| std::cmp::Reverse(n.len()));
        let alts = names.iter().map(|n| regex::escape(n)).collect::<Vec<_>>().join("|");
        let Ok(re) = Regex::new(&format!("(?iu)(?:{alts})")) else { return text.to_string() };
        let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
        let mut out = String::with_capacity(text.len());
        let mut copied = 0;
        let mut pos = 0;
        while pos < text.len() {
            let Some(m) = re.find_at(text, pos) else { break };
            let before = text[..m.start()].chars().next_back();
            let after = text[m.end()..].chars().next();
            if word(before) || word(after) {
                // Inside a longer word: try the next start position.
                pos = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
                continue;
            }
            out.push_str(&text[copied..m.start()]);
            out.push_str(REDACTED);
            copied = m.end();
            pos = m.end().max(m.start() + 1);
        }
        out.push_str(&text[copied..]);
        out
    }
}

/// The last folder name of `home` (`C:\Users\Bob Smith` → `Bob Smith`), usually the OS user name.
pub fn home_user_name(home: Option<&str>) -> Option<String> {
    let home = home?.trim().trim_end_matches(['\\', '/']);
    let last = home.rsplit(['\\', '/']).next()?.trim();
    (!last.is_empty() && !is_drive(last)).then(|| last.to_string())
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

    const NFC: &str = "J\u{fc}rgen";
    const NFD: &str = "Ju\u{308}rgen";

    fn table(cases: &[(&str, &str, &str)]) {
        for (home, text, expected) in cases {
            assert_eq!(&scrub(home, text), expected, "home {home:?}, text {text:?}");
        }
    }

    /// Every case of `src/core/report/__tests__/report.test.ts` and `scrub.test.ts`
    /// (`homeScrubber`): the Rust port must give the same answer.
    #[test]
    fn parity_with_the_ts_report_scrubber() {
        table(&[
            (r"C:\Users\Bob", r"C:\Users\Bob\mods", r"~\mods"),
            (r"C:\Users\Bob", r"c:\users\bob\mods", r"~\mods"),
            (r"C:\Users\Bob", "C:/Users/Bob/mods", "~/mods"),
            (r"C:\Users\Bob", "file:///C:/Users/Bob/x", "file:///~/x"),
            (r"C:\Users\Bob", r"C:\\Users\\Bob\\x", r"~\\x"),
            (r"C:\Users\Bob", r"end C:\Users\Bob.", "end ~."),
            (r"C:\Users\Bob", r"C:\Users\Bobby\x", r"C:\Users\Bobby\x"),
            (r"C:\Users\Bob", r"C:\Users\Bob-old\x", r"C:\Users\Bob-old\x"),
            ("/home/bob/", "/home/bob/.minecraft and /home/bob", "~/.minecraft and ~"),
            ("/home/bob", "/home/bobby", "/home/bobby"),
            (r"C:\Users\Bob Smith", r"file:///C:/Users/Bob%20Smith/x and C:\Users\Bob Smith\y", r"file:///~/x and ~\y"),
            ("/Users/a.b (x)", "/Users/a.b (x)/y and /Users/aXb (x)/y", "~/y and /Users/aXb (x)/y"),
            ("/", "/home/bob", "/home/bob"),
            ("", r"C:\Users\Bob", r"C:\Users\Bob"),
        ]);
        // 8.3 short names.
        let jc = format!(r"C:\Users\{NFC}");
        table(&[
            (r"C:\Users\Bob Smith", r"C:\Users\BOBSMI~1\AppData", r"~\AppData"),
            (r"C:\Users\Bob Smith", r"c:\users\bobsmi~12\x", r"~\x"),
            (r"C:\Users\Bob", r"C:\Users\BOB~1\x", r"~\x"),
            (r"C:\Users\Alexander", "C:/Users/ALEXAN~1/x", "~/x"),
            (&jc, r"C:\Users\JRGEN~1\x", r"~\x"),
            (&jc, r"C:\Users\JURGEN~2\x", r"~\x"),
            (&jc, r"C:\Users\J_RGEN~1\x", r"~\x"),
            (r"C:\Documents and Settings\Bob", r"C:\DOCUME~1\Bob\x and C:\DOCUME~1\BOB~1\y", r"~\x and ~\y"),
            (r"C:\Users\Bob", r"C:\Users\BOBBY~1\x", r"C:\Users\BOBBY~1\x"),
            (r"C:\Users\Bob", r"C:\Users\BOB~1x\y", r"C:\Users\BOB~1x\y"),
            (r"C:\Users\Bob", r"C:\Users\BOB1\x", r"C:\Users\BOB1\x"),
        ]);
        // Percent-encoded UTF-8.
        let jh = format!("/home/{NFC}");
        table(&[
            (&jc, "file:///C:/Users/J%C3%BCrgen/x", "file:///~/x"),
            (&jc, "file:///c:/users/j%c3%bcrgen/x", "file:///~/x"),
            (&jc, "file:///C:/Users/Ju%CC%88rgen/x", "file:///~/x"),
            (&jc, "file:///C:/USERS/J%C3%9CRGEN/x", "file:///~/x"),
            (&jc, "C%3A%5CUsers%5CJ%C3%BCrgen%5Cx", "~%5Cx"),
            (r"C:\Users\Bob", "https://x.example/?p=C%3A%2FUsers%2FBob%2Fmods", "https://x.example/?p=~%2Fmods"),
            (&jh, "file:///home/J%C3%BCrgen/.minecraft", "file:~/.minecraft"),
            (r"C:\Users\Bob Smith", "C:/Users/Bob%20Smith/x", "~/x"),
            (r"C:\Users\Bob", "C%3A%5CUsers%5CBobby%5Cx", "C%3A%5CUsers%5CBobby%5Cx"),
            (r"C:\Users\Bob", "C:/Users/Bob%C3%A9/x", "C:/Users/Bob%C3%A9/x"),
            (r"C:\Users\Bob", "C:/Users/Bob%41/x", "C:/Users/Bob%41/x"),
            (r"C:\Users\Bob", "C:/Users/Bob%5F2/x", "C:/Users/Bob%5F2/x"),
            (r"C:\Users\Bob", "C:/Users/Bob%2Fx", "~%2Fx"),
        ]);
        // UNC admin shares.
        table(&[
            (r"C:\Users\Bob", r"\\DESKTOP-1\C$\Users\Bob\mods", r"~\mods"),
            (r"C:\Users\Bob", r"at \\pc\c$\users\bob.", "at ~."),
            (r"C:\Users\Bob", r"\\?\UNC\pc\C$\Users\Bob\x", r"~\x"),
            (r"C:\Users\Bob", "file://pc/C$/Users/Bob/x", "file:~/x"),
            (r"C:\Users\Bob", r"\\pc\C%24\Users\Bob\x", r"~\x"),
            (r"C:\Users\Bob Smith", r"\\pc\C$\Users\BOBSMI~1\x", r"~\x"),
            (r"C:\Users\Bob", r"\\pc\D$\Users\Bob\x", r"\\pc\D$\Users\Bob\x"),
            (r"C:\Users\Bob", r"\\pc\C$\Users\Bobby\x", r"\\pc\C$\Users\Bobby\x"),
            (r"C:\Users\Bob", r"\\pc\share\Users\Bob\x", r"\\pc\share\Users\Bob\x"),
        ]);
        // Unicode normalisation.
        assert_eq!(scrub(&format!("/Users/{NFC}"), &format!("/Users/{NFD}/Library")), "~/Library");
        assert_eq!(scrub(&format!("/Users/{NFD}"), &format!("/Users/{NFC}/Library")), "~/Library");
        assert_eq!(scrub(&jc, "C:\\USERS\\J\u{dc}RGEN\\x"), r"~\x");
        assert_eq!(scrub(&format!("/Users/{NFC}"), &format!("/Users/{NFD}x/a")), format!("/Users/{NFC}x/a"));
        assert_eq!(scrub("/Users/Bob", "/Users/Bob\u{e9}/a"), "/Users/Bob\u{e9}/a");
        assert_eq!(scrub("/Users/Bob", "/Users/Bobby/a and /Users/Bob/a"), "/Users/Bobby/a and ~/a");
    }

    #[test]
    fn adjacent_homes_are_each_replaced() {
        assert_eq!(scrub("/home/bob", "/home/bob:/home/bob"), "~:~");
        assert_eq!(scrub("/home/bob", "/home/bob/home/bob"), "~~", "as the TS global replace does");
    }

    // ── Credentials ──

    #[test]
    fn every_secret_rule_compiles() {
        assert_eq!(secret_rules().len(), SECRET_RULES.len());
        assert!(user_env_line().is_some());
    }

    fn redact(names: &[&str], text: &str) -> String {
        CredentialRedactor::new(names).redact(text)
    }

    #[test]
    fn launch_arguments_lose_their_secrets_but_keep_the_player_name() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlXy1f";
        let line = format!("--username Steve --version 1.20.1 --accessToken {jwt} --uuid 0123456789abcdef0123456789abcdef --xuid 2535412345678901 --clientId QWxhZGRpbjpvcGVu --userType msa");
        assert_eq!(
            redact(&[], &line),
            "--username Steve --version 1.20.1 --accessToken <redacted> --uuid <redacted> --xuid <redacted> --clientId <redacted> --userType msa"
        );
        // List dumps (Forge / launcher "launch arguments" lines) and quoted JSON arrays.
        assert_eq!(
            redact(&[], "[--username, Steve, --accessToken, abc.def, --uuid, 0123, --version, 1.20.1]"),
            "[--username, Steve, --accessToken, <redacted>, --uuid, <redacted>, --version, 1.20.1]"
        );
        assert_eq!(redact(&[], r#"["--accessToken", "tok123", "--username", "Steve"]"#), r#"["--accessToken", "<redacted>", "--username", "Steve"]"#);
        assert_eq!(redact(&[], "--accesstoken=tok"), "--accesstoken=<redacted>");
        assert_eq!(redact(&[], "--session token:abc:def --username Alex"), "--session <redacted> --username Alex");
    }

    #[test]
    fn session_lines_json_fields_and_bare_jwts() {
        assert_eq!(redact(&[], "(Session ID is token:abc123:0123abcd)"), "(Session ID is token:<redacted>)");
        assert_eq!(
            redact(&[], r#"{"accessToken" : "abc", "refresh_token":"def", "name": "Steve"}"#),
            r#"{"accessToken" : "<redacted>", "refresh_token":"<redacted>", "name": "Steve"}"#
        );
        assert_eq!(redact(&[], "Bearer eyJa-b_c.eyJd.efg_h- end"), "Bearer <redacted> end");
        assert_eq!(redact(&[], "eyJ alone is no token"), "eyJ alone is no token");
    }

    #[test]
    fn user_name_lines_and_the_bare_name_as_a_whole_word() {
        let text = "USERNAME=Joey Pterodactyl\r\nUSER=joe\nLOGNAME=joe\nOS=Windows_NT\nby Joey Pterodactyl, not JoeyPterodactylFan; joe stays\n";
        assert_eq!(
            redact(&["joeyp"], text),
            "USERNAME=<redacted>\r\nUSER=<redacted>\nLOGNAME=<redacted>\nOS=Windows_NT\nby <redacted>, not JoeyPterodactylFan; joe stays\n",
            "a value under 4 characters is removed on its line only"
        );
        // The home folder's name, case-insensitive, whole words only.
        assert_eq!(redact(&["Gamer42"], "gamer42 played; Gamer420 did not; [GAMER42]"), "<redacted> played; Gamer420 did not; [<redacted>]");
        // Short names are not replaced outside their line.
        assert_eq!(redact(&["Bob"], "Bob ran the Bobsled mod"), "Bob ran the Bobsled mod");
    }

    #[test]
    fn the_home_folders_last_part_is_the_user_name() {
        assert_eq!(home_user_name(Some(r"C:\Users\Bob Smith\")), Some("Bob Smith".into()));
        assert_eq!(home_user_name(Some("/home/alex")), Some("alex".into()));
        assert_eq!(home_user_name(Some("C:")), None);
        assert_eq!(home_user_name(Some("/")), None);
        assert_eq!(home_user_name(None), None);
    }
}
