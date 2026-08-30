mod commands;
mod db;
mod services;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Section 85's crash log, armed before anything else in the process can
    // fail. It has nowhere to write until `setup` resolves the app data
    // directory below, and holds what it records until then — see
    // `services::logging`.
    services::logging::install_panic_hook();

    let started = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // Section 85's launch-at-startup. The argument is the whole point
        // of configuring the plugin rather than taking its default: it is
        // written into the registry entry, so a run that begins at boot can
        // recognise itself and stay in the tray instead of opening a window
        // over whatever the user is doing. See `services::startup`.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(services::startup::STARTUP_ARG)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Section 85's update strategy. The endpoint and the public key its
        // manifests are verified against are in `tauri.conf.json`; the plugin
        // reads both from there, so nothing about which releases this build
        // will accept is decided in code. Its four JavaScript commands are
        // registered by this line and reachable from no window — see
        // `capabilities/desktop.json` and `services::updates`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(error) => services::logging::fatal(
                    "Windows did not say where this app may keep its data.",
                    &error,
                ),
            };

            // Before the database, deliberately: `init_db` fails on a
            // directory it cannot create or a schema it cannot migrate, and
            // that failure is the single most useful thing this file can ever
            // hold — `fatal` writes it here before putting it on screen. A
            // log that could not be opened is reported and otherwise ignored;
            // refusing to start the app over a missing diagnostic would be
            // trading a feature for a note about it.
            match services::logging::init(&app_data_dir) {
                Ok(path) => crate::log_info!("logging to {}", path.display()),
                Err(error) => eprintln!("could not start logging: {error}"),
            }

            // The one failure there is no working around and no starting
            // without, so it is reported on screen rather than left as a
            // panic nobody can see — see `services::logging::fatal`.
            let conn = match db::init_db(&app_data_dir) {
                Ok(conn) => conn,
                Err(error) => services::logging::fatal(
                    "Routine Launcher could not open the database it keeps your tasks, routines \
                     and focus history in.",
                    &error,
                ),
            };

            // Read while the connection is still to hand, so section 28's
            // shortcut can be registered below without taking the lock back
            // out of Tauri's state again.
            let accelerator = services::shortcuts::stored(&conn).unwrap_or_else(|error| {
                crate::log_error!("could not read the quick launcher shortcut: {error}");
                services::shortcuts::DEFAULT_QUICK_LAUNCHER_SHORTCUT.to_string()
            });

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

            // The tray of section 27. Built after the connection is managed
            // for the same reason: its first menu is today's task count and
            // the user's most-launched routines, both read from the database.
            // A tray that could not be built is logged and left out rather
            // than fatal — the app is still an app without it, and refusing
            // to start over a missing icon would be the worse failure.
            let tray_ready = match services::tray::init(app.handle()) {
                Ok(()) => true,
                Err(error) => {
                    crate::log_error!("could not create the system tray: {error}");
                    false
                }
            };

            // Section 85's quiet boot, and the line that puts the main window
            // on screen at all — `tauri.conf.json` builds it hidden so that a
            // startup launch never flashes one. Placed after the tray because
            // it needs to know whether there is one: a window kept hidden
            // behind an icon that does not exist is an app with no way in, so
            // a tray that failed to build overrules the preference.
            services::startup::present_main_window(app.handle(), tray_ready);

            // Section 28's shortcut, held from the moment the process is up
            // rather than from the first time someone opens the app — that is
            // the whole point of a global one. Not fatal either: see
            // `register_quick_launcher_shortcut` for what a refusal costs.
            register_quick_launcher_shortcut(app.handle(), &accelerator);

            // Section 83's widget, put back the way the last run left it —
            // which on a fresh install, and on every run of an app whose
            // owner has never opened it, is nowhere at all. Last, because it
            // is the one window that is nobody's prerequisite.
            services::widget::restore(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Section 28's quick launcher answers to a different set of events
            // from the other two windows, and to none of the ones below, so it
            // is taken out first. See `handle_launcher_event`.
            if window.label() == services::quick_launcher::LAUNCHER_LABEL {
                handle_launcher_event(window, event);
                return;
            }

            // Section 83's widget answers to `Moved` and `Resized` as well as
            // to being closed — its position and size are settings, and the
            // only report of a drag is the stream of events it makes. See
            // `handle_widget_event`.
            if window.label() == services::widget::WIDGET_LABEL {
                handle_widget_event(window, event);
                return;
            }

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
                    crate::log_error!("could not hide the popup window: {error}");
                }
                return;
            }

            // Section 27's close-to-tray. The main window is hidden instead
            // of closed, so the app keeps running behind its icon and the
            // tray can go on being "the fastest access point" — which it
            // cannot be if closing the window ends the process.
            //
            // Everything below this is about the app *ending*, and none of it
            // applies: the focus session is still being watched by a webview
            // that is merely off screen, and the popup is still worth keeping
            // for the next summon. So this returns rather than falling
            // through. `minimize_on_close` reads the Settings toggle, and
            // reads false while Exit is quitting — otherwise the two would
            // fight and the window Exit is closing would be put back.
            if window.label() == services::popup::MAIN_LABEL
                && services::tray::minimize_on_close(app)
            {
                api.prevent_close();

                if let Err(error) = window.hide() {
                    crate::log_error!("could not hide the main window: {error}");
                    return;
                }

                // Said once, the first time. A window that disappears while
                // the process carries on is the one genuinely surprising
                // thing about a tray app, and it stops being surprising
                // immediately afterwards.
                if services::tray::should_announce_minimize(app) {
                    commands::notification::announce_minimized_to_tray(app);
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
            // `try_state`, not `state`: this runs from an FFI callback that
            // cannot unwind, so a panic here does not become an error — it
            // aborts the process. And there is a real moment when the state
            // is not there, which is a window event arriving while `setup` is
            // still on its way to `manage` or has given up before reaching it
            // (see `services::logging::fatal`). Nothing useful can be done
            // about it, but "the session was not closed" is a note in the log
            // and "the app died" is not.
            match app.try_state::<db::DbConnection>() {
                Some(state) => match state.lock() {
                    Ok(conn) => {
                        close_abandoned_focus_session(&conn, "was running when the window closed")
                    }
                    Err(error) => {
                        crate::log_error!("could not reach the database while closing: {error}")
                    }
                },
                None => crate::log_warn!(
                    "a window closed before the database was ready; nothing to close"
                ),
            }

            // The main window going means the app is going, and Tauri only
            // exits once the last window is gone — so a popup or a quick
            // launcher left hidden would keep the process alive with nothing
            // on screen and no way to quit it.
            services::popup::destroy(app);
            services::quick_launcher::destroy(app);
            services::widget::destroy(app);
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info::get_app_version,
            commands::app_info::get_launch_at_startup,
            commands::app_info::set_launch_at_startup,
            commands::backup::default_backup_file_name,
            commands::backup::export_backup,
            commands::backup::inspect_backup,
            commands::backup::import_backup,
            commands::backup::reset_app_data,
            commands::diagnostics::get_log_location,
            commands::diagnostics::open_log_folder,
            commands::diagnostics::log_frontend_error,
            commands::health::db_health_check,
            commands::popup::open_popup_window,
            commands::popup::dismiss_popup_window,
            commands::popup::toggle_popup_window,
            commands::popup::is_popup_window_open,
            commands::popup::focus_main_window,
            commands::quick_launcher::open_quick_launcher,
            commands::quick_launcher::dismiss_quick_launcher,
            commands::quick_launcher::toggle_quick_launcher,
            commands::quick_launcher::set_quick_launcher_height,
            commands::quick_launcher::hold_quick_launcher,
            commands::quick_launcher::get_quick_launcher_shortcut,
            commands::quick_launcher::set_quick_launcher_shortcut,
            commands::quick_launcher::reset_quick_launcher_shortcut,
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
            commands::duplicates::default_duplicate_folders,
            commands::duplicates::scan_duplicates,
            commands::duplicates::delete_duplicate_files,
            commands::duplicates::move_duplicate_files,
            commands::duplicates::reveal_duplicate_file,
            commands::duplicates::open_duplicate_file,
            commands::onboarding::get_onboarding_seen,
            commands::onboarding::set_onboarding_seen,
            commands::updates::get_check_updates_on_launch,
            commands::updates::set_check_updates_on_launch,
            commands::updates::check_for_update,
            commands::updates::install_update,
            commands::tray::get_minimize_to_tray,
            commands::tray::set_minimize_to_tray,
            commands::tray::refresh_tray_menu,
            commands::xp::get_progress,
            commands::xp::get_level_progress,
            commands::xp::get_streak,
            commands::xp::list_xp_transactions,
            commands::xp::list_achievements,
            commands::xp::list_quest_completions,
            commands::xp::complete_quest,
            commands::downloads::scan_downloads,
            commands::downloads::move_downloads_files,
            commands::downloads::delete_downloads_files,
            commands::downloads::open_downloads_file,
            commands::downloads::reveal_downloads_file,
            commands::large_files::get_large_file_preferences,
            commands::large_files::scan_large_files,
            commands::large_files::open_large_file,
            commands::large_files::move_large_file,
            commands::large_files::archive_large_file,
            commands::large_files::delete_large_file,
            commands::large_files::ignore_large_file,
            commands::large_files::unignore_large_file,
            commands::large_files::clear_ignored_large_files,
            commands::large_files::set_large_file_archive_root,
            commands::large_files::reset_large_file_archive_root,
            commands::screenshots::scan_screenshots,
            commands::screenshots::organize_screenshots,
            commands::screenshots::default_screenshot_destination,
            commands::screenshots::open_screenshot,
            commands::screenshots::reveal_screenshot,
            commands::analytics::get_productivity_stats,
            commands::analytics::list_routine_statistics,
            commands::analytics::get_routine_statistics,
            commands::widget::open_widget_window,
            commands::widget::dismiss_widget_window,
            commands::widget::toggle_widget_window,
            commands::widget::is_widget_window_open,
            commands::widget::get_widget_settings,
            commands::widget::set_widget_pinned,
            commands::widget::set_widget_opacity,
            commands::widget::set_widget_mode,
            commands::widget::set_widget_size,
            commands::widget::start_widget_drag,
        ])
        .run(tauri::generate_context!());

    // The last way the app can fail before it is an app. In practice this is
    // WebView2: the installer offers to fetch it (`webviewInstallMode` in
    // `tauri.conf.json`), but a machine that was offline during setup, or
    // whose runtime has since been removed or broken, reaches here — and
    // reached it silently, which for the user is a shortcut that does
    // nothing. See `services::logging::fatal`.
    if let Err(error) = started {
        services::logging::fatal(
            "Routine Launcher could not start its window. This usually means the Microsoft Edge              WebView2 Runtime is missing or damaged; installing it again normally fixes it.",
            &error,
        );
    }
}

