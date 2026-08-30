//! The optional desktop widget window (development-plan.md sections 26, 83).
//!
//! ```text
//! ┌─────────────────────────┐
//! │ ·                ◐ 📌 ✕ │
//! │ TODAY             3/7   │
//! │ □ Finish report         │
//! │ ✓ Check emails          │
//! │                       ◢ │
//! └─────────────────────────┘
//! ```
//!
//! The fourth OS window, and a sibling of [`super::popup`] and
//! [`super::quick_launcher`] — built on first use, hidden rather than
//! destroyed, always on top and out of the taskbar. What makes it a *widget*
//! rather than a third overlay is that it is meant to stay on screen while
//! the user works on something else, and section 83 asks for the five
//! controls that makes bearable: resize, move, hide, pin and opacity.
//!
//! Those five are why this module exists at all rather than the widget being
//! another `WebviewWindowBuilder` call in `lib.rs`:
//!
//! 1. **All five are persisted, and this owns the keys.** Section 83's widget
//!    is furniture: a window the user positions once and expects to find in
//!    the same place tomorrow. So every control writes to the `settings`
//!    table (`widget.*`) and the window is *built* from what is stored, which
//!    is also what makes "shown or hidden" survive a restart — see
//!    [`restore`].
//! 2. **None of them are the webview's to perform.** Moving, resizing and
//!    pinning a window are OS operations, so they are commands here rather
//!    than window permissions granted to `capabilities/widget.json` — the
//!    same line the launcher's capability draws, and section 86's rule.
//! 3. **Opacity is the exception that shapes the window.** There is no
//!    cross-platform "set window alpha" in Tauri, so the window is built
//!    *transparent* and the widget paints itself at the stored alpha. That is
//!    the reason for `macOSPrivateApi` in `tauri.conf.json` and for
//!    `widget.html` not painting a background the way `popup.html` does.
//!
//! Geometry is the one setting the user changes without calling a command:
//! moving the widget is an OS drag loop, and it reports back as a stream of
//! `Moved` events rather than as one answer. [`remember_geometry`] is what
//! `lib.rs` hands those to, and it writes at most once every
//! [`GEOMETRY_WRITE_INTERVAL`] so a two-second drag is a handful of rows
//! rather than a few hundred. [`flush_geometry`] is the unthrottled version,
//! called at the moments the stream is known to have stopped — the widget
//! being hidden, losing focus, or going away with the app — so the value that
//! is finally stored is where the user actually let go.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::db::DbConnection;
use crate::services::error::ServiceResult;
use crate::services::settings;

/// The widget's window label. Also the identifier of its capability file
/// (`capabilities/widget.json`) and what `emit_to` addresses it by.
pub const WIDGET_LABEL: &str = "widget";

/// The widget's own HTML entry point — a fourth bundle beside `index.html`,
/// `popup.html` and `launcher.html`. `vite.config.ts` builds all four.
const WIDGET_URL: &str = "widget.html";

/// Emitted to the widget when an already-built window is shown again.
///
/// Its webview was never torn down, so nothing else would tell it to re-read a
/// database — or a theme — that has moved on since it was last looked at.
pub const WIDGET_SHOWN_EVENT: &str = "widget://shown";

/// Broadcast to every window whenever a stored widget setting changes.
///
/// Pin and opacity are reachable from two places by design: the widget's own
/// chrome and, from Stage 12's third prompt, the Settings page. Neither can
/// see the other's state — they are separate webviews — so the one that writes
/// says so and the other re-reads, exactly as `src/lib/window-sync.ts` does
/// for tasks and routines.
pub const WIDGET_SETTINGS_EVENT: &str = "widget://settings-changed";

/// Whether the widget was on screen when the app was last running. Off on a
/// fresh install: section 83's widget is "completely optional", so nothing
/// but the user asking for it may ever put it there.
const VISIBLE_KEY: &str = "widget.visible";
const X_KEY: &str = "widget.x";
const Y_KEY: &str = "widget.y";
const WIDTH_KEY: &str = "widget.width";
const HEIGHT_KEY: &str = "widget.height";
const PINNED_KEY: &str = "widget.pinned";
const OPACITY_KEY: &str = "widget.opacity";

