//! Release gate (CONTRACTS invariant 18): checks one updater artifact exactly the way the
//! installed app will, before the owner publishes the draft release.
//!
//! ```text
//! cargo run --release --example verify_update_sig -- <pubkey> <asset-file> <signature-file> <version>
//! ```
//!
//! - `<pubkey>`: `plugins.updater.pubkey` from `tauri.conf.json` (base64 of the minisign public
//!   key file).
//! - `<asset-file>`: the downloaded release asset that `latest.json` points at.
//! - `<signature-file>`: a file holding that platform's `signature` from `latest.json` (base64 of
//!   the minisign signature file, as the Tauri CLI writes it to `<asset>.sig`).
//! - `<version>`: the version `latest.json` announces (a leading `v` is ignored).
//!
//! Mirrors `tauri-plugin-updater`'s check with `requireSignedVersion` on: the minisign signature
//! (global signature included, so the trusted comment is authenticated) must verify against the
//! public key, and the trusted comment must carry `version:<version>`. Exit code 0 when the
//! artifact passes, 1 when it does not, 2 on bad arguments or unreadable files.
//!
//! Needs `minisign-verify` as a dev-dependency (the same crate and version the updater uses).
//! Reads only the files it is given; never touches a private key.

use std::process::ExitCode;

use minisign_verify::{PublicKey, Signature};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [pubkey, asset, sig, version] = args.as_slice() else {
        eprintln!("usage: verify_update_sig <pubkey-base64> <asset-file> <signature-file> <version>");
        return ExitCode::from(2);
    };
    let data = match std::fs::read(asset) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("error: cannot read {asset}: {e}");
            return ExitCode::from(2);
        }
    };
    let signature = match std::fs::read_to_string(sig) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: cannot read {sig}: {e}");
            return ExitCode::from(2);
        }
    };
    match verify(pubkey, &data, &signature, version) {
        Ok(comment) => {
            println!("ok: {asset} is signed by the updater key for version {version} ({comment})");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {asset}: {e}");
            ExitCode::from(1)
        }
    }
}

/// Verifies `data` against the base64 `signature` and base64 `pubkey`, then checks the signed
/// version. Returns the trusted comment on success.
fn verify(pubkey: &str, data: &[u8], signature: &str, version: &str) -> Result<String, String> {
    let pubkey_text = base64_text(pubkey).map_err(|e| format!("public key: {e}"))?;
    let public_key = PublicKey::decode(&pubkey_text).map_err(|e| format!("public key: {e}"))?;
    let sig_text = base64_text(signature).map_err(|e| format!("signature: {e}"))?;
    let sig = Signature::decode(&sig_text).map_err(|e| format!("signature: {e}"))?;
    // Same call as the updater (legacy, non-prehashed signatures allowed). This also checks the
    // global signature over the trusted comment, so the comment is trustworthy only after it.
    public_key
        .verify(data, &sig, true)
        .map_err(|e| format!("signature does not verify against the updater public key: {e}"))?;
    let comment = sig.trusted_comment().to_string();
    let signed = comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .ok_or_else(|| format!("the signature's trusted comment has no version (requireSignedVersion would reject it): {comment:?}"))?;
    let expected = version.trim().trim_start_matches('v');
    if signed.trim_start_matches('v') != expected {
        return Err(format!("signed for version {signed}, but latest.json announces {expected}"));
    }
    Ok(comment)
}

/// Standard base64 (with or without padding, ASCII whitespace ignored) decoded to UTF-8 text.
fn base64_text(input: &str) -> Result<String, String> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let chars: Vec<u8> = input.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let body = chars.strip_suffix(b"==").or_else(|| chars.strip_suffix(b"=")).unwrap_or(&chars);
    if body.is_empty() || body.len() % 4 == 1 || (body.len() != chars.len() && !chars.len().is_multiple_of(4)) {
        return Err("not valid base64".into());
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            let v = value(c).ok_or("not valid base64")?;
            acc |= v << (18 - 6 * i);
        }
        let bytes = acc.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    String::from_utf8(out).map_err(|_| "base64 does not decode to text".into())
}

#[cfg(test)]
mod tests {
    use super::base64_text;

    #[test]
    fn decodes_padded_and_unpadded_base64() {
        assert_eq!(base64_text("aGVsbG8=").unwrap(), "hello");
        assert_eq!(base64_text("aGVsbG8").unwrap(), "hello");
        assert_eq!(base64_text("aGVs\nbG8h").unwrap(), "hello!");
        assert!(base64_text("a").is_err());
        assert!(base64_text("aGV*").is_err());
    }
}
