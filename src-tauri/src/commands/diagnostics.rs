//! The log's side of the `invoke` boundary (development-plan.md section 85).
//!
//! Three commands, and between them the whole of what the frontend is allowed
//! to do with the crash log:
//!
//! * [`log_frontend_error`] — write one entry. The React error boundary and
//!   the `error` / `unhandledrejection` listeners in each window call it.
//! * [`get_log_location`] — where the file is, so the crash screen can say
//!   "logs saved to ..." and Settings can show the folder.
//! * [`open_log_folder`] — open that folder in Explorer, with the active file
//!   selected.
//!
//! There is deliberately no command that *reads* the log back. The frontend
//! has no filesystem permission (see `capabilities/`), and a crash screen that
//! rendered the contents of a file it had just been told about would be one
//! more place a stack trace could be copied out of by something that had no
//! business with it. Where it is, and a button that opens Explorer, is the
//! whole of what the UI needs.
//!
//! And nothing here sends anything anywhere. Section 68's promise is kept by
//! there being no code that could: see `services::logging`.

use serde::Serialize;

use crate::services::logging;

/// Where the log lives, for the two places that tell the user about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLocation {
    /// The active file, e.g. `C:\Users\...\logs\routine-launcher.log`.
    pub file: String,
    /// The folder holding it and the rotated copies.
    pub folder: String,
    /// How many files that folder ever holds, and how large each may get —
    /// shown in Settings so "rotating" is a promise with a number on it
    /// rather than a word.
    pub kept_files: usize,
    pub max_file_bytes: u64,
}

/// Where the log file is.
///
/// Fails only when logging could not be started at all, which is the one case
/// where there is no honest answer — the UI says so rather than naming a path
/// nothing was written to.
#[tauri::command]
pub fn get_log_location() -> Result<LogLocation, String> {
    let file = logging::log_file()
        .ok_or_else(|| "Logging is not running, so there is no log file.".to_string())?;
    let folder = logging::log_dir()
        .ok_or_else(|| "Logging is not running, so there is no log folder.".to_string())?;

    Ok(LogLocation {
        file: file.to_string_lossy().into_owned(),
        folder: folder.to_string_lossy().into_owned(),
        kept_files: logging::KEPT_FILES,
        max_file_bytes: logging::MAX_FILE_BYTES,
    })
}

/// Opens the log folder in Explorer with the active file selected.
///
/// The path comes from the service rather than from the caller. A command
/// that took a path and opened it would be a general-purpose "open anything"
/// for any script running in the webview, which is exactly what section 86's
/// rule about native operations exists to prevent.
#[tauri::command]
pub fn open_log_folder() -> Result<(), String> {
    let file = logging::log_file()
        .ok_or_else(|| "Logging is not running, so there is no log folder.".to_string())?;

    // Revealing the file rather than opening the folder, so the one that is
    // being written *now* is the one already highlighted — the folder has
    // three files in it and only one of them is usually the interesting one.
    tauri_plugin_opener::reveal_item_in_dir(&file)
        .map_err(|error| format!("Could not open the log folder: {error}"))
}

/// Records an error the React layer caught.
///
/// `window` is which webview it came from (`main`, `popup`, `launcher`,
/// `widget`), `kind` is how it was caught, `message` is the error and `stack`
/// is its trace if there was one. The service cleans and truncates all four —
/// nothing arriving over `invoke` decides how much of the user's disk one
/// report gets, or where an entry in the file begins.
///
/// It cannot fail. A frontend that is already handling a crash has nothing
/// useful to do with a rejected promise from its own crash reporter, and an
/// error boundary that threw while reporting would replace a readable
/// fallback screen with a blank one.
#[tauri::command]
pub fn log_frontend_error(window: String, kind: String, message: String, stack: Option<String>) {
    logging::record_frontend(&window, &kind, &message, stack.as_deref());
}
