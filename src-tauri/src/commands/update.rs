//! The update commands (M8, CONTRACTS.md invariant 18): thin wrappers around
//! `tauri-plugin-updater`, which runs in Rust only (the webview has no updater permission).
//!
//! - Nothing is installed on its own: `check_update` runs when the user asks (About, palette) or,
//!   only with the opt-in `Settings::auto_check_updates`, once a few seconds after the app starts
//!   (the UI calls this same command, `src/ui/app/startupUpdate.ts`). Either way it only
//!   reports; it never touches the "update installing" state or the work-order claim.
//! - `check_update` remembers the version it showed (`AppState::checked_update`).
//!   `install_update` installs only that version: it re-checks, and a different version (or no
//!   check at all) is a `Conflict`. Then it downloads, verifies the minisign signature against
//!   `plugins.updater.pubkey` in `tauri.conf.json`, installs and restarts.
//! - Installing is atomic with "no work order executes": `install_update` first enters the
//!   "update installing" state ([`FixState::begin_update`], refused while an order executes or
//!   another install runs), in which no work order can start, and holds it through the install
//!   (on Windows the plugin exits the process from inside `install`). Every error releases it.
//! - The endpoint and the release assets are on GitHub only (`plugins.updater.endpoints`).
//!
//! Updater errors become `AppError`s with sentences of their own here: `Error::Network` and
//! `Error::Offline` speak about Modrinth, which is not the host involved.

use std::future::Future;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::error::{AppError, ErrorKind};
use crate::fix::{FixState, UpdateTicket};
use crate::model::UpdateInfo;
use crate::state::AppState;

use super::Cmd;

/// Where users can download a release by hand when the in-app update cannot be used.
const RELEASES_URL: &str = "https://github.com/KingCreeper531/modpack-doctor/releases";

/// `latest.json` is tiny; a check that takes longer than this is treated as unreachable.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// The whole installer download (tens of MB), so slow connections still finish.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// What the updater was doing when it failed; only the wording differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Check,
    Install,
}

// Remembers the version shown, the only one `install_update` will install (doc comments here
// end up in `src/bindings.ts`).
/// Checks GitHub for a newer release and reports it (null when up to date); never installs.
/// Runs when the user asks, or once at start when `Settings.autoCheckUpdates` is on.
#[tauri::command]
#[specta::specta]
pub async fn check_update(app: AppHandle) -> Cmd<Option<UpdateInfo>> {
    let info = find_update(&app).await?.as_ref().map(update_info);
    if let Some(st) = app.try_state::<AppState>() {
        remember_checked(&st, info.as_ref().map(|i| i.version.clone()));
    }
    Ok(info)
}

// Only the version the last `check_update` showed.
/// Downloads, verifies the updater signature, installs, restarts.
#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Cmd<()> {
    let st = app
        .try_state::<AppState>()
        .map(|s| AppState::clone(&s))
        .ok_or_else(|| internal("the app state is not ready yet"))?;
    let fixes = st.fixes.clone();
    let find = || async {
        // Re-check: the user confirmed a version a moment ago, but the release may have changed.
        Ok(find_update(&app).await?.map(|u| (u.version.clone(), u)))
    };
    let install = |mut update: Update| async move {
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        // `download` verifies the minisign signature (and the signed version) before returning bytes.
        let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| map_error(Stage::Install, &e))?;
        // No order can have started (the update ticket is held), but a recovery pass may run.
        refuse_while_fixing(&fixes)?;
        // Windows: the installer is launched and this process exits inside `install`
        // (`installMode: passive`, the installer starts the new version). macOS / Linux: files
        // are replaced, then we restart. Off the async workers: a Linux package install waits for
        // the administrator prompt.
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|e| internal(&format!("the install task stopped unexpectedly ({e})")))?
            .map_err(|e| map_error(Stage::Install, &e))
    };
    let ticket = guarded_install(&st.fixes, checked_version(&st), find, install).await?;
    // The new version is in place: no work order may start before the restart, so the ticket is
    // never released.
    std::mem::forget(ticket);
    // Through `ExitRequested`, so the usual "fixes are being applied" guard still holds.
    app.request_restart();
    Ok(())
}

