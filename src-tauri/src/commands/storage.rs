//! Commands for the Storage Overview (development-plan.md sections 38, 66,
//! 67).
//!
//! Thin wrappers over `services::storage`, per section 86's layering, with
//! two jobs only this layer can do.
//!
//! **Knowing where the profile is.** `C:\Users\Ada` comes from Tauri's path
//! resolver, so the service stays free of the Tauri runtime and can be tested
//! against a temporary directory instead of the real profile.
//!
//! **Keeping the database and the main thread out of the walk.** Sizing a
//! folder takes seconds, so [`size_profile_folder`] is `async` and does its
//! walking on a blocking thread — a synchronous Tauri command runs on the
//! main thread, and a twenty-second walk there would freeze every window the
//! app has. No command here takes the `DbConnection` at all: this feature
//! stores nothing and remembers nothing between runs, so there is no row for
//! it to read.
//!
//! There is no destructive command here to guard, and that is the point of
//! the feature rather than an omission. The whole file reads: one command
//! lists drives and folders, one adds up a folder, one stops the adding up.
//! Nothing in it can move, delete or even open a file, so section 67's
//! scan → select → confirm → act has nothing here to reach past — the page
//! links into `commands::large_files` and `commands::duplicates` when the
//! user wants to act, and those keep their own guards.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::services::storage::{self, FolderSize, StorageOverview};

/// The user's profile folder — `C:\Users\Ada`.
///
/// Falls back to the app's own data directory, which is inside the profile
/// anyway, so the page has somewhere to describe even on a machine where the
/// home lookup fails. Never the current directory: that is wherever the app
/// happened to be launched from, and sizing it would be answering a question
/// nobody asked.
fn profile(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|error| format!("Your user folder could not be found: {error}"))
}

// ---------------------------------------------------------------------------
// Opening the page
// ---------------------------------------------------------------------------

/// The fixed drives with their space, the profile path, and the profile's
/// top-level folders — everything the page draws before any folder has been
/// sized.
///
/// Fast enough to be synchronous: one directory listing and a handful of OS
/// calls. It also starts a scan, so calling it again abandons whatever the
/// last visit left walking.
#[tauri::command]
pub fn storage_overview(app: AppHandle) -> Result<StorageOverview, String> {
    storage::overview(&profile(&app)?).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Sizing, one folder at a time
// ---------------------------------------------------------------------------

/// Adds up one top-level folder of the profile.
///
/// Read-only, and the slow one: seconds on `AppData`, which is why it runs on
/// a blocking thread and why the view calls it once per folder and draws each
/// answer as it arrives rather than waiting for the whole profile.
///
/// `token` comes from [`storage_overview`]. A call carrying a token from an
/// abandoned scan still runs — it is a read, and refusing it would be
/// pointless ceremony — but it stops at the first check and comes back saying
/// it was cancelled, which is what the view needs to know to discard it.
#[tauri::command]
pub async fn size_profile_folder(
    app: AppHandle,
    folder: String,
    token: u64,
) -> Result<FolderSize, String> {
    let profile = profile(&app)?;
    let folder = PathBuf::from(folder);

    tauri::async_runtime::spawn_blocking(move || storage::folder_size(&profile, &folder, token))
        .await
        .map_err(|error| format!("The folder could not be measured: {error}"))?
        .map_err(|e| e.to_string())
}

/// Stops the walk that is running now.
///
/// The Stop button, and also what the view calls when it is done with a scan.
/// Returns nothing because there is nothing to report: the call in flight
/// answers for itself, with `stopped` set.
#[tauri::command]
pub fn cancel_storage_scan() {
    storage::cancel_scan();
}