/// Which of section 26's four layouts the widget is showing. Written by the
/// Settings page's mode picker, read by the widget itself.
const MODE_KEY: &str = "widget.mode";

/// Small enough to leave alone in a corner, big enough for section 26's
/// mockups — a header, four task rows and a button.
const DEFAULT_WIDTH: f64 = 300.0;
const DEFAULT_HEIGHT: f64 = 260.0;

/// The floor is the smallest box the chrome still fits in: three control
/// buttons on one line and a row under them. The ceiling is where a widget
/// stops being one — section 26 is explicit that this is not the dashboard,
/// and 12.2's modes are told to truncate rather than grow.
const MIN_WIDTH: f64 = 220.0;
const MIN_HEIGHT: f64 = 140.0;
const MAX_WIDTH: f64 = 560.0;
const MAX_HEIGHT: f64 = 720.0;

/// Anything fainter than this is a window the user can neither read nor find,
/// and the control that got them there is inside it.
const MIN_OPACITY: f64 = 0.3;
const MAX_OPACITY: f64 = 1.0;
const DEFAULT_OPACITY: f64 = 1.0;

/// Pinned on a fresh install: an always-visible widget that ordinary windows
/// can bury is not always visible, and unpinning is one click away.
const DEFAULT_PINNED: bool = true;

/// Section 26 leads with the task widget, and it is the mode the default
/// 300 x 260 window was sized for — a header, a few rows and a button. The
/// other three are one click away in Settings.
const DEFAULT_MODE: WidgetMode = WidgetMode::Task;

/// Gap between the widget and the edges of the screen it first appears in.
const SCREEN_MARGIN: f64 = 24.0;

/// How much of the widget has to stay on a monitor for a stored position to
/// be reused — see [`is_on_screen`].
const MIN_VISIBLE_WIDTH: f64 = 96.0;
const MIN_VISIBLE_HEIGHT: f64 = 48.0;

/// How often geometry may be written while the window is still moving.
///
/// A drag reports every frame; the database does not need to hear about every
/// frame. The trailing value is not lost by this — see [`flush_geometry`].
const GEOMETRY_WRITE_INTERVAL: Duration = Duration::from_millis(400);

/// When geometry was last written, for the throttle above.
///
/// A plain global rather than managed state, like `quick_launcher`'s flags:
/// it is a fact about the one widget window, and the window-event handler
/// that consults it has an `&Window`, not a `State`.
static LAST_GEOMETRY_WRITE: Mutex<Option<Instant>> = Mutex::new(None);

/// Which of section 26's four layouts the widget draws.
///
/// Stored as its own lowercase word rather than as a number, because a
/// `settings` row is a thing a person can read — and because inserting a
/// fifth mode later must not silently renumber the four that exist.
/// `Deserialize` is for the command that sets it: an unknown word is refused
/// at the IPC boundary rather than written and puzzled over on the next read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WidgetMode {
    /// Section 26's "TODAY" list with its X/Y count.
    Task,
    /// Section 26's countdown with [ Pause ] [ Finish ].
    Focus,
    /// Section 83's routine widget: one-click launches.
    Routine,
    /// Section 26's combined layout: today's tasks above the timer.
    Combined,
}

impl WidgetMode {
    /// The word stored in `settings`, and the one the frontend sends back.
    fn as_str(self) -> &'static str {
        match self {
            WidgetMode::Task => "task",
            WidgetMode::Focus => "focus",
            WidgetMode::Routine => "routine",
            WidgetMode::Combined => "combined",
        }
    }

    /// The mode a stored word names, or `None` if it names none of them.
    ///
    /// A row written by an older build — or by hand — is not allowed to leave
    /// the widget with no layout at all; the caller falls back to
    /// [`DEFAULT_MODE`].
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "task" => Some(WidgetMode::Task),
            "focus" => Some(WidgetMode::Focus),
            "routine" => Some(WidgetMode::Routine),
            "combined" => Some(WidgetMode::Combined),
            _ => None,
        }
    }
}