/// The install sequence without the updater itself (so it can be tested): enter the "update
/// installing" state (a `Conflict` while an order executes or another install runs), re-check
/// with `find` (version, update), insist on the `checked` version, then `install`. Returns the
/// still-held ticket on success; every error releases it.
async fn guarded_install<U, F, I>(
    fixes: &FixState,
    checked: Option<String>,
    find: impl FnOnce() -> F,
    install: impl FnOnce(U) -> I,
) -> Cmd<UpdateTicket>
where
    F: Future<Output = Cmd<Option<(String, U)>>>,
    I: Future<Output = Cmd<()>>,
{
    let ticket = fixes.begin_update()?;
    let Some(checked) = checked else {
        return Err(not_checked());
    };
    let Some((version, update)) = find().await? else {
        return Err(no_update_anymore());
    };
    if version != checked {
        return Err(newer_published(&version));
    }
    install(update).await?;
    Ok(ticket)
}

/// What `check_update` showed (None: up to date or never checked).
fn remember_checked(st: &AppState, version: Option<String>) {
    *st.checked_update.lock().unwrap_or_else(|p| p.into_inner()) = version;
}

fn checked_version(st: &AppState) -> Option<String> {
    st.checked_update.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// The release the endpoint announces, if it is newer than this build.
async fn find_update<R: Runtime>(app: &AppHandle<R>) -> Cmd<Option<Update>> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| map_error(Stage::Check, &e))?;
    updater.check().await.map_err(|e| map_error(Stage::Check, &e))
}

fn update_info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.as_ref().map(|b| b.trim().to_string()).filter(|b| !b.is_empty()),
        date: update.date.and_then(|d| d.format(&time::format_description::well_known::Rfc3339).ok()),
    }
}

/// `Conflict` while any work order executes (or a recovery pass runs).
fn refuse_while_fixing(fixes: &FixState) -> Cmd<()> {
    if fixes.any_executing() {
        return Err(app_error(
            ErrorKind::Conflict,
            "Modpack Doctor is applying fixes to a mods folder right now, and installing an update restarts the app. \
             Wait until the fixes are finished, then install the update.",
        ));
    }
    Ok(())
}

fn not_checked() -> AppError {
    app_error(ErrorKind::Conflict, "Check for updates first, then install the version shown.")
}

fn newer_published(version: &str) -> AppError {
    let shown: String = version.chars().filter(|c| !c.is_control()).take(64).collect();
    app_error(
        ErrorKind::Conflict,
        &format!("A newer update ({shown}) was published since you checked; check for updates again."),
    )
}

fn no_update_anymore() -> AppError {
    app_error(
        ErrorKind::Conflict,
        "There is no update to install anymore: Modpack Doctor is up to date, or the release was withdrawn. \
         Check for updates again.",
    )
}

