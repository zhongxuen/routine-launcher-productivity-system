//! Section 85's update strategy: how a build that is already installed
//! becomes the next one.
//!
//! Everything else in section 85 is about the *first* install — an installer,
//! an icon, a version number, a `Run` key. This is the part that happens
//! afterwards, and it is the only feature in the app that opens a socket.
//!
//! ## What it does
//!
//! [`check`] asks one URL for a signed manifest describing the newest
//! release, and `tauri-plugin-updater` compares its version against this
//! build's. [`install`] downloads the installer that manifest points at,
//! verifies its minisign signature against the public key baked into
//! `tauri.conf.json`, and runs it. The NSIS package is a per-user
//! install-over-the-top (see the *Packaging* section of README.md), so the
//! update is the same operation the user would perform by double-clicking the
//! next `-setup.exe` — which is exactly why it can be trusted to keep their
//! database: nothing here touches `%APPDATA%`.
//!
//! ## What it does not do
//!
//! It never installs anything the user did not ask for. The launch check
//! ([`check_on_launch`]) only ever *checks*; downloading and running an
//! installer is always a button. That separation is the whole reason the
//! setting is one switch rather than two — there is no "install
//! automatically" to turn off, because there is no such mode.
//!
//! It also sends nothing. The check is a `GET` for a static JSON file and the
//! download is a `GET` for a static installer; neither carries a request body,
//! an identifier or anything read out of the database. Section 68's promise is
//! about *the user's data*, and the user's data does not leave — but the
//! promise is worth stating precisely now that the process can reach the
//! network at all, which is why [`CHECK_ON_LAUNCH_KEY`] exists and why
//! Settings says in words what the check consists of.
//!
//! ## Why it goes through this app's own commands
//!
//! The plugin registers four JavaScript commands of its own, and none of them
//! is granted to any window — `updater:default` is in no capability, exactly
//! as `autostart:default` is not (see `capabilities/desktop.json`). Section
//! 86's rule is that native operations belong behind this app's commands, and
//! running an installer is about as native as this app gets. Going through
//! `commands/updates.rs` is also what lets the two things below happen at all,
//! neither of which the plugin's own path would do:
//!
//! * The running focus session is closed before the installer takes over.
//!   `Update::install` ends with `std::process::exit(0)` on Windows, so no
//!   window ever receives a close event and `lib.rs`'s
//!   `CloseRequested` handler — the thing that normally records an
//!   interrupted session — never runs. The next launch would catch the stale
//!   row, but it would blame "the last run" for something the user did on
//!   purpose. See [`install`].
//! * The user is asked first, and the switch that decides whether they are
//!   asked lives in the `settings` table with every other preference.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use super::error::ServiceResult;
use super::settings;
use crate::db::DbConnection;

/// Whether to look for a new release once per launch.
///
/// Namespaced like every other key in the `settings` table — see
/// `services::settings`.
pub const CHECK_ON_LAUNCH_KEY: &str = "updates.check_on_launch";

/// On, unless the user says otherwise.
///
/// An updater nobody has switched on is a build that quietly rots, and this
/// app is the sort of thing that sits in a tray for months between the times
/// its owner thinks about it. The check costs one request per launch and can
/// only ever *report*; the install is still a button. That is the trade the
/// default is making, and the switch is one click away in Settings for
/// anybody who would rather it did not.
pub const DEFAULT_CHECK_ON_LAUNCH: bool = true;

/// Emitted while [`install`] is downloading, so the button can show a bar
/// instead of a spinner that means nothing.
pub const PROGRESS_EVENT: &str = "updates://progress";

/// A release newer than the running build.
///
/// Deliberately not the plugin's `Update`: that value carries the download
/// URL, the signature and the handles needed to run an installer, and none of
/// that is any of the frontend's business. What crosses the boundary is what
/// a person needs in order to decide — which version, from which version, what
/// changed, and when.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    /// The version being offered.
    pub version: String,
    /// The version doing the offering, so the card can say "0.1.3 → 0.2.0"
    /// without asking a second command what it is running.
    pub current_version: String,
    /// The release notes from the manifest, if it carried any.
    pub notes: Option<String>,
    /// The release date as `YYYY-MM-DD`, if the manifest carried one.
    pub date: Option<String>,
}

