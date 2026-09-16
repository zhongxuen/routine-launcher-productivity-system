//! The system tray icon and its menu (development-plan.md sections 27, 79).
//!
//! Section 27 calls the tray "the fastest access point" and draws it as:
//!
//! ```text
//! Routine Launcher
//!
//! Today's Tasks
//! 3 / 7 completed
//! ☀️ Start My Day
//! 🌙 Review My Day
//!
//! ────────────────
//!
//! 🚀 Coding
//! 📚 Study
//! 💼 Work
//!
//! ────────────────
//!
//! ⏱ Start Focus
//!
//! ────────────────
//!
//! + Add Task
//!
//! Open Dashboard
//! Settings
//! Exit
//! ```
//!
//! `☀️ Start My Day` is not in section 27's drawing. It is section 21's
//! morning flow, placed under today's count because that is the day it
//! starts, and like the rest it only opens the app's own dialog.
//! `🌙 Review My Day` is section 22's end-of-day review beside it, for the
//! same reason.
//!
//! This module owns that menu, and lives beside [`super::popup`] rather than
//! in `commands/` for the same reason: it is a window-and-OS surface the app
//! drives itself, not something the frontend invokes. Two rules shape it.
//!
//! ## 1. The menu is read from the database, the actions are run by the app
//!
//! The count and the routine list are *facts*, so they are read here, from
//! the same services every command reads — `tasks::list` with the `today`
//! view, the same query the dashboard and the popup run, and
//! `routines::top_by_use`, the same ranking the dashboard's QUICK START row
//! uses. A tray that kept its own idea of today would be a second answer to a
//! question that already has one.
//!
//! Clicking an item is a different matter. Launching a routine puts section
//! 32's checklist panel on screen, starting a focus session starts the clock
//! the whole frontend is built around, and adding a task opens section 16's
//! dialog — all of which live in the stores. So a click does not re-implement
//! any of that: it shows the main window and emits one [`TRAY_ACTION_EVENT`],
//! and `src/hooks/useTrayActions.ts` turns it into the same call the button
//! for it would have made.
//!
//! Two items are the exception, because neither is the main window's to do:
//! Exit, since quitting is the one thing no window can do for itself, and
//! Show/Hide Widget, since section 83's widget is a separate window and
//! waking the main one to toggle it would be the opposite of what an optional
//! always-on-top widget is for.
//!
//! ## 2. The menu is rebuilt, never patched
//!
//! `3 / 7 completed` is wrong the moment a task is ticked off anywhere, so
//! the menu is thrown away and rebuilt on every signal that it might have
//! moved:
//!
//! * `app://data-changed` — the cross-window broadcast every task and routine
//!   write already sends (`src/lib/window-sync.ts`). The tray is simply a
//!   third listener alongside the two windows.
//! * the pointer entering the tray icon — the catch-all, and the last moment
//!   before a right-click can open the menu. It covers what a broadcast
//!   cannot: the date rolling over, a reminder completing a recurring task,
//!   a routine launched from the popup while this window was asleep.
//!
//! Rebuilding costs two indexed reads and happens at most once per hover, so
//! there is nothing to be gained by diffing.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, Wry};

use crate::db::DbConnection;
use crate::services::error::ServiceResult;
use crate::services::notifications::PRODUCT_NAME;
use crate::services::tasks::{TaskFilter, TaskStatus, TaskView};
use crate::services::{popup, routines, settings, tasks, widget};

/// The tray icon's id, so it can be found again to have its menu replaced.
const TRAY_ID: &str = "main";

/// Emitted to the main window when a menu item is chosen. Payload is a
/// [`TrayAction`].
pub const TRAY_ACTION_EVENT: &str = "tray://action";

/// The frontend's own broadcast that something was written
/// (`src/lib/window-sync.ts`). Listened to here so the menu keeps up.
const DATA_CHANGED_EVENT: &str = "app://data-changed";

/// Settings key for section 27's close-to-tray behaviour. Absent means on —
/// see [`minimize_on_close`].
pub const MINIMIZE_TO_TRAY_KEY: &str = "tray.minimize_on_close";