/// Everything stored about the widget, in one read.
///
/// `camelCase` on the wire because none of it mirrors a database row — these
/// are seven `settings` keys gathered into the one shape both the widget's
/// chrome and the Settings page want.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSettings {
    /// Whether the widget should be on screen. Written by [`show`] and
    /// [`hide`], read at startup by [`restore`].
    pub visible: bool,
    /// Where the user left it, in logical pixels, or `None` while it has
    /// never been placed. Not clamped on read: a position is only wrong
    /// relative to the monitors attached *now*, which is [`placement`]'s
    /// question rather than storage's.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    /// Always-on-top. Section 83's "Pin".
    pub pinned: bool,
    /// Which of section 26's four layouts is on screen.
    pub mode: WidgetMode,
    /// 0.3 - 1.0. Applied by the widget to itself, not by the OS.
    pub opacity: f64,
}

/// The size a resize settled on, after clamping.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSize {
    pub width: f64,
    pub height: f64,
}

/// The widget window, if it has been built yet.
pub fn find(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WIDGET_LABEL)
}

/// Whether the widget is on screen. A built-but-hidden window is not.
pub fn is_visible(app: &AppHandle) -> bool {
    find(app)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Reads everything stored about the widget.
///
/// Takes a connection rather than an `AppHandle` so the defaults and the
/// clamping can be tested without a Tauri runtime — they are the part with
/// rules in them. [`settings_for`] is the same read for a caller that only has
/// the app.
pub fn stored(conn: &Connection) -> ServiceResult<WidgetSettings> {
    Ok(WidgetSettings {
        visible: settings::get_bool(conn, VISIBLE_KEY, false)?,
        x: number(conn, X_KEY)?,
        y: number(conn, Y_KEY)?,
        width: number(conn, WIDTH_KEY)?.map_or(DEFAULT_WIDTH, clamp_width),
        height: number(conn, HEIGHT_KEY)?.map_or(DEFAULT_HEIGHT, clamp_height),
        pinned: settings::get_bool(conn, PINNED_KEY, DEFAULT_PINNED)?,
        mode: settings::get(conn, MODE_KEY)?
            .as_deref()
            .and_then(WidgetMode::parse)
            .unwrap_or(DEFAULT_MODE),
        opacity: number(conn, OPACITY_KEY)?.map_or(DEFAULT_OPACITY, clamp_opacity),
    })
}

/// [`stored`], for a caller holding the app rather than a connection.
pub fn settings_for(app: &AppHandle) -> Result<WidgetSettings, String> {
    with_db(app, stored)
}

/// Shows the widget, building it the first time, and takes the foreground.
///
/// Focus is taken because every caller is a user asking for it — the Settings
/// toggle and the tray entry of prompt 12.3 — and a small always-on-top window
/// that appeared *behind* something is indistinguishable from one that did not
/// appear. Startup is the one summon nobody asked for, and it goes through
/// [`restore`] instead.
pub fn show(app: &AppHandle) -> Result<(), String> {
    reveal(app, true)
}

/// Puts the widget back the way the last run left it, if that was on screen.
///
/// Called once from `lib.rs`'s setup. Silent when the widget was hidden, or
/// never opened at all, which is what "off by default" means here: the stored
/// visibility is the only thing that can put it back, and only the user can
/// have written it. Does not take the foreground — the app has just started,
/// and the window in front of it belongs to whatever the user was doing.
pub fn restore(app: &AppHandle) {
    let visible = match settings_for(app) {
        Ok(settings) => settings.visible,
        Err(error) => {
            crate::log_error!("could not read the widget settings: {error}");
            return;
        }
    };

    if !visible {
        return;
    }

    if let Err(error) = reveal(app, false) {
        crate::log_error!("could not restore the widget: {error}");
    }
}

/// Section 83's "Hide": the widget goes away, the app does not.
///
/// The webview survives, so the next summon is instant and lands on what the
/// user was looking at — and the geometry is flushed on the way out, because
/// a drag that ended a moment ago may still be inside the throttle window.
pub fn hide(app: &AppHandle) -> Result<(), String> {
    flush_geometry(app);

    if let Some(window) = find(app) {
        window
            .hide()
            .map_err(|error| format!("could not hide the widget window: {error}"))?;
    }

    remember_visible(app, false);
    Ok(())
}

/// Hides the widget if it is showing, shows it otherwise. Returns whether it
/// is now on screen — the shape a Settings toggle and a tray entry both want.
pub fn toggle(app: &AppHandle) -> Result<bool, String> {
    if is_visible(app) {
        hide(app)?;
        Ok(false)
    } else {
        show(app)?;
        Ok(true)
    }
}

/// Tears the widget down for good, remembering where it was first.
///
/// Called when the main window closes, for the reason its two siblings are:
/// Tauri exits once the last window is gone, and a hidden widget would keep
/// the process alive with nothing on screen and no way to quit it. The stored
/// visibility is deliberately *not* cleared — the app closing is not the user
/// putting the widget away, and the next run is supposed to bring it back.
pub fn destroy(app: &AppHandle) {
    flush_geometry(app);

    if let Some(window) = find(app) {
        let _ = window.destroy();
    }
}

/// Section 83's "Pin". Answers with what is now stored.
pub fn set_pinned(app: &AppHandle, pinned: bool) -> Result<bool, String> {
    if let Some(window) = find(app) {
        window
            .set_always_on_top(pinned)
            .map_err(|error| format!("could not pin the widget window: {error}"))?;
    }

    with_db(app, |conn| settings::set_bool(conn, PINNED_KEY, pinned))?;
    announce(app);
    Ok(pinned)
}

/// Section 83's "Opacity", clamped. Answers with what is now stored, which is
/// what the caller should draw itself at — a request below [`MIN_OPACITY`]
/// comes back as the floor rather than as a widget nobody can find.
///
/// Nothing is done to the window here: the alpha is the webview's to paint,
/// and it repaints itself on the broadcast this sends.
pub fn set_opacity(app: &AppHandle, opacity: f64) -> Result<f64, String> {
    let opacity = clamp_opacity(opacity);
    with_db(app, |conn| set_number(conn, OPACITY_KEY, opacity))?;
    announce(app);
    Ok(opacity)
}

/// Section 26's four layouts: which one the widget draws.
///
/// The fourth control the Settings page offers, and the one that has no twin
/// in the widget's own chrome — there is no room in a 300px window for a
/// four-way picker, and switching layout is not something you do while
/// working. Nothing is done to the window: the mode is the webview's to
/// render, and it re-reads on the broadcast this sends.
pub fn set_mode(app: &AppHandle, mode: WidgetMode) -> Result<WidgetMode, String> {
    with_db(app, |conn| settings::set(conn, MODE_KEY, mode.as_str()))?;
    announce(app);
    Ok(mode)
}

/// Section 83's "Resize", clamped. Answers with the size the window was
/// actually given.
///
/// The drag itself is the webview's — it is the one place that knows where the
/// pointer is relative to the corner it grabbed — but the arithmetic is not
/// trusted: a mis-measured frame stops at the ceiling rather than turning a
/// widget into a full-screen panel. This is the same division as the quick
/// launcher's `set_height`.
pub fn resize(app: &AppHandle, width: f64, height: f64) -> Result<WidgetSize, String> {
    let width = clamp_width(width);
    let height = clamp_height(height);

    if let Some(window) = find(app) {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| format!("could not resize the widget window: {error}"))?;
    }

    // The `Resized` event this provokes is throttled like any other, so the
    // size is written here rather than left to it: a resize that ends inside
    // the throttle window is exactly the case section 83 asks to persist.
    with_db(app, |conn| {
        let transaction = conn.unchecked_transaction()?;
        set_number(&transaction, WIDTH_KEY, width)?;
        set_number(&transaction, HEIGHT_KEY, height)?;
        transaction.commit()?;
        Ok(())
    })?;

    Ok(WidgetSize { width, height })
}