/// Registers section 28's shortcut, falling back to the default if the stored
/// one cannot be taken.
///
/// Neither failure is fatal. A shortcut the OS refuses — almost always because
/// another program got to it first — leaves the launcher reachable from the
/// tray and from Settings, which is also where it is rebound; refusing to
/// start over a hotkey would be the far worse answer. The fallback is worth
/// trying because the stored accelerator was chosen against the software that
/// was installed *then*, and the default is at least a binding the user can be
/// told about.
fn register_quick_launcher_shortcut(app: &tauri::AppHandle, accelerator: &str) {
    let Err(error) = services::shortcuts::apply(app, accelerator) else {
        return;
    };
    crate::log_error!("could not register the quick launcher shortcut: {error}");

    let default = services::shortcuts::DEFAULT_QUICK_LAUNCHER_SHORTCUT;
    if accelerator == default {
        return;
    }

    if let Err(error) = services::shortcuts::apply(app, default) {
        crate::log_error!("could not register the default quick launcher shortcut either: {error}");
    }
}

/// The quick launcher's window events (section 28).
///
/// Two, and both reach the same decision — this window goes away rather than
/// closing — for two different reasons:
///
/// * **Closed.** Hidden, not destroyed, exactly as the popup is: the next
///   summon is one keystroke away and should be instant.
/// * **Blurred.** It has no title bar and therefore no close button, so
///   clicking away has to be a way out of it, or it would be a box the mouse
///   cannot dismiss.
///
/// Two things stop that second one from firing when it should not, and both
/// are cases where the blur is not the user leaving:
///
/// * `is_armed` — the window has not been focused yet, so this blur is
///   Windows declining to hand the foreground to a window summoned from the
///   background rather than anybody clicking away. Hiding on it would make
///   the overlay appear and vanish in the same frame.
/// * `is_held` — the frontend still has something on screen worth reading,
///   which in practice means a routine that failed to launch being reported
///   over the very applications whose opening stole the focus.
fn handle_launcher_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let should_hide = match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            true
        }
        tauri::WindowEvent::Focused(true) => {
            services::quick_launcher::arm();
            return;
        }
        tauri::WindowEvent::Focused(false) => {
            services::quick_launcher::is_armed() && !services::quick_launcher::is_held()
        }
        _ => return,
    };

    if should_hide {
        if let Err(error) = services::quick_launcher::hide(window.app_handle()) {
            crate::log_error!("could not hide the quick launcher: {error}");
        }
    }
}

