//! Commands for the Large File Finder (development-plan.md sections 38, 41,
//! 67).
//!
//! Thin wrappers over `services::large_files`, per section 86's layering,
//! with two jobs that only this layer can do.
//!
//! **Keeping the database out of the walk.** The app shares one SQLite
//! connection behind a mutex. A scan of a large tree runs for seconds, so
//! [`scan_large_files`] takes the lock twice for a moment each — once to read
//! the ignore list, once afterwards to remember what was scanned — and walks
//! the filesystem in between with nothing held. The walk itself goes to
//! `spawn_blocking` so it is not sitting on an async worker either; the UI
//! shows a spinner and everything else in the app carries on.
//!
//! **Knowing where Documents is.** The default archive folder is derived from
//! the OS's Documents directory, which needs Tauri's path resolver — the
//! service takes it as an argument so it stays free of the Tauri runtime and
//! testable without one.
//!
//! Every destructive command here acts on exactly one file and is reached
//! only from a confirmation the user has just accepted. There is no batch
//! command, deliberately: section 67's sequence is scan -> show -> select ->
//! confirm -> act, and a "delete all of these" entry point would be a way
//! around the third and fourth steps.
//!
//! Move, Archive and Delete each leave a row in `cleanup_actions` when the
//! file was handled, for the cleanup quest and the Organized achievement.
//! The row is written afterwards, with the lock taken only then, and holds no
//! path.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::db::DbConnection;
use crate::services::cleanup_actions::{self, CleanupAction, CleanupUtility};
use crate::services::large_files::{
    self, FileActionResult, LargeFilePreferences, LargeFileScan,
};

/// The folder Archive uses until the user picks another.
///
/// `Documents/Routine Launcher Archive`, because Documents is backed up by
/// every backup tool people actually run and is somewhere they will think to
/// look six months later. Falls back to the home directory and then to the
/// app's own data directory, so the Archive button always has somewhere to
/// go — an action that could be unavailable because a path lookup failed
/// would be worse than one filing into a slightly odd place.
fn default_archive_root(app: &AppHandle) -> String {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| PathBuf::from("."));

    base.join("Routine Launcher Archive").display().to_string()
}

/// The archive folder in force: the user's if they chose one, otherwise the
/// default above.
fn archive_root(app: &AppHandle, db: &State<DbConnection>) -> Result<PathBuf, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let prefs = large_files::preferences(&conn, &default_archive_root(app))
        .map_err(|e| e.to_string())?;

    Ok(PathBuf::from(prefs.archive_root))
}

// ---------------------------------------------------------------------------
// Opening the view
// ---------------------------------------------------------------------------

/// Where the last scan ran, how big "big" was, what is ignored, and where
/// Archive puts things — everything the view needs before it can offer a
/// scan.
#[tauri::command]
pub fn get_large_file_preferences(
    app: AppHandle,
    db: State<DbConnection>,
) -> Result<LargeFilePreferences, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    large_files::preferences(&conn, &default_archive_root(&app)).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Walks `folder` and answers with the files over `threshold_mb`, largest
/// first.
///
/// Read-only. This is step one of section 67's sequence and does nothing but
/// look: no file is opened, moved or removed by any path through it, whatever
/// the scan turns up.
///
/// Async so the walk lands on a blocking thread rather than on the main one —
/// a synchronous Tauri command runs on the main thread, and a forty-second
/// scan there would freeze every window the app has.
#[tauri::command]
pub async fn scan_large_files(
    db: State<'_, DbConnection>,
    folder: String,
    threshold_mb: u64,
) -> Result<LargeFileScan, String> {
    let threshold = large_files::threshold_bytes(threshold_mb).map_err(|e| e.to_string())?;

    let ignored: HashSet<String> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        large_files::ignored_keys(&conn).map_err(|e| e.to_string())?
        // The guard goes here on purpose. Everything below reads the disk,
        // which must not hold the database — the same rule
        // `commands::routines::launch_routine` follows before it launches
        // anything.
    };

    let root = PathBuf::from(&folder);
    let scan = tauri::async_runtime::spawn_blocking(move || {
        large_files::scan(&root, threshold, &ignored)
    })
    .await
    .map_err(|error| format!("The scan could not be run: {error}"))?
    .map_err(|e| e.to_string())?;

    // Remembered only now that the folder has proved to be a folder, so a
    // mistyped path is not the one the view reopens on next time. A failure
    // to remember is not a failure to scan: the results are already in hand
    // and are what the user asked for.
    if let Ok(conn) = db.lock() {
        if let Err(error) = large_files::remember_scan(&conn, &scan.root, threshold_mb) {
            crate::log_error!("could not remember the large-file scan: {error}");
        }
    }

    Ok(scan)
}