/// Settings key recording that the user has been told once that closing the
/// window does not quit. See [`should_announce_minimize`].
const CLOSE_NOTICE_SHOWN_KEY: &str = "tray.close_notice_shown";

/// How many routines the menu offers.
///
/// Section 27 draws three, which is what a user with three routines gets.
/// Five is the cap because past that the menu stops being a shortcut and
/// starts being the routine list — the same trade the dashboard's QUICK START
/// row makes at four tiles, loosened by one because a menu row is cheaper
/// than a tile.
const MAX_TRAY_ROUTINES: usize = 5;

/// The glyph a routine with no icon of its own wears in the menu.
///
/// The frontend draws a rocket *outline* for these (`RoutineIcon`), which a
/// text-only menu cannot do, so it gets the emoji the mockup itself uses.
const DEFAULT_ROUTINE_GLYPH: &str = "🚀";

/// Set while [`quit`] is tearing the app down, so the close handler stops
/// hiding the main window and lets it actually close.
///
/// Without this, Exit and close-to-tray would fight: quitting closes the
/// windows, closing the main window hides it instead, and the app would sit
/// there invisible with no way out but Task Manager.
static QUITTING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Menu item ids
// ---------------------------------------------------------------------------

const HEADER_ID: &str = "tray:header";
const TODAY_HEADING_ID: &str = "tray:today-heading";
const TODAY_COUNT_ID: &str = "tray:today-count";
const START_MY_DAY_ID: &str = "tray:start-my-day";
const REVIEW_MY_DAY_ID: &str = "tray:review-my-day";
const NO_ROUTINES_ID: &str = "tray:no-routines";
const START_FOCUS_ID: &str = "tray:start-focus";
const ADD_TASK_ID: &str = "tray:add-task";
const WIDGET_ID: &str = "tray:widget";
const DASHBOARD_ID: &str = "tray:dashboard";
const SETTINGS_ID: &str = "tray:settings";
const EXIT_ID: &str = "tray:exit";

/// Prefix of a routine item's id; what follows is the routine's row id.
const ROUTINE_ID_PREFIX: &str = "tray:routine:";

// ---------------------------------------------------------------------------
// What a click means
// ---------------------------------------------------------------------------

/// What the user picked, as the frontend is told about it.
///
/// Deliberately an *intent* rather than a result: the tray says "launch this
/// routine", and the store decides what that involves. See the module docs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TrayAction {
    LaunchRoutine { routine_id: i64 },
    /// Opens section 21's Start My Day dialog. The dialog, not the tray,
    /// decides which routine that is (section 52's start-of-day routine).
    StartMyDay,
    /// Opens section 22's end-of-day review. Offered at any hour: the
    /// dashboard only shows its button from the day's end, but someone
    /// reaching for it in the tray has already decided the day is over.
    ReviewMyDay,
    StartFocus,
    AddTask,
    OpenDashboard,
    OpenSettings,
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// Builds the tray icon, its menu and its handlers. Called once, from
/// `setup`, after the database is managed — the first menu is read from it.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // The menu is section 27's, and it belongs on the right button. A
        // left click is the glance — see `on_tray_icon_event` below.
        .show_menu_on_left_click(false)
        .tooltip(PRODUCT_NAME)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| handle_icon_event(tray.app_handle(), event));

    // The window icon is the app's icon, which is what a tray icon should be.
    // A build without one still gets a working menu rather than no tray.
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;

    // The other windows already announce every write; the tray joins them as
    // a listener rather than asking anybody to announce twice.
    let handle = app.clone();
    app.listen(DATA_CHANGED_EVENT, move |_event| refresh(&handle));

    Ok(())
}

/// Rebuilds the menu from the database.
///
/// Failure is logged and swallowed: a menu that could not be rebuilt is a
/// stale menu, which still works, and there is no user standing in front of
/// this to tell.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    match build_menu(app) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                crate::log_error!("[tray] could not replace the menu: {error}");
            }
        }
        Err(error) => crate::log_error!("[tray] could not rebuild the menu: {error}"),
    }
}