/// The desktop widget's window events (development-plan.md sections 26, 83).
///
/// Three, and the last two are the reason this window needs a handler of its
/// own rather than a line in the block above:
///
/// * **Closed.** Hidden, not destroyed, exactly as its two siblings are — and
///   recorded as hidden, so the next run does not put back a widget the user
///   has just dismissed. The window has no title bar, so in practice this is
///   Alt+F4 rather than a close button; the button in the widget's own chrome
///   calls the command instead.
/// * **Moved / resized.** Section 83 asks for the widget to be movable and
///   resizable, which means both have to survive a restart — and the only
///   report of an OS drag is this, once a frame. `remember_geometry` throttles
///   the writing; see its module docs.
/// * **Blurred.** Not a dismissal here (unlike the quick launcher, a widget is
///   meant to stay on screen while you work on something else) but it is a
///   reliable end-of-drag: nothing moves a window the user has stopped
///   touching. So it flushes whatever the throttle was still holding.
fn handle_widget_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();

    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Err(error) = services::widget::hide(app) {
                crate::log_error!("could not hide the widget window: {error}");
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            services::widget::remember_geometry(app)
        }
        tauri::WindowEvent::Focused(false) => services::widget::flush_geometry(app),
        _ => {}
    }
}

/// Ends whichever focus session is still running, as interrupted, and says so.
///
/// Shared by the two moments a clock stops being watched — the window closing,
/// and the next launch finding what a crash left behind — so both record the
/// same thing in the same way. Neither can do anything useful about a failure,
/// so both only report it: at startup the row is left for the *next* launch to
/// catch, and on close there is nothing left to tell.
pub(crate) fn close_abandoned_focus_session(conn: &rusqlite::Connection, occasion: &str) {
    match services::focus::close_abandoned(conn) {
        Ok(Some(session)) => {
            crate::log_warn!("focus session {} {occasion}; recorded as interrupted", session.id)
        }
        Ok(None) => {}
        Err(error) => crate::log_error!("could not close the running focus session: {error}"),
    }
}
