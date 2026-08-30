//! Commands for section 69's Export, Import and Reset.
//!
//! Thin, as section 86 requires — but two things about the boundary are worth
//! knowing, because both are why these take a path rather than returning or
//! accepting the backup itself.
//!
//! **The user picks the file, the backend touches it.** The save and open
//! dialogs are the frontend's (`dialog:default` is granted to the main
//! window; `fs` deliberately is not — see `capabilities/default.json`), so
//! the path in these arguments is one the user chose in an OS dialog a moment
//! ago. Reading and writing it is Rust's, which keeps the whole file off the
//! `invoke` bridge: a backup of a long-used database is megabytes, and
//! serialising it into a JS string only to hand it back for writing would
//! copy it three more times to no purpose.
//!
//! **Import is two commands, not one.** [`inspect_backup`] reads and
//! validates the file and changes nothing; [`import_backup`] applies it. That
//! split is section 67's scan / show / confirm / act: what the confirmation
//! dialog says — how many tasks, which build wrote it, when — comes from
//! having actually read the file, so a user confirming an import is
//! confirming *that* file rather than a filename. It also means a file that
//! is going to be refused is refused before the question is asked.
//!
//! [`import_backup`] and [`reset_app_data`] both rebuild the database
//! underneath every window, so both rebuild the tray menu afterwards — it is
//! built from today's tasks and the most-launched routines, and neither
//! survives. The windows re-read themselves; see `src/services/backupService.ts`.

use tauri::{AppHandle, State};

use crate::db::DbConnection;
use crate::services::backup::{self, BackupInfo};
use crate::services::tray;

/// The filename Export offers by default (`routine-launcher-backup.json`).
///
/// Named by the backend rather than typed into the frontend so the file the
/// save dialog suggests and the one section 69 specifies cannot drift apart.
#[tauri::command]
pub fn default_backup_file_name() -> &'static str {
    backup::BACKUP_FILE_NAME
}

/// Writes the whole database to `path` as JSON, and describes what went in.
#[tauri::command]
pub fn export_backup(
    app: AppHandle,
    db: State<DbConnection>,
    path: String,
) -> Result<BackupInfo, String> {
    let version = app.package_info().version.to_string();
    let conn = db.lock().map_err(|e| e.to_string())?;
    backup::export_to_file(&conn, &version, &path).map_err(|e| e.to_string())
}

/// Reads a backup file and says what is in it. Changes nothing.
#[tauri::command]
pub fn inspect_backup(db: State<DbConnection>, path: String) -> Result<BackupInfo, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    backup::inspect_file(&conn, &path).map_err(|e| e.to_string())
}

/// Replaces the database with the contents of `path`.
///
/// The connection is taken mutably because the restore is one transaction —
/// the only place in this crate that needs more than a shared borrow of it.
#[tauri::command]
pub fn import_backup(
    app: AppHandle,
    db: State<DbConnection>,
    path: String,
) -> Result<BackupInfo, String> {
    let info = {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        backup::import_from_file(&mut conn, &path).map_err(|e| e.to_string())?
    };

    // Outside the lock: the tray reads the database to build its menu.
    tray::refresh(&app);

    Ok(info)
}

/// Wipes every trace of the user's data, leaving a fresh install behind.
///
/// Guarded entirely at the UI, which is where section 67 puts the guard: the
/// Settings card asks the user to type the word before it will call this.
/// There is nothing to guard here — the command takes no arguments, so it can
/// only ever do the one thing it says.
#[tauri::command]
pub fn reset_app_data(app: AppHandle, db: State<DbConnection>) -> Result<(), String> {
    {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        backup::reset(&mut conn).map_err(|e| e.to_string())?;
    }

    tray::refresh(&app);

    Ok(())
}