/// A readable `AppError` for every updater failure.
fn map_error(stage: Stage, e: &UpdaterError) -> AppError {
    let reach = match stage {
        Stage::Check => "Could not reach GitHub to check for updates. Check your internet connection, then try again.",
        Stage::Install => {
            "Could not reach GitHub to download the update. Check your internet connection, then try again. Nothing was changed."
        }
    };
    match e {
        // No answer at all: no connection, DNS failure, refused, timed out.
        UpdaterError::Reqwest(r) if r.is_connect() || r.is_timeout() || r.is_request() => {
            app_error(ErrorKind::Offline, reach)
        }
        UpdaterError::Reqwest(r) => app_error(
            ErrorKind::Network,
            &match stage {
                Stage::Check => format!("GitHub's update information could not be read ({}). Try again later.", plain(r)),
                Stage::Install => {
                    format!("The update download from GitHub was interrupted ({}). Nothing was changed; try again later.", plain(r))
                }
            },
        ),
        // A non-success status for `latest.json` (also before the first release is published).
        UpdaterError::ReleaseNotFound => app_error(
            ErrorKind::Network,
            "GitHub did not return update information. There may be no published release yet; try again later.",
        ),
        UpdaterError::Network(status) => app_error(
            ErrorKind::Network,
            &match stage {
                Stage::Check => {
                    format!("Updates could not be checked on GitHub ({}). Try again later.", status.trim_matches('`'))
                }
                Stage::Install => format!(
                    "The update could not be downloaded from GitHub ({}). Nothing was changed; try again later.",
                    status.trim_matches('`')
                ),
            },
        ),
        UpdaterError::Serialization(_) | UpdaterError::Semver(_) => app_error(
            ErrorKind::Network,
            &format!("The update information on GitHub is not valid ({e}). Try again later, or download the release from {RELEASES_URL}."),
        ),
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => app_error(
            ErrorKind::Network,
            &format!("The latest release has no in-app update for this system. Download it from {RELEASES_URL} instead."),
        ),
        // The download does not match the release signature: never installed.
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => app_error(
            ErrorKind::HashMismatch,
            &format!(
                "The downloaded update failed signature verification, so it was not installed. Nothing was changed. \
                 If this keeps happening, download the release from {RELEASES_URL}."
            ),
        ),
        UpdaterError::AuthenticationFailed => app_error(
            ErrorKind::Permission,
            "The update was not installed because the administrator prompt was cancelled or failed. Nothing was changed.",
        ),
        UpdaterError::PreviousAppNotRestored(path) => AppError {
            path: Some(path.display().to_string()),
            ..app_error(
                ErrorKind::Io,
                &format!(
                    "The update could not be installed, and the previous version could not be put back; it was kept at {}. \
                     Download the release from {RELEASES_URL} to reinstall.",
                    path.display()
                ),
            )
        },
        UpdaterError::Io(_)
        | UpdaterError::TempDirNotFound
        | UpdaterError::TempDirNotOnSameMountPoint
        | UpdaterError::FailedToDetermineExtractPath
        | UpdaterError::BinaryNotFoundInArchive
        | UpdaterError::InvalidUpdaterFormat
        | UpdaterError::DebInstallFailed
        | UpdaterError::PackageInstallFailed => app_error(
            ErrorKind::Io,
            &format!(
                "The update could not be installed ({}). The current version keeps working; you can also download the release from {RELEASES_URL}.",
                plain(e)
            ),
        ),
        // Configuration or platform problems in this build (endpoints, URL, unsupported OS, ...).
        other => internal(&format!("the updater failed ({})", plain(other))),
    }
}

/// An error's text without a trailing period, for use inside a sentence.
fn plain(e: &dyn std::fmt::Display) -> String {
    e.to_string().trim().trim_end_matches('.').to_string()
}

fn internal(what: &str) -> AppError {
    app_error(ErrorKind::Internal, &format!("Internal error: {what}. Please report this."))
}

