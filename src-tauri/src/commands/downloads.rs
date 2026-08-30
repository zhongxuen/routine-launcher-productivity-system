//! Commands for Downloads Cleanup (development-plan.md sections 38-39).
//!
//! Thin, per section 86: each one resolves the user's Downloads folder from
//! Tauri's path resolver, hands the work to `services::downloads`, and
//! flattens the error to a `String` the UI can show as written.
//!
//! Resolving the folder is the one thing that cannot live in the service —
//! it needs the Tauri runtime — and it is deliberately the *only* way the
//! folder is chosen. No command here takes a folder from the frontend, so
//! there is no argument a bug or a stray `invoke` could set to make the
//! cleanup tools act somewhere else on the disk. `destination` on
//! [`move_downloads_files`] is the single path that comes in from outside,
//! it can only ever be a move *target*, and the service checks it exists and
//! is a directory before anything is written into it.
//!
//! Section 67's order — scan, show, select, confirm, act — is kept by what is
//! and is not exposed here: [`scan_downloads`] reads and changes nothing,
//! and the two that do change something take an explicit list of files.
//! There is no command that deletes "everything old" or "the whole
//! Installers category", because there is no point in the product where the
//! app, rather than the user, gets to decide that.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::services::downloads::{self, ActionReport, DownloadsScan};

/// The user's Downloads folder, as the OS reports it.
///
/// A machine with no Downloads folder at all is rare but real (a fresh
/// container, a locked-down profile), and it gets a sentence rather than a
/// panic — the rest of the app is unaffected by this one view not working.
fn downloads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let folder = app
        .path()
        .download_dir()
        .map_err(|error| format!("Could not find your Downloads folder: {error}"))?;

    if !folder.is_dir() {
        return Err(format!(
            "{} is not a folder that exists on this computer.",
            folder.to_string_lossy()
        ));
    }

    Ok(folder)
}

/// Step one of section 67: read the folder and describe it. Changes nothing.
#[tauri::command]
pub fn scan_downloads(app: AppHandle) -> Result<DownloadsScan, String> {
    let folder = downloads_dir(&app)?;
    downloads::scan(&folder).map_err(|error| error.to_string())
}

/// Moves the files the user selected into a folder they picked.
///
/// The recoverable action, and the one the review flow offers first: nothing
/// is lost, so a file that turns out to have been wanted is still there.
#[tauri::command]
pub fn move_downloads_files(
    app: AppHandle,
    paths: Vec<String>,
    destination: String,
) -> Result<ActionReport, String> {
    let folder = downloads_dir(&app)?;
    downloads::move_files(&folder, &paths, &destination).map_err(|error| error.to_string())
}

/// Deletes the files the user selected, permanently.
///
/// The last step of section 67's chain. It is only reached from a
/// confirmation dialog that names the count and says there is no undo, and
/// it never runs on a list the user did not tick: an empty `paths` is
/// refused by the service rather than treated as "all of them".
#[tauri::command]
pub fn delete_downloads_files(app: AppHandle, paths: Vec<String>) -> Result<ActionReport, String> {
    let folder = downloads_dir(&app)?;
    downloads::delete_files(&folder, &paths).map_err(|error| error.to_string())
}

/// Opens one downloaded file with whatever the OS opens it with.
///
/// Not part of section 67's chain — it changes nothing — but it is most of
/// how somebody decides. "Is this ZIP the one I still need?" is answered by
/// looking at it, and having to leave the app to look is how a review gets
/// abandoned half-finished. Guarded by the same [`downloads::resolve_file`]
/// check the destructive commands use, so this cannot become a way to launch
/// an arbitrary path.
#[tauri::command]
pub fn open_downloads_file(app: AppHandle, path: String) -> Result<(), String> {
    let folder = downloads_dir(&app)?;
    let resolved = downloads::resolve_file(&folder, &path).map_err(|error| error.to_string())?;

    tauri_plugin_opener::open_path(resolved.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("Could not open {path}: {error}"))
}

/// Shows one downloaded file in the OS file manager.
///
/// The other half of "let me look first", for the files that are quicker to
/// judge from Explorer than from opening them — and the safer of the two for
/// anything executable.
#[tauri::command]
pub fn reveal_downloads_file(app: AppHandle, path: String) -> Result<(), String> {
    let folder = downloads_dir(&app)?;
    let resolved = downloads::resolve_file(&folder, &path).map_err(|error| error.to_string())?;

    tauri_plugin_opener::reveal_item_in_dir(&resolved)
        .map_err(|error| format!("Could not show {path} in the file manager: {error}"))
}