/// Section 83's "Move": hands the window to the OS's own drag loop.
///
/// The widget has no title bar, so its whole body is the drag handle (minus
/// the controls, which the frontend excludes). Doing it this way rather than
/// by streaming pointer deltas back is what makes dragging feel native —
/// snapping, multi-monitor and the pointer never getting ahead of the window
/// are all the window manager's problem, not ours.
pub fn start_drag(app: &AppHandle) -> Result<(), String> {
    let Some(window) = find(app) else {
        return Ok(());
    };

    window
        .start_dragging()
        .map_err(|error| format!("could not move the widget window: {error}"))
}

/// Records where the widget is now, at most once every
/// [`GEOMETRY_WRITE_INTERVAL`].
///
/// `lib.rs` calls this for every `Moved` and `Resized` the widget reports,
/// which during a drag is one a frame.
pub fn remember_geometry(app: &AppHandle) {
    if !write_is_due(false) {
        return;
    }
    write_geometry(app);
}

/// Records where the widget is now, throttle or no throttle.
///
/// For the moments the stream of `Moved` events is known to have stopped —
/// the widget being hidden, blurred or destroyed — so what ends up stored is
/// where the user let go rather than wherever they were 400ms earlier.
pub fn flush_geometry(app: &AppHandle) {
    write_is_due(true);
    write_geometry(app);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Shows the widget, building it from what is stored on first use.
fn reveal(app: &AppHandle, focus: bool) -> Result<(), String> {
    match find(app) {
        Some(window) => {
            window
                .show()
                .map_err(|error| format!("could not show the widget window: {error}"))?;
            let _ = window.unminimize();
            if focus {
                let _ = window.set_focus();
            }
            let _ = app.emit_to(WIDGET_LABEL, WIDGET_SHOWN_EVENT, ());
        }
        None => {
            let settings = settings_for(app)?;
            build(app, &settings, focus)?;
        }
    }

    remember_visible(app, true);
    Ok(())
}

fn build(
    app: &AppHandle,
    settings: &WidgetSettings,
    focus: bool,
) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(app, WIDGET_LABEL, WebviewUrl::App(WIDGET_URL.into()))
        // Named for the alt-tab list it is not in; nothing draws it, because
        // there is no title bar to draw it on.
        .title("Widget")
        .inner_size(settings.width, settings.height)
        // Section 83's five controls are all in the widget itself, so the OS
        // chrome would only be a second, larger set of the same buttons — and
        // a title bar is most of the height of a 260px window.
        .decorations(false)
        // The window is a pane of glass; the widget paints the card on it at
        // the stored opacity. See the module docs.
        .transparent(true)
        // Windows draws a rectangular shadow around an undecorated window,
        // which on a transparent one is a grey box around nothing.
        .shadow(false)
        // Resizing is the frontend's drag handle calling `resize`, so the
        // window itself needs no edges to grab — but it must be *allowed* to
        // change size for that call to land.
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(settings.pinned)
        .skip_taskbar(true)
        .focused(focus);

    let builder = match placement(app, settings) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };

    builder
        .build()
        .map_err(|error| format!("could not create the widget window: {error}"))
}

