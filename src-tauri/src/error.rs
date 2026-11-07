//! Typed errors. Internally `Error` (thiserror); across IPC every command returns
//! `Result<T, AppError>`, a flat serializable shape the UI renders as an inline error row.
//! Every message is a complete sentence a user can act on.

use serde::Serialize;
use specta::Type;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Could not find {path}.")]
    NotFound { path: String },
    #[error("Permission denied for {path}. Check that no other program has it open and that your account can access it.")]
    Permission { path: String },
    #[error("Minecraft is running for this instance ({0}). Close the game, then try again.")]
    GameRunning(String),
    #[error("The path {path} is outside the folders Modpack Doctor may access. Add its folder first.")]
    OutsideScope { path: String },
    #[error("The file {path} is damaged or not a valid file: {reason}.")]
    Corrupt { path: String, reason: String },
    #[error("Could not reach Modrinth: {0}.")]
    Network(String),
    #[error("Modrinth's rate limit was reached. Try again in {retry_after_s} seconds.")]
    RateLimited { retry_after_s: u32 },
    #[error("The download of {path} failed verification (expected SHA-512 {expected}, got {actual}). Nothing was changed.")]
    HashMismatch { path: String, expected: String, actual: String },
    #[error("{0}")]
    Conflict(String),
    #[error("Modrinth is unavailable (offline mode or no connection). Static checks still work.")]
    Offline,
    #[error("Could not read or write {path}: {source}.")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("Invalid request: {0}.")]
    Invalid(String),
    #[error("Internal error: {0}. Please report this.")]
    Internal(String),
    /// A feature that this build doesn't have yet (later milestone). Not an error in the app.
    #[error("{0} isn't available in this version of Modpack Doctor yet.")]
    Unavailable(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// Wrap an io::Error for `path`, mapping PermissionDenied/NotFound to their own kinds.
    pub fn io(path: impl AsRef<std::path::Path>, source: std::io::Error) -> Self {
        let path = path.as_ref().display().to_string();
        match source.kind() {
            std::io::ErrorKind::PermissionDenied => Error::Permission { path },
            std::io::ErrorKind::NotFound => Error::NotFound { path },
            _ => Error::Io { path, source },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NotFound,
    Permission,
    GameRunning,
    OutsideScope,
    Corrupt,
    Network,
    RateLimited,
    HashMismatch,
    Conflict,
    Offline,
    Io,
    Invalid,
    Internal,
    /// Feature not in this build yet; the UI shows it neutrally, not as a failure.
    Unavailable,
}

/// The IPC error shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    /// Readable, complete sentence for the UI.
    pub message: String,
    /// The file or folder concerned, when there is one.
    pub path: Option<String>,
    /// `rateLimited` only: seconds until Modrinth accepts requests again. Omitted otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub retry_after_s: Option<u32>,
}

impl From<Error> for AppError {
    fn from(e: Error) -> Self {
        let message = e.to_string();
        let (kind, path) = match &e {
            Error::NotFound { path } => (ErrorKind::NotFound, Some(path.clone())),
            Error::Permission { path } => (ErrorKind::Permission, Some(path.clone())),
            Error::GameRunning(_) => (ErrorKind::GameRunning, None),
            Error::OutsideScope { path } => (ErrorKind::OutsideScope, Some(path.clone())),
            Error::Corrupt { path, .. } => (ErrorKind::Corrupt, Some(path.clone())),
            Error::Network(_) => (ErrorKind::Network, None),
            Error::RateLimited { .. } => (ErrorKind::RateLimited, None),
            Error::HashMismatch { path, .. } => (ErrorKind::HashMismatch, Some(path.clone())),
            Error::Conflict(_) => (ErrorKind::Conflict, None),
            Error::Offline => (ErrorKind::Offline, None),
            Error::Io { path, .. } => (ErrorKind::Io, Some(path.clone())),
            Error::Invalid(_) => (ErrorKind::Invalid, None),
            Error::Internal(_) => (ErrorKind::Internal, None),
            Error::Unavailable(_) => (ErrorKind::Unavailable, None),
        };
        let retry_after_s = match &e {
            Error::RateLimited { retry_after_s } => Some(*retry_after_s),
            _ => None,
        };
        AppError { kind, message, path, retry_after_s }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_permission_maps_to_permission_kind() {
        let e = Error::io("mods/a.jar", std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        let a: AppError = e.into();
        assert_eq!(a.kind, ErrorKind::Permission);
        assert_eq!(a.path.as_deref(), Some("mods/a.jar"));
    }

    #[test]
    fn messages_are_sentences() {
        let samples: Vec<AppError> = vec![
            Error::GameRunning("java.exe pid 42".into()).into(),
            Error::NotFound { path: "mods/x.jar".into() }.into(),
            Error::Offline.into(),
            Error::Invalid("unknown backup id".into()).into(),
        ];
        for a in samples {
            assert!(a.message.ends_with('.'), "not a sentence: {}", a.message);
            assert!(a.message.chars().next().is_some_and(|c| !c.is_lowercase()), "lowercase start: {}", a.message);
        }
    }
}