/// Payload of [`PROGRESS_EVENT`].
///
/// `total` is an `Option` because it comes from a `Content-Length` header the
/// server is not obliged to send. A progress bar that cannot know the total
/// is an indeterminate one, and that is worth telling the frontend rather
/// than papering over with a zero it would divide by.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Whether the app should look for a new release when it starts.
pub fn check_on_launch(conn: &rusqlite::Connection) -> ServiceResult<bool> {
    settings::get_bool(conn, CHECK_ON_LAUNCH_KEY, DEFAULT_CHECK_ON_LAUNCH)
}

/// Turns the launch check on or off.
pub fn set_check_on_launch(conn: &rusqlite::Connection, enabled: bool) -> ServiceResult<()> {
    settings::set_bool(conn, CHECK_ON_LAUNCH_KEY, enabled)
}

/// Asks the release endpoint whether there is anything newer than this build.
///
/// `Ok(None)` is the ordinary answer and means "you are up to date" — it is
/// not a failure and the UI does not treat it as one. An `Err` is a network
/// that could not be reached, an endpoint that answered with something other
/// than a manifest, or a manifest whose signature does not match the public
/// key this build carries. All three are the same thing to the user (we could
/// not find out) and all three are worth a line in the log, because the third
/// one is the only symptom a tampered-with release would ever produce.
pub async fn check(app: &AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let updater = app
        .updater()
        .map_err(|error| format!("could not prepare the update check: {error}"))?;

    let found = updater
        .check()
        .await
        .map_err(|error| format!("could not check for updates: {error}"))?;

    let Some(update) = found else {
        return Ok(None);
    };

    Ok(Some(AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        // `Date`'s own `Display` is ISO 8601, which is the one format that
        // means the same thing in every locale reading the log next to it.
        date: update.date.map(|date| date.date().to_string()),
    }))
}

/// Downloads the newest release and hands the machine to its installer.
///
/// On Windows this function does not return: the plugin runs the NSIS package
/// and calls `std::process::exit(0)`, and the installer relaunches the app
/// when it is done. Everything that has to happen before the process ends
/// therefore has to happen *here*, above the call — which at present is one
/// thing, the running focus session.
///
/// The check is repeated rather than a handle being kept from [`check`]. It
/// costs one small request, and it buys two things: the button cannot install
/// a release that has since been replaced by the manifest it was shown from,
/// and nothing has to hold a live `Update` — with its download URL and
/// signature — in application state between two user gestures that may be
/// minutes apart.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|error| format!("could not prepare the update: {error}"))?;

    let update = updater
        .check()
        .await
        .map_err(|error| format!("could not check for updates: {error}"))?
        .ok_or_else(|| {
            "There is no update to install — this is already the newest release.".to_string()
        })?;

    crate::log_info!(
        "[updates] installing {} over {}",
        update.version,
        update.current_version
    );

    close_running_focus_session(app);

    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let progress = DownloadProgress { downloaded, total };
                // A progress bar that fell behind is not worth failing an
                // install over, and there is nowhere useful to report it to:
                // the window it would be reported in is the one that is not
                // listening.
                let _ = app.emit(PROGRESS_EVENT, progress);
            },
            || crate::log_info!("[updates] download finished; running the installer"),
        )
        .await
        .map_err(|error| format!("could not install the update: {error}"))?;

    Ok(())
}

/// Records the focus session the update is about to interrupt.
///
/// Called immediately before the installer takes the process, because the
/// close handler in `lib.rs` never runs for an exit that skips the window
/// system. A failure is logged and ignored: the next launch closes a session
/// this one left open anyway, and refusing to update over a row would be the
/// worse answer.
fn close_running_focus_session(app: &AppHandle) {
    let Some(state) = app.try_state::<DbConnection>() else {
        crate::log_warn!("[updates] the database is not ready; no session to close");
        return;
    };

    match state.lock() {
        Ok(conn) => crate::close_abandoned_focus_session(&conn, "was running when an update began"),
        Err(error) => {
            crate::log_error!("[updates] could not reach the database before installing: {error}")
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    #[test]
    fn the_launch_check_defaults_on_and_survives_being_turned_off() {
        let conn = init_memory_db().unwrap();

        assert_eq!(check_on_launch(&conn).unwrap(), DEFAULT_CHECK_ON_LAUNCH);

        set_check_on_launch(&conn, false).unwrap();
        assert!(!check_on_launch(&conn).unwrap());

        set_check_on_launch(&conn, true).unwrap();
        assert!(check_on_launch(&conn).unwrap());
    }

    #[test]
    fn the_setting_key_is_namespaced_to_this_feature() {
        // Every key in the `settings` table is `feature.name`, so two
        // features can never collide on one — see `services::settings`.
        assert!(CHECK_ON_LAUNCH_KEY.starts_with("updates."));
    }
}