/// Where to put the widget when it is built.
///
/// The stored position wins, but only if it still lands on a monitor: a widget
/// remembered onto a laptop's second screen and reopened without it would
/// otherwise be a window the user cannot see, cannot alt-tab to (it skips the
/// taskbar) and cannot move (its drag handle is off screen too). `None` when
/// there is nowhere to put it, which the caller turns into a centred window.
fn placement(app: &AppHandle, settings: &WidgetSettings) -> Option<(f64, f64)> {
    if let (Some(x), Some(y)) = (settings.x, settings.y) {
        if is_on_screen(app, x, y, settings.width, settings.height) {
            return Some((x, y));
        }
    }

    default_position(app, settings.width, settings.height)
}

/// The bottom-right of the primary monitor's *work area*, in logical pixels.
///
/// The work area rather than the screen, because bottom-right is under the
/// Windows taskbar otherwise. Bottom-right rather than the popup's top-right
/// so the two do not open on top of each other — a glance and a widget are
/// meant to be usable at the same time.
fn default_position(app: &AppHandle, width: f64, height: f64) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok()??;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);

    Some((
        origin.x + size.width - width - SCREEN_MARGIN,
        origin.y + size.height - height - SCREEN_MARGIN,
    ))
}

/// Whether a stored rectangle still overlaps a monitor by enough of itself to
/// be grabbable — [`MIN_VISIBLE_WIDTH`] by [`MIN_VISIBLE_HEIGHT`] of it.
///
/// Deliberately generous: the question is "can the user get hold of this",
/// not "is it fully on screen". A widget deliberately parked half off the
/// right-hand edge is a thing people do, and moving it back for them would be
/// the more annoying answer.
fn is_on_screen(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        // Nothing to check it against, so the stored position is as good a
        // guess as any — and better than overriding one that was fine.
        return true;
    };

    monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let origin = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);

        let overlap_x = (x + width).min(origin.x + size.width) - x.max(origin.x);
        let overlap_y = (y + height).min(origin.y + size.height) - y.max(origin.y);

        overlap_x >= MIN_VISIBLE_WIDTH.min(width) && overlap_y >= MIN_VISIBLE_HEIGHT.min(height)
    })
}