// ---------------------------------------------------------------------------
// Closing to the tray
// ---------------------------------------------------------------------------

/// Whether closing the main window should hide it rather than quit.
///
/// On unless the user turns it off, which is what makes the tray worth having
/// at all: an app that quits when its window is closed has nothing to be the
/// "fastest access point" *to*. Reads false while [`quit`] is running, so the
/// window Exit is closing is not the window this puts back in the tray.
///
/// A database that cannot be read falls back to on, matching the default a
/// fresh install gets — and the safer of the two, since the recoverable
/// mistake is a window the user has to click the tray icon to get back.
pub fn minimize_on_close(app: &AppHandle) -> bool {
    if QUITTING.load(Ordering::SeqCst) {
        return false;
    }

    with_db(app, |conn| {
        settings::get_bool(conn, MINIMIZE_TO_TRAY_KEY, true)
    })
    .unwrap_or(true)
}

/// Whether this is the first close to the tray, marking it as told if so.
///
/// The read and the write are one call because they are one decision: the
/// notice is owed exactly once, and a caller that could check without
/// recording would be a caller that can show it twice.
pub fn should_announce_minimize(app: &AppHandle) -> bool {
    with_db(app, |conn| {
        if settings::get_bool(conn, CLOSE_NOTICE_SHOWN_KEY, false)? {
            return Ok(false);
        }
        settings::set_bool(conn, CLOSE_NOTICE_SHOWN_KEY, true)?;
        Ok(true)
    })
    .unwrap_or(false)
}

/// Section 27's Exit: the one way out of the app once closing the window only
/// hides it.
///
/// Does by hand what closing the last window would have done — records the
/// running focus session as interrupted, tears the popup down — because
/// `exit` is not a window close and neither would happen otherwise. The flag
/// goes up first so the close handler does not put the main window back into
/// the tray on the way past.
pub fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);

    // `try_state`, not `state`: quitting is reached from a tray menu item,
    // which is a callback that cannot unwind, and the state is genuinely
    // absent if the app is being quit before `setup` managed it. See the
    // matching note in `lib.rs`'s close handler.
    match app.try_state::<DbConnection>() {
        Some(state) => match state.lock() {
            Ok(conn) => {
                crate::close_abandoned_focus_session(&conn, "was running when the app was quit")
            }
            Err(error) => crate::log_error!(
                "[tray] could not reach the database while quitting: {error}"
            ),
        },
        None => crate::log_warn!("[tray] quit before the database was ready"),
    }

    popup::destroy(app);
    // The widget stores where it is as it is dragged, throttled, so quitting
    // while the last move is still inside that window would lose it. Its
    // stored *visibility* is untouched: quitting is not the user putting the
    // widget away, and the next run is meant to bring it back.
    widget::destroy(app);
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();

    // Every routine shares one id shape, so it is matched before the fixed
    // items rather than listed among them.
    if let Some(routine_id) = id
        .strip_prefix(ROUTINE_ID_PREFIX)
        .and_then(|rest| rest.parse::<i64>().ok())
    {
        dispatch(app, TrayAction::LaunchRoutine { routine_id });
        return;
    }

    match id {
        START_MY_DAY_ID => dispatch(app, TrayAction::StartMyDay),
        REVIEW_MY_DAY_ID => dispatch(app, TrayAction::ReviewMyDay),
        START_FOCUS_ID => dispatch(app, TrayAction::StartFocus),
        ADD_TASK_ID => dispatch(app, TrayAction::AddTask),
        // Not dispatched: section 83's widget is a window of its own, and
        // dispatching would haul the main window to the front to do a job it
        // has no part in.
        WIDGET_ID => toggle_widget(app),
        DASHBOARD_ID => dispatch(app, TrayAction::OpenDashboard),
        SETTINGS_ID => dispatch(app, TrayAction::OpenSettings),
        EXIT_ID => quit(app),
        // The headings and the empty-state line. They are disabled, so this
        // should not arrive at all; ignoring it is the whole handling.
        _ => {}
    }
}

