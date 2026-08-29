mod commands;
mod db;
mod services;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let conn = db::init_db(&app_data_dir).expect("failed to initialize database");

            // A focus session still open at this point belongs to a run that
            // is over — the app was killed, or crashed, while the clock was
            // going — so it is recorded as interrupted before anything can
            // read it. Doing it here, once, is also what lets a *reloaded*
            // window resume: after this line, an open session is always one
            // this run started, so `get_active_focus_session` can be trusted
            // to describe a clock somebody is actually watching. A failure is
            // logged rather than fatal; a stale row is not a reason to refuse
            // to launch.
            close_abandoned_focus_session(&conn, "was left running by the last run");

            app.manage(db::DbConnection::new(conn));

            // Reminders are checked by a background thread rather than by the
            // UI, which is the whole point of section 24: a notification that
            // only arrived while the dashboard happened to be open would be a
            // notification for someone who did not need one. Started after
            // the connection is managed, because the first thing it does is
            // ask for it.
            commands::notification::start_scheduler(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };

            let app = window.app_handle();

            // Closing the popup (section 25) puts it away rather than tearing
            // it down: its webview is kept so the next summon — the sidebar
            // button now, the tray icon and shortcut in Stage 8 — is instant
            // and lands on what the user was looking at. Nothing else here
            // applies to it; a focus session belongs to the app, not to the
            // little window that happened to be shut.
            if window.label() == services::popup::POPUP_LABEL {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("could not hide the popup window: {error}");
                }
                return;
            }

            // The ordinary way a session ends without being finished: the user
            // closes the window on a running clock. Recorded here rather than
            // from the frontend because JS's `onCloseRequested` closes the
            // window by calling `destroy()`, a permission `core:window:default`
            // does not grant — a close handler that needed one the app does not
            // have would be a window that could not be closed. This runs before
            // the window goes and cannot refuse to let it.
            //
            // It costs the pause: `close_abandoned` works from the wall clock,
            // and the paused milliseconds only ever existed in the store. The
            // cap on the session's own length is what keeps that bounded, and
            // the session is interrupted either way — which is the part
            // section 35 is actually asking about.
            match app.state::<db::DbConnection>().lock() {
                Ok(conn) => {
                    close_abandoned_focus_session(&conn, "was running when the window closed")
                }
                Err(error) => {
                    eprintln!("could not reach the database while closing: {error}")
                }
            }

            // The main window going means the app is going, and Tauri only
            // exits once the last window is gone — so a popup left hidden
            // would keep the process alive with nothing on screen and no way
            // to quit it.
            services::popup::destroy(app);
        })
        .invoke_handler(tauri::generate_handler![
            commands::health::db_health_check,
            commands::popup::open_popup_window,
            commands::popup::dismiss_popup_window,
            commands::popup::toggle_popup_window,
            commands::popup::is_popup_window_open,
            commands::popup::focus_main_window,
            commands::focus::start_focus_session,
            commands::focus::end_focus_session,
            commands::focus::end_active_focus_session,
            commands::focus::get_active_focus_session,
            commands::focus::get_focus_session,
            commands::focus::list_focus_sessions,
            commands::tasks::create_task,
            commands::tasks::get_task,
            commands::tasks::update_task,
            commands::tasks::delete_task,
            commands::tasks::list_tasks,
            commands::tasks::ensure_recurring_tasks,
            commands::notification::set_task_reminder,
            commands::notification::get_task_reminder,
            commands::notification::list_task_reminders,
            commands::notification::snooze_task_reminder,
            commands::notification::dismiss_task_reminder,
            commands::notification::check_task_reminders,
            commands::notification::notification_capabilities,
            commands::notification::send_test_notification,
            commands::task_categories::list_task_categories,
            commands::task_categories::get_task_category,
            commands::task_categories::create_task_category,
            commands::task_categories::update_task_category,
            commands::task_categories::delete_task_category,
            commands::task_recurrence::list_task_recurrences,
            commands::task_recurrence::get_task_recurrence,
            commands::task_recurrence::delete_task_recurrence,
            commands::routines::list_routines,
            commands::routines::get_routine,
            commands::routines::create_routine,
            commands::routines::update_routine,
            commands::routines::delete_routine,
            commands::routines::list_routine_actions,
            commands::routines::add_routine_action,
            commands::routines::update_routine_action,
            commands::routines::delete_routine_action,
            commands::routines::reorder_routine_actions,
            commands::routines::replace_routine_actions,
            commands::routines::launch_routine,
            commands::routines::retry_routine_actions,
            commands::routines::get_command_actions_enabled,
            commands::routines::set_command_actions_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Ends whichever focus session is still running, as interrupted, and says so.
///
/// Shared by the two moments a clock stops being watched — the window closing,
/// and the next launch finding what a crash left behind — so both record the
/// same thing in the same way. Neither can do anything useful about a failure,
/// so both only report it: at startup the row is left for the *next* launch to
/// catch, and on close there is nothing left to tell.
fn close_abandoned_focus_session(conn: &rusqlite::Connection, occasion: &str) {
    match services::focus::close_abandoned(conn) {
        Ok(Some(session)) => {
            eprintln!("focus session {} {occasion}; recorded as interrupted", session.id)
        }
        Ok(None) => {}
        Err(error) => eprintln!("could not close the running focus session: {error}"),
    }
}
