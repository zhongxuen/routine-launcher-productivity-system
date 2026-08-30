//! Commands for the optional desktop widget (development-plan.md sections
//! 26, 83).
//!
//! Thin wrappers over `services::widget`, per section 86's layering. The
//! service is where the window and its five persisted controls live, so the
//! Settings page and the tray entry of prompt 12.3 can summon the widget by
//! calling it directly rather than going out through the IPC boundary and
//! back.
//!
//! Note what is *not* here: nothing lets the frontend put the window at an
//! arbitrary position, and nothing lets it set a size the service has not
//! clamped. Moving is [`start_widget_drag`], which hands the window to the
//! OS's own drag loop and gets no coordinates back; resizing goes through
//! `services::widget::resize`, which decides what is a widget and what is a
//! full-screen panel. A webview never gets to be the thing that says where an
//! always-on-top window goes — the same line `capabilities/launcher.json`
//! draws.

use crate::services::widget::{self, WidgetMode, WidgetSettings, WidgetSize};

/// Shows the widget, building it on first use, and remembers that it is open.
///
/// `async`, and not for the usual reason. A synchronous command runs on the
/// main thread, and building a webview window there while the event loop is
/// already running deadlocks it: the builder waits for the loop to create the
/// window, and the loop is inside this call waiting for it to return. The app
/// stops answering anything — including the command that would put the widget
/// away again. Marking it `async` moves it onto the async runtime, from which
/// window creation is posted to the loop and waited on properly. The same
/// goes for [`toggle_widget_window`], which builds on the way up.
#[tauri::command]
pub async fn open_widget_window(app: tauri::AppHandle) -> Result<(), String> {
    widget::show(&app).map_err(|error| format!("Could not open the widget: {error}"))
}

/// Section 83's "Hide". The webview stays alive and the app carries on — this
/// is a window going away, not a feature being switched off.
#[tauri::command]
pub fn dismiss_widget_window(app: tauri::AppHandle) -> Result<(), String> {
    widget::hide(&app).map_err(|error| format!("Could not hide the widget: {error}"))
}

/// Flips the widget between shown and hidden, answering with whether it is
/// now on screen. What a Settings toggle and a tray entry both want.
///
/// `async` for the reason [`open_widget_window`] is: half of what it does is
/// build a window.
#[tauri::command]
pub async fn toggle_widget_window(app: tauri::AppHandle) -> Result<bool, String> {
    widget::toggle(&app).map_err(|error| format!("Could not toggle the widget: {error}"))
}

/// Whether the widget is on screen right now.
///
/// A fact about another window, so it is asked rather than remembered: the
/// widget can be hidden from its own close button without telling anybody.
#[tauri::command]
pub fn is_widget_window_open(app: tauri::AppHandle) -> bool {
    widget::is_visible(&app)
}

/// Everything stored about the widget, in one call.
///
/// Read by the widget itself when it mounts — it has to know its own pin and
/// opacity to draw its chrome — and by the Settings page, which offers the
/// same two controls.
#[tauri::command]
pub fn get_widget_settings(app: tauri::AppHandle) -> Result<WidgetSettings, String> {
    widget::settings_for(&app).map_err(|error| format!("Could not read the widget settings: {error}"))
}

/// Section 83's "Pin": always-on-top on or off. Answers with what was stored.
#[tauri::command]
pub fn set_widget_pinned(app: tauri::AppHandle, pinned: bool) -> Result<bool, String> {
    widget::set_pinned(&app, pinned).map_err(|error| format!("Could not pin the widget: {error}"))
}

/// Section 83's "Opacity". Answers with the value after clamping, which is
/// what the caller should draw itself at.
#[tauri::command]
pub fn set_widget_opacity(app: tauri::AppHandle, opacity: f64) -> Result<f64, String> {
    widget::set_opacity(&app, opacity)
        .map_err(|error| format!("Could not change the widget opacity: {error}"))
}

/// Section 26's four layouts: Task, Focus, Routine or Combined.
///
/// The one control the Settings page has that the widget's own chrome does
/// not — a four-way picker does not fit in a 300px window. An unknown mode is
/// refused by `serde` before this runs, so nothing here has to decide what a
/// widget with no layout looks like.
#[tauri::command]
pub fn set_widget_mode(app: tauri::AppHandle, mode: WidgetMode) -> Result<WidgetMode, String> {
    widget::set_mode(&app, mode)
        .map_err(|error| format!("Could not change the widget layout: {error}"))
}

/// Section 83's "Resize". Answers with the size the window was actually given
/// — the frontend follows that rather than its own arithmetic, so a drag past
/// the limits stops instead of running away.
#[tauri::command]
pub fn set_widget_size(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
) -> Result<WidgetSize, String> {
    widget::resize(&app, width, height)
        .map_err(|error| format!("Could not resize the widget: {error}"))
}

/// Section 83's "Move": hands the window to the OS's drag loop for as long as
/// the button is held. Called on pointer-down anywhere on the widget that is
/// not one of its controls.
#[tauri::command]
pub fn start_widget_drag(app: tauri::AppHandle) -> Result<(), String> {
    widget::start_drag(&app).map_err(|error| format!("Could not move the widget: {error}"))
}