/// Shows or hides section 83's widget, off the main thread.
///
/// The thread matters. A menu event arrives on the main thread, and the first
/// summon of the widget has to *build* its window — which deadlocks if it is
/// done from the thread the event loop runs on, because the builder is
/// waiting for a loop that is waiting for this handler to return. So the work
/// is handed to the async runtime, which is where `commands::widget`'s own
/// entry points run for the same reason.
///
/// Nothing is reported back to a user who is looking at a menu that has
/// already closed; a failure goes to the console and the menu is rebuilt
/// either way, so its wording matches whatever actually happened.
fn toggle_widget(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = widget::toggle(&handle) {
            crate::log_error!("[tray] could not toggle the widget: {error}");
        }
        refresh(&handle);
    });
}

/// Shows or hides section 25's popup, off the main thread — for the reason
/// [`toggle_widget`] is: an icon event arrives on the thread the event loop
/// runs on, and the first summon has to build the popup's window, which
/// deadlocks there.
fn toggle_popup(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = popup::toggle(&handle) {
            crate::log_error!("[tray] could not toggle the popup: {error}");
        }
    });
}

fn handle_icon_event(app: &AppHandle, event: TrayIconEvent) {
    match event {
        // The pointer is on the icon and the menu has not opened yet: the
        // last chance to make sure it says something true.
        TrayIconEvent::Enter { .. } => refresh(app),

        // A left click is the glance, so it summons the compact popup of
        // section 25 rather than the whole app — that window exists for
        // exactly this, and "Open Dashboard" in the menu is how you ask for
        // the rest. Filtered to the release, because a click reports both
        // halves and toggling on each would be a popup that never opens.
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => toggle_popup(app),

        _ => {}
    }
}

