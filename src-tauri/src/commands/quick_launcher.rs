//! Commands for the quick launcher and the shortcut that summons it
//! (development-plan.md section 28).
//!
//! Two groups, kept in one file because section 28 is one feature: the window
//! is only ever opened by the shortcut, and the shortcut only ever opens the
//! window. Both are thin wrappers over `services::quick_launcher` and
//! `services::shortcuts` per section 86's layering — which is what lets the
//! shortcut handler itself, and Stage 8's tray menu, summon the launcher by
//! calling the service directly instead of going out through IPC and back.

use tauri::{AppHandle, State};

use crate::db::DbConnection;
use crate::services::{quick_launcher, shortcuts};

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/// Shows the launcher, building it on first use. Takes focus.
#[tauri::command]
pub fn open_quick_launcher(app: AppHandle) -> Result<(), String> {
    quick_launcher::show(&app).map_err(|error| format!("Could not open the quick launcher: {error}"))
}

/// Puts the launcher away. This is what Escape calls: the window has no title
/// bar to close it with.
#[tauri::command]
pub fn dismiss_quick_launcher(app: AppHandle) -> Result<(), String> {
    quick_launcher::hide(&app)
        .map_err(|error| format!("Could not close the quick launcher: {error}"))
}

/// Flips the launcher between shown and hidden, answering with whether it is
/// now visible.
#[tauri::command]
pub fn toggle_quick_launcher(app: AppHandle) -> Result<bool, String> {
    quick_launcher::toggle(&app)
        .map_err(|error| format!("Could not toggle the quick launcher: {error}"))
}

/// Sizes the window to its contents, in logical pixels. Clamped by the
/// service, so the worst a mis-measured frame can do is stop at the ceiling.
#[tauri::command]
pub fn set_quick_launcher_height(app: AppHandle, height: f64) -> Result<(), String> {
    quick_launcher::set_height(&app, height)
        .map_err(|error| format!("Could not resize the quick launcher: {error}"))
}

/// Keeps the launcher on screen through a lost focus.
///
/// Held while a routine is launching and while its result is still on screen:
/// the applications the launch opens take the foreground, and that blur would
/// otherwise sweep away the line reporting on it.
#[tauri::command]
pub fn hold_quick_launcher(held: bool) {
    quick_launcher::hold(held);
}

// ---------------------------------------------------------------------------
// The shortcut
// ---------------------------------------------------------------------------

/// The accelerator currently bound — what Settings shows.
#[tauri::command]
pub fn get_quick_launcher_shortcut(db: State<DbConnection>) -> Result<String, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    shortcuts::stored(&conn).map_err(|e| e.to_string())
}

/// Rebinds the shortcut, answering with what is now bound.
///
/// Ordered so that a refusal costs the user nothing. The accelerator is
/// checked before anything is touched; if the OS then turns it down — another
/// program holding it is the usual reason — the previous binding is put back
/// and nothing is written, so the launcher stays reachable by the shortcut
/// the user already knows.
#[tauri::command]
pub fn set_quick_launcher_shortcut(
    app: AppHandle,
    db: State<DbConnection>,
    accelerator: String,
) -> Result<String, String> {
    let accelerator = accelerator.trim().to_string();
    shortcuts::parse(&accelerator)?;

    let previous = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        shortcuts::stored(&conn).map_err(|e| e.to_string())?
    };

    if let Err(error) = shortcuts::apply(&app, &accelerator) {
        if let Err(restore) = shortcuts::apply(&app, &previous) {
            crate::log_error!("could not restore the previous shortcut {previous}: {restore}");
        }
        return Err(error);
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    shortcuts::save(&conn, &accelerator).map_err(|e| e.to_string())?;

    Ok(accelerator)
}

/// Puts section 28's `Ctrl + Alt + Space` back.
#[tauri::command]
pub fn reset_quick_launcher_shortcut(
    app: AppHandle,
    db: State<DbConnection>,
) -> Result<String, String> {
    set_quick_launcher_shortcut(
        app,
        db,
        shortcuts::DEFAULT_QUICK_LAUNCHER_SHORTCUT.to_string(),
    )
}
