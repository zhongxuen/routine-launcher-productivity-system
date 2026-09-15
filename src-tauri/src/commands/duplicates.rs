//! Duplicate Finder commands (development-plan.md sections 38, 40, 67).
//!
//! Thin, as section 86 asks: every one of these parses its arguments, calls
//! `services::duplicates` and flattens the error to a `String`. The one thing
//! that happens *here* rather than in the service is resolving the default
//! folders — Downloads and Desktop come from Tauri's path resolver, and the
//! service is deliberately free of the runtime so its comparison logic can be
//! unit-tested without an app handle.
//!
//! The split of commands mirrors section 67's sequence rather than the data.
//! [`scan_duplicates`] reads and nothing else; [`delete_duplicate_files`] and
//! [`move_duplicate_files`] each take an explicit list of paths the user
//! selected and confirmed. There is no command that takes a scan and acts on
//! it, so "never automatic" is not something the frontend has to remember.
//!
//! The two that act leave a row in `cleanup_actions` once at least one file
//! was handled, for the cleanup quest and the Organized achievement. The row
//! is written after the files have been handled and holds no path.

use tauri::{AppHandle, Manager, State};

use crate::db::DbConnection;
use crate::services::cleanup_actions::{self, CleanupAction, CleanupUtility};
use crate::services::duplicates::{
    self, DuplicateScan, DuplicateScanRequest, FileActionResult,
};

/// The folders a scan starts with when the user has not chosen any: Downloads
/// and Desktop, per prompt 10.2, and only the ones that exist.
///
/// Filtered rather than reported as missing because a machine without a
/// Desktop folder is a configuration, not an error — the picker is right there
/// for anywhere else. Returned to the frontend as well as used as the scan
/// default so the UI can show what it is about to scan before it starts.
#[tauri::command]
pub fn default_duplicate_folders(app: AppHandle) -> Vec<String> {
    resolve_default_folders(&app)
}

/// Scans for duplicates. Read-only — see the module docs.
///
/// An omitted or empty `folders` means "the defaults", which is what the view
/// sends on first open. Anything else is exactly what the user picked.
#[tauri::command]
pub fn scan_duplicates(
    app: AppHandle,
    request: Option<DuplicateScanRequest>,
) -> Result<DuplicateScan, String> {
    let mut request = request.unwrap_or_default();
    if request.folders.iter().all(|folder| folder.trim().is_empty()) {
        request.folders = resolve_default_folders(&app);
        if request.folders.is_empty() {
            return Err(
                "Neither your Downloads nor your Desktop folder could be found. Choose a folder \
                 to scan."
                    .to_string(),
            );
        }
    }

    duplicates::scan(&request).map_err(|e| e.to_string())
}

/// Deletes the files the user selected and confirmed.
///
/// Permanent: nothing here goes to the recycle bin, which is why the
/// confirmation in front of it says so and why [`move_duplicate_files`] exists
/// beside it. Answers with one result per path — a partial failure is the
/// ordinary case (a file open in another program), and the caller needs to
/// know which ones.
#[tauri::command]
pub fn delete_duplicate_files(
    db: State<DbConnection>,
    paths: Vec<String>,
) -> Result<Vec<FileActionResult>, String> {
    let results = duplicates::delete_files(&paths).map_err(|e| e.to_string())?;
    cleanup_actions::note(
        &db,
        CleanupUtility::Duplicates,
        CleanupAction::Delete,
        succeeded(&results),
    );
    Ok(results)
}

/// Moves the files the user selected and confirmed into `destination`.
///
/// The reversible half of the same step. Never overwrites: a name already
/// taken at the destination gets ` (1)` appended.
#[tauri::command]
pub fn move_duplicate_files(
    db: State<DbConnection>,
    paths: Vec<String>,
    destination: String,
) -> Result<Vec<FileActionResult>, String> {
    let results = duplicates::move_files(&paths, &destination).map_err(|e| e.to_string())?;
    cleanup_actions::note(
        &db,
        CleanupUtility::Duplicates,
        CleanupAction::Move,
        succeeded(&results),
    );
    Ok(results)
}

/// How many of an action's files were actually handled.
fn succeeded(results: &[FileActionResult]) -> usize {
    results.iter().filter(|result| result.ok).count()
}

/// Opens a file's folder in the file explorer, so the user can look at a copy
/// before deciding anything about it.
#[tauri::command]
pub fn reveal_duplicate_file(path: String) -> Result<(), String> {
    duplicates::open_containing_folder(&path).map_err(|e| e.to_string())
}

/// Opens a file with whatever application the OS has registered for it — the
/// other half of "look before you delete".
#[tauri::command]
pub fn open_duplicate_file(path: String) -> Result<(), String> {
    duplicates::open_file(&path).map_err(|e| e.to_string())
}

/// Downloads and Desktop, in that order, keeping only what is on disk.
fn resolve_default_folders(app: &AppHandle) -> Vec<String> {
    let resolver = app.path();

    [resolver.download_dir(), resolver.desktop_dir()]
        .into_iter()
        .flatten()
        .filter(|folder| folder.is_dir())
        .map(|folder| folder.to_string_lossy().to_string())
        .collect()
}