/// Shows the main window and tells it what was picked.
///
/// The window comes first and unconditionally: every action here ends in
/// something the user is meant to look at — a launch panel, a running clock,
/// the quick-add dialog — and delivering one to a hidden window would be a
/// menu item that appears to do nothing.
fn dispatch(app: &AppHandle, action: TrayAction) {
    if let Err(error) = popup::show_main(app) {
        crate::log_error!("[tray] could not bring the main window forward: {error}");
    }

    if let Err(error) = app.emit_to(popup::MAIN_LABEL, TRAY_ACTION_EVENT, action) {
        crate::log_error!("[tray] could not deliver the menu action: {error}");
    }
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

/// One item, appended. `enabled: false` is how a heading is drawn: the menu
/// has no notion of a caption, so a caption is a line you cannot click.
fn push_item(
    app: &AppHandle,
    items: &mut Vec<Box<dyn IsMenuItem<Wry>>>,
    id: &str,
    text: &str,
    enabled: bool,
) -> tauri::Result<()> {
    items.push(Box::new(MenuItem::with_id(
        app,
        id,
        text,
        enabled,
        None::<&str>,
    )?));
    Ok(())
}

/// What the widget entry says, which depends on whether the widget is on
/// screen right now.
///
/// Asked of the window rather than of the `settings` row, because the widget
/// can be put away by its own ✕ button without anything telling the tray —
/// and the entry is read a moment after the pointer arrives, so the answer is
/// as fresh as it can be.
fn widget_line(app: &AppHandle) -> &'static str {
    if widget::is_visible(app) {
        "Hide Widget"
    } else {
        "Show Widget"
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();

    push_item(app, &mut items, HEADER_ID, PRODUCT_NAME, false)?;
    items.push(Box::new(PredefinedMenuItem::separator(app)?));

    push_item(app, &mut items, TODAY_HEADING_ID, "Today's Tasks", false)?;
    push_item(app, &mut items, TODAY_COUNT_ID, &today_line(app), false)?;
    push_item(app, &mut items, START_MY_DAY_ID, "☀️ Start My Day", true)?;
    push_item(app, &mut items, REVIEW_MY_DAY_ID, "🌙 Review My Day", true)?;
    items.push(Box::new(PredefinedMenuItem::separator(app)?));

    let routines = with_db(app, |conn| routines::top_by_use(conn, MAX_TRAY_ROUTINES))
        .unwrap_or_else(|error| {
            crate::log_error!("[tray] could not read the routines: {error}");
            Vec::new()
        });

    if routines.is_empty() {
        push_item(app, &mut items, NO_ROUTINES_ID, "No routines yet", false)?;
    } else {
        for routine in routines {
            let glyph = routine.icon.as_deref().unwrap_or(DEFAULT_ROUTINE_GLYPH);
            push_item(
                app,
                &mut items,
                &format!("{ROUTINE_ID_PREFIX}{}", routine.id),
                &escape_mnemonics(&format!("{glyph} {}", routine.name)),
                true,
            )?;
        }
    }

    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    push_item(app, &mut items, START_FOCUS_ID, "⏱ Start Focus", true)?;

    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    push_item(app, &mut items, ADD_TASK_ID, "+ Add Task", true)?;

    items.push(Box::new(PredefinedMenuItem::separator(app)?));

    // Section 83's widget, in the block with the app's other windows. Its
    // wording is the state it is *in* plus what clicking does about it, which
    // is why the menu is rebuilt on hover: an entry offering to show a widget
    // that is already on screen would be worse than no entry at all.
    push_item(app, &mut items, WIDGET_ID, widget_line(app), true)?;

    for (id, text) in [
        (DASHBOARD_ID, "Open Dashboard"),
        (SETTINGS_ID, "Settings"),
        (EXIT_ID, "Exit"),
    ] {
        push_item(app, &mut items, id, text, true)?;
    }

    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Section 27's `3 / 7 completed`.
///
/// The two numbers are counted from the backend's `today` view — the same
/// list the popup puts the same line above — and on the same terms: a
/// cancelled task is not work owed, so it is out of the total, and the
/// figures agree with `completionCounts` in `src/lib/task-utils.ts` because
/// they are the same rule applied to the same rows.
///
/// A day with nothing in it says so rather than claiming `0 / 0`, and a read
/// that failed says *that* rather than inventing a number — section 88 would
/// rather show nothing than a figure it cannot stand behind.
fn today_line(app: &AppHandle) -> String {
    match with_db(app, today_counts) {
        Ok(counts) => count_line(counts),
        Err(error) => {
            crate::log_error!("[tray] could not count today's tasks: {error}");
            "Tasks unavailable".to_owned()
        }
    }
}

/// `(completed, total)` for the day, on the same terms as the popup's line.
fn today_counts(conn: &rusqlite::Connection) -> ServiceResult<(usize, usize)> {
    let today = tasks::list(
        conn,
        TaskFilter {
            view: Some(TaskView::Today),
            ..TaskFilter::default()
        },
    )?;

    let total = today
        .iter()
        .filter(|task| task.status != TaskStatus::Cancelled)
        .count();
    let completed = today
        .iter()
        .filter(|task| task.status == TaskStatus::Completed)
        .count();

    Ok((completed, total))
}

/// The wording of the count. A day with nothing in it says so rather than
/// claiming `0 / 0`, which reads as a broken count rather than an empty day.
fn count_line((completed, total): (usize, usize)) -> String {
    if total == 0 {
        "Nothing scheduled".to_owned()
    } else {
        format!("{completed} / {total} completed")
    }
}

/// Doubles `&` so a routine called "Work & Play" is not drawn as "Work _P_lay".
///
/// Windows menus read a single ampersand as the mnemonic marker for the
/// letter after it, and a routine's name is the user's text, not ours.
fn escape_mnemonics(text: &str) -> String {
    text.replace('&', "&&")
}

/// Runs `read` against the managed connection.
///
/// The lock is held for the length of the closure and no longer, which for
/// everything here is a pair of indexed reads. Both ways this can fail — a
/// poisoned mutex, a query that did not run — are flattened to one string,
/// because every caller does the same thing with either: log it and put
/// something honest on the menu.
fn with_db<T>(
    app: &AppHandle,
    read: impl FnOnce(&rusqlite::Connection) -> ServiceResult<T>,
) -> Result<T, String> {
    // Every caller here is reached from a menu item or a window event, which
    // is to say from a callback that cannot unwind — so a database that is
    // not managed yet has to be an `Err` and not a panic. See the note in
    // `lib.rs`'s close handler.
    let state = app
        .try_state::<DbConnection>()
        .ok_or("the database is not ready yet")?;
    let conn = state.lock().map_err(|error| error.to_string())?;
    read(&conn).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    /// Section 27's `3 / 7 completed`, counted the way the popup counts it.
    ///
    /// Only the reading is tested — building the menu itself needs a Tauri
    /// runtime, and there is nothing in it to get wrong that this does not
    /// already cover: the line is the one thing on the menu that is a claim
    /// about the user's data rather than a fixed string.
    #[test]
    fn the_count_line_reports_todays_work_and_ignores_cancelled_tasks() {
        let conn = init_memory_db().unwrap();

        // An empty day says so. "0 / 0 completed" reads as a broken count.
        assert_eq!(count_line(today_counts(&conn).unwrap()), "Nothing scheduled");

        // The local date only the database can be sure of, so the test does
        // not fail at midnight or in another time zone.
        let today: String = conn
            .query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .unwrap();

        let create = |title: &str| {
            tasks::create(
                &conn,
                serde_json::from_value(serde_json::json!({
                    "title": title,
                    "due_date": today,
                }))
                .expect("valid NewTask payload"),
            )
            .unwrap()
        };

        let report = create("Finish report");
        let study = create("Study JavaScript");
        let emails = create("Check emails");
        let dropped = create("Something else");

        assert_eq!(count_line(today_counts(&conn).unwrap()), "0 / 4 completed");

        let set_status = |id: i64, status: &str| {
            tasks::update(
                &conn,
                id,
                serde_json::from_value(serde_json::json!({ "status": status }))
                    .expect("valid TaskUpdate payload"),
            )
            .unwrap()
        };

        set_status(report.id, "completed");
        set_status(emails.id, "completed");
        assert_eq!(count_line(today_counts(&conn).unwrap()), "2 / 4 completed");

        // A cancelled task is not work owed, so it leaves the total rather
        // than sitting there forever as something that can never be ticked.
        set_status(dropped.id, "cancelled");
        assert_eq!(count_line(today_counts(&conn).unwrap()), "2 / 3 completed");

        assert_eq!(study.status, TaskStatus::Todo);
    }

    /// The wire shape of a menu choice, which `TrayAction` in
    /// `src/services/trayService.ts` declares by hand.
    ///
    /// Nothing else checks that the two agree — a mismatch would be a menu
    /// item that silently did nothing, because the `switch` on the other side
    /// would fall through every case. This is that check.
    #[test]
    fn a_menu_choice_serialises_as_the_frontend_declares_it() {
        let json = |action: TrayAction| serde_json::to_string(&action).unwrap();

        assert_eq!(
            json(TrayAction::LaunchRoutine { routine_id: 7 }),
            r#"{"kind":"launch-routine","routine_id":7}"#
        );
        assert_eq!(json(TrayAction::StartMyDay), r#"{"kind":"start-my-day"}"#);
        assert_eq!(json(TrayAction::ReviewMyDay), r#"{"kind":"review-my-day"}"#);
        assert_eq!(json(TrayAction::StartFocus), r#"{"kind":"start-focus"}"#);
        assert_eq!(json(TrayAction::AddTask), r#"{"kind":"add-task"}"#);
        assert_eq!(
            json(TrayAction::OpenDashboard),
            r#"{"kind":"open-dashboard"}"#
        );
        assert_eq!(json(TrayAction::OpenSettings), r#"{"kind":"open-settings"}"#);
    }

    /// A routine's name is the user's text, and Windows menus eat `&`.
    #[test]
    fn ampersands_in_a_routine_name_survive_the_menu() {
        assert_eq!(escape_mnemonics("Work & Play"), "Work && Play");
        assert_eq!(escape_mnemonics("Coding"), "Coding");
        assert_eq!(escape_mnemonics("R&D & Ops"), "R&&D && Ops");
    }
}