// ---------------------------------------------------------------------------
// The five actions of section 41
// ---------------------------------------------------------------------------

/// Opens a file with whatever application the OS has registered for it.
///
/// The only one of the five that changes nothing, and so the only one the UI
/// does not put behind a confirmation.
#[tauri::command]
pub fn open_large_file(path: String) -> Result<(), String> {
    large_files::open(Path::new(&path)).map_err(|e| e.to_string())
}

/// Moves one file into a folder the user picked. Confirmed in the UI first.
///
/// Never overwrites: a name already taken at the destination gets a `" (1)"`
/// suffix, and the result says so.
#[tauri::command]
pub fn move_large_file(
    db: State<DbConnection>,
    path: String,
    destination: String,
) -> Result<FileActionResult, String> {
    let result = large_files::move_to(Path::new(&path), Path::new(&destination))
        .map_err(|e| e.to_string())?;
    cleanup_actions::note(&db, CleanupUtility::LargeFiles, CleanupAction::Move, 1);
    Ok(result)
}

/// Moves one file into the archive folder, under `YYYY-MM` for the month it
/// was last changed. Confirmed in the UI first, showing that exact
/// destination.
///
/// `modified_ms` comes from the scan row rather than being re-read here so
/// the folder the confirmation named is the folder the file lands in.
#[tauri::command]
pub fn archive_large_file(
    app: AppHandle,
    db: State<DbConnection>,
    path: String,
    modified_ms: Option<i64>,
) -> Result<FileActionResult, String> {
    let root = archive_root(&app, &db)?;
    let result =
        large_files::archive(Path::new(&path), &root, modified_ms).map_err(|e| e.to_string())?;
    cleanup_actions::note(&db, CleanupUtility::LargeFiles, CleanupAction::Archive, 1);
    Ok(result)
}

/// Sends one file to the Recycle Bin. Confirmed in the UI first.
///
/// The Recycle Bin rather than an unlink, so the confirmation can promise the
/// file is recoverable and mean it. See `services::large_files::delete`.
#[tauri::command]
pub fn delete_large_file(
    db: State<DbConnection>,
    path: String,
) -> Result<FileActionResult, String> {
    let result = large_files::delete(Path::new(&path)).map_err(|e| e.to_string())?;
    cleanup_actions::note(&db, CleanupUtility::LargeFiles, CleanupAction::Delete, 1);
    Ok(result)
}

/// Hides a file from future scans, answering with the ignore list as it now
/// stands.
///
/// Not destructive and not confirmed: nothing on disk changes and the Ignored
/// panel undoes it in one click.
#[tauri::command]
pub fn ignore_large_file(db: State<DbConnection>, path: String) -> Result<Vec<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    large_files::ignore(&conn, &path).map_err(|e| e.to_string())
}

/// Puts an ignored file back in the results of the next scan.
#[tauri::command]
pub fn unignore_large_file(db: State<DbConnection>, path: String) -> Result<Vec<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    large_files::unignore(&conn, &path).map_err(|e| e.to_string())
}

/// Empties the ignore list.
#[tauri::command]
pub fn clear_ignored_large_files(db: State<DbConnection>) -> Result<Vec<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    large_files::clear_ignored(&conn).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// The archive folder
// ---------------------------------------------------------------------------

/// Points Archive at a folder of the user's choosing, answering with the
/// preferences as they now stand.
#[tauri::command]
pub fn set_large_file_archive_root(
    app: AppHandle,
    db: State<DbConnection>,
    folder: String,
) -> Result<LargeFilePreferences, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    large_files::set_archive_root(&conn, &folder).map_err(|e| e.to_string())?;
    large_files::preferences(&conn, &default_archive_root(&app)).map_err(|e| e.to_string())
}

/// Goes back to `Documents/Routine Launcher Archive`.
#[tauri::command]
pub fn reset_large_file_archive_root(
    app: AppHandle,
    db: State<DbConnection>,
) -> Result<LargeFilePreferences, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    large_files::reset_archive_root(&conn).map_err(|e| e.to_string())?;
    large_files::preferences(&conn, &default_archive_root(&app)).map_err(|e| e.to_string())
}