/// Stores whether the widget is on screen, and tells the other windows.
///
/// Failures are reported rather than returned: the window has already been
/// shown or hidden by the time this runs, and refusing the whole call over a
/// setting that did not save would be undoing something the user watched
/// happen.
fn remember_visible(app: &AppHandle, visible: bool) {
    if let Err(error) = with_db(app, |conn| settings::set_bool(conn, VISIBLE_KEY, visible)) {
        crate::log_error!("could not remember whether the widget is open: {error}");
    }
    announce(app);
}

/// Reads the window's geometry and stores it, in one transaction.
///
/// Only while it is on screen: a hidden window's reported position is not
/// somewhere the user put it, and on Windows a hide can report a size of
/// nothing at all — which is how "reopens where you left it" would quietly
/// become "reopens at 0 x 0".
fn write_geometry(app: &AppHandle) {
    let Some(window) = find(app) else {
        return;
    };

    if !window.is_visible().unwrap_or(false) {
        return;
    }

    let Some((x, y, width, height)) = geometry(&window) else {
        return;
    };

    let stored = with_db(app, |conn| {
        let transaction = conn.unchecked_transaction()?;
        set_number(&transaction, X_KEY, x)?;
        set_number(&transaction, Y_KEY, y)?;
        set_number(&transaction, WIDTH_KEY, width)?;
        set_number(&transaction, HEIGHT_KEY, height)?;
        transaction.commit()?;
        Ok(())
    });

    if let Err(error) = stored {
        crate::log_error!("could not remember where the widget is: {error}");
    }
}

/// The window's position and size in logical pixels, or `None` if either
/// could not be read or the window has no size worth storing.
fn geometry(window: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);

    if size.width < 1.0 || size.height < 1.0 {
        return None;
    }

    Some((position.x, position.y, size.width, size.height))
}

/// Whether geometry may be written now, marking the moment if so.
///
/// `force` skips the interval but still resets it, so a flush is not
/// immediately followed by a throttled write of the same values.
fn write_is_due(force: bool) -> bool {
    let Ok(mut last) = LAST_GEOMETRY_WRITE.lock() else {
        // A poisoned lock means some earlier write panicked. Storing the
        // window's position is not worth refusing to do again over.
        return true;
    };

    let now = Instant::now();

    if !force {
        if let Some(previous) = *last {
            if now.duration_since(previous) < GEOMETRY_WRITE_INTERVAL {
                return false;
            }
        }
    }

    *last = Some(now);
    true
}

