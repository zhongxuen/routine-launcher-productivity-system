//! The compact popup window (development-plan.md section 25).
//!
//! Section 25 asks for a small window that shows today at a glance and lets
//! the user act on it "without opening the full application". That is a
//! second OS window rather than an overlay inside the main one, because the
//! thing it has to survive is the main window being closed, minimised or
//! never opened at all — and because Stage 8's tray icon and global shortcut
//! summon it from outside the app entirely.
//!
//! Everything about that window's life lives here rather than in
//! `commands/popup.rs`, so the tray and the shortcut can call these functions
//! directly instead of going out through the IPC boundary and back.
//!
//! Three rules shape the implementation:
//!
//! 1. **Created on first use, then hidden — never destroyed.** Closing the
//!    popup hides it (see `on_window_event` in `lib.rs`), so re-summoning it
//!    is instant and it keeps its scroll position and half-typed task. The
//!    one exception is the main window closing, which takes the popup with
//!    it: a hidden window still counts, and an app kept alive by a window
//!    nobody can see would be a process the user cannot quit.
//! 2. **Positioned, not centred.** It behaves like a tray popup, so it opens
//!    in the top-right corner of the primary monitor — clear of the Windows
//!    taskbar without having to ask the OS where the work area is. Centring
//!    is the fallback when the monitor cannot be read.
//! 3. **Always on top, out of the taskbar.** It is a glance, not a place you
//!    alt-tab to.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The popup's window label. Also the identifier of its capability file
/// (`capabilities/popup.json`) and what `emit_to` addresses it by.
pub const POPUP_LABEL: &str = "popup";

/// The main window's label, as declared in `tauri.conf.json`.
pub const MAIN_LABEL: &str = "main";

/// The popup's own HTML entry point — a separate bundle from `index.html`, so
/// it carries none of the app shell's router, sidebar or session lifecycle.
/// `vite.config.ts` builds both.
const POPUP_URL: &str = "popup.html";

/// Deliberately small (section 25: "intentionally compact"). Tall enough for
/// the count, a handful of task rows, add-task and the launch button; not so
/// tall that it becomes the dashboard.
const POPUP_WIDTH: f64 = 340.0;
const POPUP_HEIGHT: f64 = 460.0;

/// Gap between the popup and the corner of the screen, in logical pixels.
const SCREEN_MARGIN: f64 = 24.0;

/// Emitted to the popup when an already-built window is shown again.
///
/// The webview was never torn down, so nothing would otherwise re-read the
/// database for a window that has been hidden since yesterday. This is what
/// tells it to.
pub const POPUP_SHOWN_EVENT: &str = "popup://shown";

/// The popup window, if it has been built yet.
pub fn find(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(POPUP_LABEL)
}

/// Whether the popup is currently on screen. A window that exists but is
/// hidden is not visible, which is the distinction [`toggle`] turns on.
pub fn is_visible(app: &AppHandle) -> bool {
    find(app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Shows the popup, building it the first time.
///
/// Focus is taken deliberately: every caller is a user asking for it — the
/// sidebar button now, the tray and the global shortcut in Stage 8 — and a
/// summoned window that appeared behind the one being looked at would have
/// failed at its only job.
pub fn show(app: &AppHandle) -> tauri::Result<()> {
    match find(app) {
        Some(window) => {
            window.show()?;
            // Only meaningful if the user minimised it before we stopped
            // offering the button; harmless otherwise.
            let _ = window.unminimize();
            window.set_focus()?;

            // The webview is alive and holding whatever it read when it was
            // last shown, so it is asked to catch up.
            app.emit_to(POPUP_LABEL, POPUP_SHOWN_EVENT, ())?;
        }
        None => {
            build(app)?;
        }
    }

    Ok(())
}

/// Hides the popup without tearing down its webview. Hiding a window that was
/// never built is not an error — there is nothing on screen either way.
pub fn hide(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = find(app) {
        window.hide()?;
    }
    Ok(())
}

/// Hides the popup if it is showing, shows it otherwise. Returns whether it
/// is now visible — this is the shape Stage 8's shortcut wants.
pub fn toggle(app: &AppHandle) -> tauri::Result<bool> {
    if is_visible(app) {
        hide(app)?;
        Ok(false)
    } else {
        show(app)?;
        Ok(true)
    }
}

/// Tears the popup down for good.
///
/// Called when the main window closes, because Tauri exits once the last
/// window is gone and a hidden popup would keep the process alive with
/// nothing on screen. `destroy` rather than `close`, so it does not re-enter
/// the close handler that would only hide it again.
pub fn destroy(app: &AppHandle) {
    if let Some(window) = find(app) {
        let _ = window.destroy();
    }
}

/// Brings the main window forward — the popup's one link back to the full
/// app. A no-op if the main window is gone, which is not a case that arises
/// while the popup is on screen.
pub fn show_main(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        window.show()?;
        let _ = window.unminimize();
        window.set_focus()?;
    }
    Ok(())
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, POPUP_LABEL, WebviewUrl::App(POPUP_URL.into()))
        // The OS title bar is kept: on a window this small it is the whole
        // move-and-close affordance, and drawing our own would need a drag
        // region permission the app does not otherwise grant.
        .title("Routine Launcher")
        .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true);

    let builder = match corner_position(app) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    builder.build()
}

/// The top-right corner of the primary monitor, in logical pixels.
///
/// Top rather than bottom because the Windows taskbar is at the bottom by
/// default and `Monitor` reports the full screen, not the work area — a
/// bottom-right popup would sit under it. None when the monitor cannot be
/// read, which the caller turns into a centred window.
fn corner_position(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok()??;
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);

    Some((
        origin.x + size.width - POPUP_WIDTH - SCREEN_MARGIN,
        origin.y + SCREEN_MARGIN,
    ))
}
