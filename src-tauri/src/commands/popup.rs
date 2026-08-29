//! Commands for the compact popup window (development-plan.md section 25).
//!
//! Thin wrappers over `services::popup`, per section 86's layering. The
//! service is where the window's behaviour lives, so Stage 8's tray menu and
//! global shortcut can summon the popup by calling it directly rather than
//! going out through the IPC boundary and back.

use crate::services::popup;

/// Shows the popup, building it on first use.
#[tauri::command]
pub fn open_popup_window(app: tauri::AppHandle) -> Result<(), String> {
    popup::show(&app).map_err(|error| format!("Could not open the popup: {error}"))
}

/// Hides the popup. The webview stays alive, so re-opening is instant and
/// keeps whatever the user had on screen.
#[tauri::command]
pub fn dismiss_popup_window(app: tauri::AppHandle) -> Result<(), String> {
    popup::hide(&app).map_err(|error| format!("Could not close the popup: {error}"))
}

/// Flips the popup between shown and hidden, answering with whether it is now
/// visible. This is what Stage 8's global shortcut binds to.
#[tauri::command]
pub fn toggle_popup_window(app: tauri::AppHandle) -> Result<bool, String> {
    popup::toggle(&app).map_err(|error| format!("Could not toggle the popup: {error}"))
}

/// Whether the popup is on screen right now — so the main window can label
/// its button, rather than guessing at a window it cannot see.
#[tauri::command]
pub fn is_popup_window_open(app: tauri::AppHandle) -> bool {
    popup::is_visible(&app)
}

/// Brings the full app forward. The popup's escape hatch: everything in it
/// works on its own, and this is for when the user wants the rest.
#[tauri::command]
pub fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    popup::show_main(&app).map_err(|error| format!("Could not open the main window: {error}"))
}
