//! The environment discovery runs against: OS flavour, home and the per-OS base folders.
//! Everything is injectable so tests never look at the real home directory.

use std::collections::HashMap;
use std::path::PathBuf;

/// The OS whose path conventions discovery follows (not necessarily the host OS in tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

impl Os {
    /// The OS this binary was built for.
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }

    /// Windows and macOS (APFS default) are case-insensitive but case-preserving.
    pub fn case_insensitive(self) -> bool {
        matches!(self, Os::Windows | Os::MacOs)
    }
}

/// Environment variables discovery honours (`Env::current` reads only these).
pub const ENV_VARS: &[&str] = &[
    "THESEUS_CONFIG_DIR",
    "PRISMLAUNCHER_DATA_DIR",
    "SystemDrive",
    "ProgramFiles",
    "ProgramFiles(x86)",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Env {
    pub os: Os,
    pub home: PathBuf,
    /// Windows `%APPDATA%` (Roaming). Default: `<home>\AppData\Roaming`.
    pub appdata: Option<PathBuf>,
    /// Windows `%LOCALAPPDATA%`. Default: `<home>\AppData\Local`.
    pub local_appdata: Option<PathBuf>,
    /// Linux `$XDG_DATA_HOME`. Default: `<home>/.local/share`.
    pub xdg_data_home: Option<PathBuf>,
    /// Linux `$XDG_CONFIG_HOME`. Default: `<home>/.config`.
    pub xdg_config_home: Option<PathBuf>,
    /// Documents (Known Folder on Windows, so OneDrive redirection is followed).
    /// Default: `<home>/Documents`.
    pub documents: Option<PathBuf>,
    /// macOS system `/Applications` (MultiMC.app lives there). `None` = not probed, which
    /// keeps tests hermetic; `Env::current` sets it on macOS.
    pub applications: Option<PathBuf>,
    /// Selected environment variables (see [`ENV_VARS`]).
    pub vars: HashMap<String, String>,
}

impl Env {
    /// A hermetic environment: only `home` is known, every other folder is derived from it.
    pub fn new(os: Os, home: PathBuf) -> Self {
        Env {
            os,
            home,
            appdata: None,
            local_appdata: None,
            xdg_data_home: None,
            xdg_config_home: None,
            documents: None,
            applications: None,
            vars: HashMap::new(),
        }
    }

    /// The real environment of this process.
    pub fn current() -> Self {
        let os = Os::current();
        let home = dirs::home_dir().unwrap_or_default();
        let vars = ENV_VARS
            .iter()
            .filter_map(|k| {
                let v = std::env::var(k).ok()?;
                (!v.trim().is_empty()).then(|| ((*k).to_string(), v))
            })
            .collect();
        Env {
            os,
            appdata: if os == Os::Windows { dirs::data_dir() } else { None },
            local_appdata: if os == Os::Windows { dirs::data_local_dir() } else { None },
            xdg_data_home: if os == Os::Linux { dirs::data_dir() } else { None },
            xdg_config_home: if os == Os::Linux { dirs::config_dir() } else { None },
            documents: dirs::document_dir(),
            applications: if os == Os::MacOs { Some(PathBuf::from("/Applications")) } else { None },
            vars,
            home,
        }
    }

    /// `dirs::data_dir()` semantics: Roaming AppData, `~/Library/Application Support`,
    /// `$XDG_DATA_HOME`.
    pub fn data_dir(&self) -> PathBuf {
        match self.os {
            Os::Windows => self.appdata.clone().unwrap_or_else(|| self.home.join("AppData").join("Roaming")),
            Os::MacOs => self.home.join("Library").join("Application Support"),
            Os::Linux => self.xdg_data_home.clone().unwrap_or_else(|| self.home.join(".local").join("share")),
        }
    }

    /// `dirs::config_dir()` semantics: Roaming AppData, `~/Library/Application Support`,
    /// `$XDG_CONFIG_HOME`.
    pub fn config_dir(&self) -> PathBuf {
        match self.os {
            Os::Windows | Os::MacOs => self.data_dir(),
            Os::Linux => self.xdg_config_home.clone().unwrap_or_else(|| self.home.join(".config")),
        }
    }

    pub fn local_data_dir(&self) -> PathBuf {
        match self.os {
            Os::Windows => self.local_appdata.clone().unwrap_or_else(|| self.home.join("AppData").join("Local")),
            _ => self.data_dir(),
        }
    }

    pub fn documents_dir(&self) -> PathBuf {
        self.documents.clone().unwrap_or_else(|| self.home.join("Documents"))
    }

    /// A non-empty environment variable as a path.
    pub fn var_path(&self, key: &str) -> Option<PathBuf> {
        self.vars.get(key).map(|v| v.trim()).filter(|v| !v.is_empty()).map(PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_derive_from_home() {
        let home = PathBuf::from("h");
        let w = Env::new(Os::Windows, home.clone());
        assert_eq!(w.data_dir(), home.join("AppData").join("Roaming"));
        assert_eq!(w.config_dir(), w.data_dir());
        assert_eq!(w.local_data_dir(), home.join("AppData").join("Local"));
        let m = Env::new(Os::MacOs, home.clone());
        assert_eq!(m.data_dir(), home.join("Library").join("Application Support"));
        assert_eq!(m.config_dir(), m.data_dir());
        let l = Env::new(Os::Linux, home.clone());
        assert_eq!(l.data_dir(), home.join(".local").join("share"));
        assert_eq!(l.config_dir(), home.join(".config"));
        assert_eq!(l.documents_dir(), home.join("Documents"));
    }

    #[test]
    fn explicit_dirs_win() {
        let mut l = Env::new(Os::Linux, PathBuf::from("h"));
        l.xdg_data_home = Some(PathBuf::from("d"));
        l.xdg_config_home = Some(PathBuf::from("c"));
        l.documents = Some(PathBuf::from("docs"));
        assert_eq!(l.data_dir(), PathBuf::from("d"));
        assert_eq!(l.config_dir(), PathBuf::from("c"));
        assert_eq!(l.documents_dir(), PathBuf::from("docs"));
    }
}
