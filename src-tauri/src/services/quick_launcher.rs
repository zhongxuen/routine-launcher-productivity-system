//! The quick launcher overlay (development-plan.md section 28).
//!
//! ```text
//! ┌──────────────────────────────┐
//! │ Search...                    │
//! ├──────────────────────────────┤
//! │ 🚀 Coding                    │
//! │ 📚 Study                     │
//! │ 💼 Work                      │
//! │ + Add Task                   │
//! │ ⏱ Start Focus                │
//! └──────────────────────────────┘
//! ```
//!
//! Summoned by the global shortcut in `services::shortcuts` — which is the
//! only thing that opens it in normal use, and the reason it is a third OS
//! window rather than an overlay inside the main one. Section 28's shortcut
//! has to work while the app is minimised, buried or never opened at all, and
//! a `<div>` inside a hidden window cannot.
//!
//! It is a sibling of `services::popup` and follows the same three rules —
//! built once then hidden, positioned rather than centred, always on top and
//! out of the taskbar — with three differences that come from being a
//! *launcher* rather than a glance:
//!
//! 1. **No decorations.** The mockup is a box with a search field in it, not
//!    a window with a title bar. That costs the close button, so dismissal is
//!    Escape, the shortcut again, or clicking away (see [`hold`] below).
//! 2. **It hides when it loses focus — once it has had it.** An undecorated
//!    always-on-top window with no close button that stayed put would be a
//!    thing the user cannot get rid of with the mouse. But Windows does not
//!    always grant the foreground to a window summoned from the background,
//!    and a blur *before* the launcher has ever been focused is that refusal,
//!    not the user clicking away — taking it as a dismissal is how the
//!    overlay comes up and vanishes in the same frame. So the blur only
//!    counts once [`arm`] has seen the window focused. The handler lives in
//!    `lib.rs`, next to the other window events.
//! 3. **Its height follows its contents.** A launcher showing two routines
//!    should not be a box with an empty half. The frontend measures and calls
//!    [`set_height`]; the clamp is here, so a webview can never size the
//!    window to something silly.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// The launcher's window label. Also the identifier of its capability file
/// (`capabilities/launcher.json`) and what `emit_to` addresses it by.
pub const LAUNCHER_LABEL: &str = "launcher";

/// The launcher's own HTML entry point — a third bundle beside `index.html`
/// and `popup.html`, carrying none of the app shell. `vite.config.ts` builds
/// all three.
const LAUNCHER_URL: &str = "launcher.html";

/// Wide enough for a routine name and its hint on one line, narrow enough to
/// read as an overlay rather than a window.
const LAUNCHER_WIDTH: f64 = 560.0;

/// The height the window is built at, before the frontend has measured
/// anything. Roughly the search field plus four rows, so the first frame is
/// close to the final size and the window does not visibly settle.
const INITIAL_HEIGHT: f64 = 260.0;

/// The floor is the search field on its own — what an empty filter leaves.
/// The ceiling is where the list starts scrolling instead of growing, so a
/// user with thirty routines gets a launcher rather than a full-screen list.
const MIN_HEIGHT: f64 = 68.0;
const MAX_HEIGHT: f64 = 460.0;

/// How far down the screen the overlay sits, as a fraction of screen height.
/// Launchers are placed above centre — the eye is already there, and the list
/// grows downwards into the space below.
const VERTICAL_ANCHOR: f64 = 0.22;

/// Emitted to the launcher when an already-built window is shown again.
///
/// The webview was never torn down, so nothing else would clear yesterday's
/// half-typed query or re-read a routine list that has changed since. This is
/// what tells it to start over.
pub const LAUNCHER_SHOWN_EVENT: &str = "launcher://shown";

/// Whether the launcher is currently holding itself open despite losing
/// focus.
///
/// Launching a routine opens applications, and those applications take the
/// foreground — which is the launcher's own blur, which would normally hide
/// it. That is exactly right when the launch worked and exactly wrong when it
/// did not: the failure line would be swept off screen by the very thing it
/// is reporting on. So the frontend holds the window open across a launch and
/// releases it when there is nothing left to say.
///
/// A plain global rather than managed state because it is a fact about the
/// one launcher window, and the window-event handler that reads it has an
/// `&Window`, not a `State`.
static HOLD: AtomicBool = AtomicBool::new(false);

/// Whether a lost focus means the user clicked away.
///
/// False from the moment the launcher is shown until it is actually focused,
/// because the blur in between is not a dismissal — it is Windows declining
/// to give the foreground to a window that asked for it from the background,
/// which is exactly what a global shortcut does. Hiding on that would make
/// the overlay flash and disappear, and the user would have pressed the
/// shortcut for nothing.
///
/// A launcher that never wins the foreground therefore stays on screen rather
/// than vanishing. It can still be dismissed with the shortcut that opened
/// it, which is the one input that reaches the app without the window having
/// focus at all.
static ARMED: AtomicBool = AtomicBool::new(false);