/// Tells every window that a stored widget setting has changed.
///
/// Fire-and-forget: the write it follows has already landed, and a broadcast
/// that fails is a stale toggle in another window rather than a lost setting.
fn announce(app: &AppHandle) {
    if let Err(error) = app.emit(WIDGET_SETTINGS_EVENT, ()) {
        crate::log_error!("could not announce the widget settings: {error}");
    }
}

/// Reads a stored number, treating an unparseable or non-finite value as
/// unset — a hand-edited `settings` row can leave the widget at its defaults,
/// never at `NaN` pixels.
fn number(conn: &Connection, key: &str) -> ServiceResult<Option<f64>> {
    Ok(settings::get(conn, key)?
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite()))
}

fn set_number(conn: &Connection, key: &str, value: f64) -> ServiceResult<()> {
    settings::set(conn, key, &value.to_string())
}

fn clamp_width(value: f64) -> f64 {
    clamp(value, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH)
}

fn clamp_height(value: f64) -> f64 {
    clamp(value, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT)
}

fn clamp_opacity(value: f64) -> f64 {
    clamp(value, MIN_OPACITY, MAX_OPACITY, DEFAULT_OPACITY)
}

/// `f64::clamp` with an answer for `NaN`, which would otherwise survive it —
/// and none of these values arrive from anywhere worth trusting arithmetic
/// from.
fn clamp(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

/// Runs `write` against the managed connection, flattening both ways it can
/// fail — a poisoned mutex and a statement that did not run — into the one
/// string every caller here reports.
fn with_db<T>(
    app: &AppHandle,
    write: impl FnOnce(&Connection) -> ServiceResult<T>,
) -> Result<T, String> {
    // `try_state`: the widget's geometry is written from `Moved`/`Resized`
    // window events, which cannot unwind. See `lib.rs`'s close handler.
    let state = app
        .try_state::<DbConnection>()
        .ok_or("the database is not ready yet")?;
    let conn = state.lock().map_err(|error| error.to_string())?;
    write(&conn).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    #[test]
    fn a_fresh_install_has_a_hidden_widget_at_its_defaults() {
        let conn = init_memory_db().unwrap();
        let settings = stored(&conn).unwrap();

        // Section 83: "completely optional". Nothing but the user may open it.
        assert!(!settings.visible);
        assert_eq!(settings.x, None);
        assert_eq!(settings.y, None);
        assert_eq!(settings.width, DEFAULT_WIDTH);
        assert_eq!(settings.height, DEFAULT_HEIGHT);
        assert!(settings.pinned);
        assert_eq!(settings.opacity, DEFAULT_OPACITY);
        assert_eq!(settings.mode, DEFAULT_MODE);
    }

    #[test]
    fn every_control_round_trips() {
        let conn = init_memory_db().unwrap();

        settings::set_bool(&conn, VISIBLE_KEY, true).unwrap();
        settings::set_bool(&conn, PINNED_KEY, false).unwrap();
        set_number(&conn, X_KEY, -40.0).unwrap();
        set_number(&conn, Y_KEY, 12.5).unwrap();
        set_number(&conn, WIDTH_KEY, 420.0).unwrap();
        set_number(&conn, HEIGHT_KEY, 300.0).unwrap();
        set_number(&conn, OPACITY_KEY, 0.65).unwrap();
        settings::set(&conn, MODE_KEY, WidgetMode::Combined.as_str()).unwrap();

        let settings = stored(&conn).unwrap();
        assert!(settings.visible);
        assert!(!settings.pinned);
        // A negative x is a monitor to the left of the primary one, not a
        // mistake, and storage does not second-guess it.
        assert_eq!(settings.x, Some(-40.0));
        assert_eq!(settings.y, Some(12.5));
        assert_eq!(settings.width, 420.0);
        assert_eq!(settings.height, 300.0);
        assert_eq!(settings.opacity, 0.65);
        assert_eq!(settings.mode, WidgetMode::Combined);
    }

    /// Every mode survives the round trip through the `settings` row, and a
    /// row naming a mode this build does not have leaves the widget with a
    /// layout rather than with none.
    #[test]
    fn a_mode_round_trips_and_an_unknown_one_falls_back() {
        let conn = init_memory_db().unwrap();

        for mode in [
            WidgetMode::Task,
            WidgetMode::Focus,
            WidgetMode::Routine,
            WidgetMode::Combined,
        ] {
            settings::set(&conn, MODE_KEY, mode.as_str()).unwrap();
            assert_eq!(stored(&conn).unwrap().mode, mode);
        }

        for junk in ["", "Task", "tasks", "combined ", "5"] {
            settings::set(&conn, MODE_KEY, junk).unwrap();
            assert_eq!(
                stored(&conn).unwrap().mode,
                DEFAULT_MODE,
                "{junk:?} must leave the widget at its default layout"
            );
        }
    }

    /// The wire shape of a mode, which `WidgetMode` in
    /// `src/services/widgetService.ts` declares by hand and the mode picker
    /// sends back. A mismatch would be a picker that changed nothing.
    #[test]
    fn a_mode_serialises_as_the_frontend_declares_it() {
        for (mode, wire) in [
            (WidgetMode::Task, "\"task\""),
            (WidgetMode::Focus, "\"focus\""),
            (WidgetMode::Routine, "\"routine\""),
            (WidgetMode::Combined, "\"combined\""),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), wire);
            assert_eq!(
                serde_json::from_str::<WidgetMode>(wire).unwrap(),
                mode,
                "and back again, which is the direction the picker uses"
            );
            // The stored word and the wire word are deliberately the same, so
            // a `settings` row can be read without a decoder ring.
            assert_eq!(format!("\"{}\"", mode.as_str()), wire);
        }

        assert!(serde_json::from_str::<WidgetMode>("\"dashboard\"").is_err());
    }

    #[test]
    fn a_stored_size_or_opacity_outside_the_limits_is_pulled_back_in() {
        let conn = init_memory_db().unwrap();

        set_number(&conn, WIDTH_KEY, 4000.0).unwrap();
        set_number(&conn, HEIGHT_KEY, 1.0).unwrap();
        set_number(&conn, OPACITY_KEY, 0.0).unwrap();

        let settings = stored(&conn).unwrap();
        assert_eq!(settings.width, MAX_WIDTH);
        assert_eq!(settings.height, MIN_HEIGHT);
        assert_eq!(settings.opacity, MIN_OPACITY);
    }

    #[test]
    fn a_value_that_is_not_a_number_reads_as_unset() {
        let conn = init_memory_db().unwrap();

        for stored_value in ["", "wide", "NaN", "inf"] {
            settings::set(&conn, WIDTH_KEY, stored_value).unwrap();
            settings::set(&conn, X_KEY, stored_value).unwrap();

            let settings = stored(&conn).unwrap();
            assert_eq!(
                settings.width, DEFAULT_WIDTH,
                "{stored_value:?} must leave the width at its default"
            );
            assert_eq!(
                settings.x, None,
                "{stored_value:?} must leave the widget unplaced"
            );
        }
    }

    #[test]
    fn clamping_answers_for_values_that_are_not_numbers() {
        assert_eq!(clamp_opacity(f64::NAN), DEFAULT_OPACITY);
        assert_eq!(clamp_width(f64::INFINITY), DEFAULT_WIDTH);
        assert_eq!(clamp_height(f64::NEG_INFINITY), DEFAULT_HEIGHT);
    }

    #[test]
    fn geometry_writes_are_throttled_but_a_flush_always_gets_through() {
        // The throttle is shared global state, so this starts by claiming it.
        assert!(write_is_due(true));
        assert!(!write_is_due(false), "a second write in the same instant");
        assert!(write_is_due(true), "a flush ignores the interval");
        assert!(!write_is_due(false), "and resets it, rather than opening it");
    }
}