fn app_error(kind: ErrorKind, message: &str) -> AppError {
    AppError { kind, message: message.to_string(), path: None, retry_after_s: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CONTRACTS.md invariant 18, verbatim.
    const CONTRACT_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM0MTRBMjc3NTE0MDZFOEUKUldTT2JrQlJkNklVeEpWU1BWcjFHYkhYa3R3bDVEc0lLaG04cFJrdUZLN0RwSnhEQ1hxYmo1ajgK";
    const CONTRACT_ENDPOINT: &str = "https://github.com/KingCreeper531/modpack-doctor/releases/latest/download/latest.json";

    fn assert_sentence(e: &AppError) {
        assert!(e.message.ends_with('.'), "not a sentence: {}", e.message);
        assert!(e.message.chars().next().is_some_and(char::is_uppercase), "not a sentence: {}", e.message);
        assert!(!e.message.contains("Modrinth"), "updates never involve Modrinth: {}", e.message);
    }

    #[test]
    fn install_is_refused_while_a_work_order_executes() {
        let fixes = FixState::default();
        assert!(refuse_while_fixing(&fixes).is_ok());
        let ticket = fixes.claim("0123456789abcdef", "Test Pack").expect("claim");
        let e = refuse_while_fixing(&fixes).expect_err("refused while executing");
        assert_eq!(e.kind, ErrorKind::Conflict);
        assert_sentence(&e);
        drop(ticket);
        assert!(refuse_while_fixing(&fixes).is_ok());
    }

    type Found = Cmd<Option<(String, ())>>;

    fn found(version: &str) -> impl FnOnce() -> std::future::Ready<Found> {
        let v = version.to_string();
        move || std::future::ready(Ok(Some((v, ()))))
    }

    fn installs_ok(_: ()) -> std::future::Ready<Cmd<()>> {
        std::future::ready(Ok(()))
    }

    #[tokio::test]
    async fn an_update_installing_refuses_work_orders_until_released() {
        let fixes = FixState::default();
        let ticket = fixes.begin_update().expect("begin");
        assert!(fixes.is_updating());
        let e = AppError::from(fixes.claim("0123456789abcdef", "Test Pack").expect_err("no order may start"));
        assert_eq!(e.kind, ErrorKind::Conflict);
        assert!(e.message.starts_with("An update is being installed"), "{}", e.message);
        assert_sentence(&e);
        // The window may still close (the restart goes through the same guard).
        assert!(!fixes.any_executing());
        drop(ticket);
        assert!(!fixes.is_updating());
        drop(fixes.claim("0123456789abcdef", "Test Pack").expect("claim after release"));
    }

    #[tokio::test]
    async fn an_executing_order_refuses_the_install() {
        let fixes = FixState::default();
        let order = fixes.claim("0123456789abcdef", "Test Pack").expect("claim");
        let e = guarded_install(&fixes, Some("0.2.0".into()), found("0.2.0"), installs_ok).await.expect_err("refused");
        assert_eq!(e.kind, ErrorKind::Conflict);
        assert!(e.message.contains("applying fixes"), "{}", e.message);
        assert_sentence(&e);
        assert!(!fixes.is_updating(), "a refused install leaves no update state behind");
        drop(order);
        assert!(guarded_install(&fixes, Some("0.2.0".into()), found("0.2.0"), installs_ok).await.is_ok());
    }

    #[tokio::test]
    async fn no_order_can_start_between_the_final_check_and_the_install() {
        let fixes = FixState::default();
        let during = fixes.clone();
        let ticket = guarded_install(&fixes, Some("0.2.0".into()), found("0.2.0"), move |()| {
            // Inside `install` (where Windows exits the process): an order still cannot start.
            let refused = during.claim("0123456789abcdef", "Test Pack").is_err();
            std::future::ready(if refused { Ok(()) } else { Err(internal("an order started during the install")) })
        })
        .await
        .expect("installed");
        // Still held after a successful install (until the restart).
        assert!(fixes.claim("0123456789abcdef", "Test Pack").is_err());
        drop(ticket);
    }

    #[tokio::test]
    async fn a_second_concurrent_install_is_a_conflict() {
        let fixes = FixState::default();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (go_tx, go_rx) = tokio::sync::oneshot::channel::<()>();
        let first_fixes = fixes.clone();
        let first = tokio::spawn(async move {
            guarded_install(&first_fixes, Some("0.2.0".into()), found("0.2.0"), move |()| async move {
                started_tx.send(()).ok();
                go_rx.await.ok();
                Ok(())
            })
            .await
            .map(drop)
        });
        started_rx.await.expect("first install running");
        let e = guarded_install(&fixes, Some("0.2.0".into()), found("0.2.0"), installs_ok).await.expect_err("second refused");
        assert_eq!(e.kind, ErrorKind::Conflict);
        assert!(e.message.contains("already being installed"), "{}", e.message);
        assert_sentence(&e);
        go_tx.send(()).ok();
        first.await.unwrap().expect("first install finished");
        assert!(!fixes.is_updating());
    }

    #[tokio::test]
    async fn every_error_releases_the_update_state() {
        let fixes = FixState::default();
        let failing_install = |()| std::future::ready(Err(map_error(Stage::Install, &UpdaterError::AuthenticationFailed)));
        let e = guarded_install(&fixes, Some("0.2.0".into()), found("0.2.0"), failing_install).await.expect_err("failed");
        assert_eq!(e.kind, ErrorKind::Permission);
        assert!(!fixes.is_updating());

        let failing_check = || std::future::ready::<Found>(Err(map_error(Stage::Check, &UpdaterError::ReleaseNotFound)));
        assert!(guarded_install(&fixes, Some("0.2.0".into()), failing_check, installs_ok).await.is_err());
        assert!(!fixes.is_updating());

        let gone = || std::future::ready::<Found>(Ok(None));
        let e = guarded_install(&fixes, Some("0.2.0".into()), gone, installs_ok).await.expect_err("gone");
        assert_eq!(e.message, no_update_anymore().message);
        assert!(!fixes.is_updating());
        drop(fixes.claim("0123456789abcdef", "Test Pack").expect("orders work again"));
    }

    #[tokio::test]
    async fn only_the_version_shown_is_installed() {
        let fixes = FixState::default();
        let never = |()| std::future::ready::<Cmd<()>>(Err(internal("must not install")));
        let e = guarded_install(&fixes, None, found("0.2.0"), never).await.expect_err("not checked");
        assert_eq!(e.kind, ErrorKind::Conflict);
        assert!(e.message.contains("Check for updates first"), "{}", e.message);
        assert_sentence(&e);

        let e = guarded_install(&fixes, Some("0.2.0".into()), found("0.3.0"), never).await.expect_err("newer");
        assert_eq!(e.kind, ErrorKind::Conflict);
        assert_eq!(e.message, "A newer update (0.3.0) was published since you checked; check for updates again.");
        assert!(!fixes.is_updating());

        assert!(guarded_install(&fixes, Some("0.3.0".into()), found("0.3.0"), installs_ok).await.is_ok());
    }

    #[test]
    fn remembering_a_check_never_touches_the_install_or_order_state() {
        // The startup check (opt-in) and the button run the same `check_update`: while an
        // install holds the update ticket, or an order executes, a check changes neither.
        let st = AppState::default();
        let ticket = st.fixes.begin_update().expect("begin");
        remember_checked(&st, Some("0.2.0".into()));
        assert!(st.fixes.is_updating());
        drop(ticket);
        let order = st.fixes.claim("0123456789abcdef", "Test Pack").expect("claim");
        remember_checked(&st, Some("0.3.0".into()));
        assert!(st.fixes.any_executing() && !st.fixes.is_updating());
        drop(order);
        assert_eq!(checked_version(&st).as_deref(), Some("0.3.0"));
    }

    #[test]
    fn check_update_remembers_the_version_shown() {
        let st = AppState::default();
        assert_eq!(checked_version(&st), None);
        remember_checked(&st, Some("0.2.0".into()));
        assert_eq!(checked_version(&AppState::clone(&st)).as_deref(), Some("0.2.0"));
        remember_checked(&st, None);
        assert_eq!(checked_version(&st), None);
    }

    #[test]
    fn no_update_anymore_is_a_readable_conflict() {
        let e = no_update_anymore();
        assert_eq!(e.kind, ErrorKind::Conflict);
        assert_sentence(&e);
    }

    #[test]
    fn remote_problems_map_to_network() {
        for (e, needle) in [
            (UpdaterError::ReleaseNotFound, "no published release"),
            (UpdaterError::Network("`Download request failed with status: 404 Not Found`".into()), "(Download request failed with status: 404 Not Found)"),
            (UpdaterError::TargetNotFound("linux-x86_64".into()), RELEASES_URL),
            (UpdaterError::TargetsNotFound(vec!["windows-x86_64-msi".into()]), RELEASES_URL),
            (UpdaterError::Serialization(serde_json::from_str::<u8>("x").unwrap_err()), "not valid"),
        ] {
            let mapped = map_error(Stage::Check, &e);
            assert_eq!(mapped.kind, ErrorKind::Network, "{e:?}");
            assert!(mapped.message.contains(needle), "{}", mapped.message);
            assert_sentence(&mapped);
        }
        // A status error while checking is about checking, not downloading.
        let status = UpdaterError::Network("`Download request failed with status: 500`".into());
        let check = map_error(Stage::Check, &status);
        assert!(check.message.contains("could not be checked") && !check.message.contains("downloaded"), "{}", check.message);
        assert_sentence(&check);
        assert!(map_error(Stage::Install, &status).message.contains("could not be downloaded"));
    }

    #[test]
    fn signature_failures_are_never_installed() {
        for e in [
            UpdaterError::SignedVersionMismatch { signed: "0.1.0".into(), announced: "0.2.0".into() },
            UpdaterError::MissingSignedVersion,
            UpdaterError::SignatureUtf8("x".into()),
        ] {
            let mapped = map_error(Stage::Install, &e);
            assert_eq!(mapped.kind, ErrorKind::HashMismatch, "{e:?}");
            assert!(mapped.message.contains("not installed"), "{}", mapped.message);
            assert_sentence(&mapped);
        }
    }

    #[test]
    fn install_failures_are_readable() {
        let e = map_error(Stage::Install, &UpdaterError::AuthenticationFailed);
        assert_eq!(e.kind, ErrorKind::Permission);
        assert_sentence(&e);

        let e = map_error(Stage::Install, &UpdaterError::PreviousAppNotRestored("/tmp/old.app".into()));
        assert_eq!((e.kind, e.path.as_deref()), (ErrorKind::Io, Some("/tmp/old.app")));
        assert_sentence(&e);

        let e = map_error(Stage::Install, &UpdaterError::Io(std::io::Error::other("disk full")));
        assert_eq!(e.kind, ErrorKind::Io);
        assert!(e.message.contains("(disk full)"), "{}", e.message);
        assert_sentence(&e);

        let e = map_error(Stage::Check, &UpdaterError::EmptyEndpoints);
        assert_eq!(e.kind, ErrorKind::Internal);
        assert!(e.message.contains("(Updater does not have any endpoints set)"), "{}", e.message);
        assert_sentence(&e);
    }

    #[tokio::test]
    async fn unreachable_github_maps_to_offline() {
        // A port nothing listens on: the connection is refused without leaving this machine.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut messages = Vec::new();
        for stage in [Stage::Check, Stage::Install] {
            let err = reqwest::Client::new().get(format!("http://127.0.0.1:{port}/latest.json")).send().await.unwrap_err();
            assert!(err.is_connect(), "{err:?}");
            let e = map_error(stage, &UpdaterError::Reqwest(err));
            assert_eq!(e.kind, ErrorKind::Offline, "{e:?}");
            assert!(e.message.contains("internet connection"), "{}", e.message);
            assert_sentence(&e);
            messages.push(e.message);
        }
        assert!(messages[1].contains("Nothing was changed"), "{}", messages[1]);
    }

    #[tokio::test]
    async fn timeouts_are_offline_and_bad_answers_are_network() {
        use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(path("/slow")).respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(5))).mount(&server).await;
        Mock::given(path("/garbage")).respond_with(ResponseTemplate::new(200).set_body_string("not json")).mount(&server).await;
        let client = reqwest::Client::builder().timeout(Duration::from_millis(200)).build().unwrap();

        let err = client.get(format!("{}/slow", server.uri())).send().await.unwrap_err();
        assert!(err.is_timeout());
        assert_eq!(map_error(Stage::Check, &UpdaterError::Reqwest(err)).kind, ErrorKind::Offline);

        let err = client.get(format!("{}/garbage", server.uri())).send().await.unwrap().json::<serde_json::Value>().await.unwrap_err();
        let e = map_error(Stage::Check, &UpdaterError::Reqwest(err));
        assert_eq!(e.kind, ErrorKind::Network);
        assert!(e.message.starts_with("GitHub's update information could not be read ("), "{}", e.message);
        assert_sentence(&e);
    }

    #[test]
    fn updater_config_matches_the_contract() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let updater = &conf["plugins"]["updater"];
        assert_eq!(updater["pubkey"], CONTRACT_PUBKEY);
        assert_eq!(updater["endpoints"], serde_json::json!([CONTRACT_ENDPOINT]));
        assert_eq!(updater["windows"]["installMode"], "passive");
        // The signature must name the announced version (no replay of an older signed release).
        assert_eq!(updater["requireSignedVersion"], true);
        assert!(updater.get("allowDowngrades").is_none());
        // Unsigned local builds: updater artifacts are only made by the release config (CI).
        assert!(conf["bundle"].get("createUpdaterArtifacts").is_none());
        let release: serde_json::Value = serde_json::from_str(include_str!("../../tauri.release.conf.json")).unwrap();
        assert_eq!(release["bundle"]["createUpdaterArtifacts"], true);
    }

    #[test]
    fn the_webview_gets_no_updater_or_process_permission() {
        let caps = include_str!("../../capabilities/main.json");
        assert!(!caps.contains("updater"), "the updater runs in Rust only");
        assert!(!caps.contains("process:"), "the webview may not restart or exit the app");
    }
}