/// The launcher window, if it has been built yet.
pub fn find(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LAUNCHER_LABEL)
}

/// Whether the launcher is on screen. A built-but-hidden window is not.
pub fn is_visible(app: &AppHandle) -> bool {
    find(app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Shows the launcher, building it the first time, and takes focus.
///
/// Focus is the whole point: this window is a search box, and one that opened
/// behind the thing being looked at — or in front of it but not typed into —
/// would have failed at its only job.
pub fn show(app: &AppHandle) -> tauri::Result<()> {
    // A fresh summon is never still holding the last one's result open.
    release_hold();

    match find(app) {
        Some(window) => {
            window.show()?;
            window.set_focus()?;
            app.emit_to(LAUNCHER_LABEL, LAUNCHER_SHOWN_EVENT, ())?;
        }
        None => {
            // Asked for again after the builder's own `focused(true)`: on the
            // first summon the window and its webview arrive together, and
            // the request that came with the window can land before there is
            // a webview to take it.
            build(app)?.set_focus()?;
        }
    }

    Ok(())
}

/// Puts the launcher away without tearing down its webview. Hiding a window
/// that was never built is not an error — nothing is on screen either way.
pub fn hide(app: &AppHandle) -> tauri::Result<()> {
    release_hold();

    if let Some(window) = find(app) {
        window.hide()?;
    }
    Ok(())
}

/// Hides the launcher if it is showing, shows it otherwise. Returns whether
/// it is now visible.
///
/// This is what the global shortcut is bound to, which is why it is a toggle
/// and not an open: the same keystroke that summons the launcher is the most
/// obvious way to dismiss it.
pub fn toggle(app: &AppHandle) -> tauri::Result<bool> {
    if is_visible(app) {
        hide(app)?;
        Ok(false)
    } else {
        show(app)?;
        Ok(true)
    }
}

/// Tears the launcher down for good — called when the main window closes,
/// for the same reason the popup is: Tauri exits once the last window is
/// gone, and a hidden launcher would keep the process alive with nothing on
/// screen and no way to quit it.
pub fn destroy(app: &AppHandle) {
    if let Some(window) = find(app) {
        let _ = window.destroy();
    }
}

/// Resizes the launcher to `height` logical pixels, clamped.
///
/// The width never changes; only the list below the search field grows. The
/// window's top-left corner is what stays put, so it opens downwards from a
/// fixed search box rather than creeping up the screen as results arrive.
pub fn set_height(app: &AppHandle, height: f64) -> tauri::Result<()> {
    let Some(window) = find(app) else {
        return Ok(());
    };

    // NaN would survive `clamp` on the wrong side of the comparison, and a
    // webview is not something to take arithmetic on trust from.
    let requested = if height.is_finite() { height } else { INITIAL_HEIGHT };

    window.set_size(LogicalSize::new(
        LAUNCHER_WIDTH,
        requested.clamp(MIN_HEIGHT, MAX_HEIGHT),
    ))
}

/// Keeps the launcher on screen when it loses focus — see [`HOLD`].
pub fn hold(held: bool) {
    HOLD.store(held, Ordering::Relaxed);
}

/// Whether a blur should be ignored right now.
pub fn is_held() -> bool {
    HOLD.load(Ordering::Relaxed)
}

/// Records that the launcher has been focused, so the next blur is a real one
/// — see [`ARMED`].
pub fn arm() {
    ARMED.store(true, Ordering::Relaxed);
}

/// Whether a blur can be trusted as a dismissal yet.
pub fn is_armed() -> bool {
    ARMED.load(Ordering::Relaxed)
}

fn release_hold() {
    hold(false);
    // A window on its way on or off screen has not been focused *this* time.
    ARMED.store(false, Ordering::Relaxed);
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, LAUNCHER_LABEL, WebviewUrl::App(LAUNCHER_URL.into()))
        // Named for the taskbar it is kept out of and the alt-tab list it is
        // not in; nothing draws it, because there is no title bar.
        .title("Quick Launcher")
        .inner_size(LAUNCHER_WIDTH, INITIAL_HEIGHT)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true);

    let builder = match anchor_position(app) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    builder.build()
}

/// Horizontally centred on the primary monitor, a fifth of the way down.
///
/// `Monitor` reports the whole screen rather than the work area, which does
/// not matter here the way it does for the popup: the launcher is nowhere
/// near the taskbar. None when the monitor cannot be read, which the caller
/// turns into a centred window.
fn anchor_position(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok()??;
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);

    Some((
        origin.x + (size.width - LAUNCHER_WIDTH) / 2.0,
        origin.y + size.height * VERTICAL_ANCHOR,
    ))
}
