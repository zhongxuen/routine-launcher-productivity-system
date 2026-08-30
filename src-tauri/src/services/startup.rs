//! Launching at Windows startup, and what the app does when it is
//! (development-plan.md section 85).
//!
//! Two halves of one setting, which is why they are one module.
//!
//! ## The registry entry
//!
//! `tauri-plugin-autostart` writes the app's path into
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, so turning the
//! setting on and off is [`enable`] / [`disable`] and reading it back is
//! [`is_enabled`]. Deliberately, nothing here is mirrored into the `settings`
//! table: the registry *is* the state, and a copy of it in SQLite would be
//! the thing that goes stale the moment the user removes the entry from Task
//! Manager's Startup tab — which is exactly where a user who did not know
//! what this app was would go to turn it off. Reading the real thing means
//! the switch in Settings is always telling the truth.
//!
//! The plugin's commands are not exposed to the frontend (the `autostart`
//! permission is not in any capability). Section 86's rule is that native OS
//! operations go through this app's own commands, and a registry write is as
//! native as it gets — so it goes React -> `appService` ->
//! `commands/app_info.rs` -> here.
//!
//! ## What a startup launch looks like
//!
//! An app that launched at boot and threw its window across the screen would
//! be an app the user turns off again the same morning. So the entry is
//! written with [`STARTUP_ARG`] on the command line, and [`launched_at_startup`]
//! reads it back on the way up: a normal launch shows the main window, a
//! startup launch leaves it hidden and the app appears only as section 27's
//! tray icon.
//!
//! That is also why `tauri.conf.json` gives the main window `"visible": false`
//! and [`present_main_window`] is what shows it. Starting visible and hiding
//! in `setup` would work, but only after a window had already been on screen
//! for a frame — the flash is the whole thing being avoided.
//!
//! The one case that overrides it is a tray that failed to build: hidden with
//! no tray icon is an app with no way in, so [`present_main_window`] is told
//! whether the tray came up and shows the window regardless if it did not.

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use super::popup::MAIN_LABEL;

/// The flag the startup entry passes, and the only way the app can tell a
/// boot launch from the user opening it.
///
/// Written into the registry value by the plugin builder in `lib.rs`; read
/// back by [`launched_at_startup`]. The two have to agree, so neither spells
/// it out itself.
///
/// It has to be one bare token. `auto_launch` writes the `Run` value as
/// `{exe path} {args}` with **nothing quoted**, and Windows only untangles
/// that by trying each successive prefix of the string until one names a file
/// that exists — which works for a path with spaces in it, and would stop
/// working the moment an argument had one too.
pub const STARTUP_ARG: &str = "--autostart";

/// Whether the app is registered to launch at Windows startup.
///
/// Read from the registry every time rather than cached — see the module
/// docs for why.
pub fn is_enabled(app: &AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("could not read the startup setting: {error}"))
}

/// Registers or removes the startup entry, and answers with what is actually
/// registered afterwards.
///
/// The answer is re-read rather than echoed back: on the one hand it is the
/// honest report, and on the other a write that silently did nothing —
/// a locked-down machine, a policy-managed `Run` key — would otherwise be
/// reported to the user as a setting that had changed.
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();

    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };

    result.map_err(|error| {
        let verb = if enabled { "add" } else { "remove" };
        format!("could not {verb} the Windows startup entry: {error}")
    })?;

    is_enabled(app)
}

/// Whether this run was started by the Windows startup entry.
///
/// Reads the process arguments rather than anything persisted, because the
/// question is about *this launch* and not about the setting: the entry can
/// be enabled while the user opens the app by hand, and the two want
/// different windows.
///
/// `args_os` rather than `args`: the latter panics on an argument that is not
/// valid Unicode, and an app that refused to start because of something a
/// shortcut had appended to its command line would be a bad trade for a
/// comparison against one ASCII flag.
pub fn launched_at_startup() -> bool {
    std::env::args_os().skip(1).any(|arg| arg == STARTUP_ARG)
}

/// Shows the main window, unless this run is a startup launch that can safely
/// stay in the tray.
///
/// `tray_ready` is the safety catch: it is the difference between "hidden
/// behind an icon" and "running with nothing on screen and no way to reach
/// it". A tray that failed to build is rare, logged and non-fatal everywhere
/// else in `setup`; here it is the one thing that overrules the user's
/// preference for a quiet boot.
///
/// A window that will not show is reported and otherwise left alone. There is
/// nothing further to try — and no user to tell, since the failure is that
/// there is nothing for them to look at.
pub fn present_main_window(app: &AppHandle, tray_ready: bool) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        crate::log_error!("[startup] the main window is missing; nothing to show");
        return;
    };

    if tray_ready && launched_at_startup() {
        return;
    }

    if let Err(error) = window.show() {
        crate::log_error!("[startup] could not show the main window: {error}");
        return;
    }

    // Windows will not always hand the foreground to a process that has just
    // started, and there is nothing useful to do about a refusal — the window
    // is on screen either way, which is the part that matters.
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_startup_flag_is_a_flag_and_not_a_path() {
        // `auto_launch` appends this to the executable path unquoted, and
        // Windows resolves the result by trying prefixes until one names a
        // real file. A space anywhere in the argument would break that search
        // — see the note on `STARTUP_ARG`.
        assert!(STARTUP_ARG.starts_with("--"));
        assert!(!STARTUP_ARG.contains(char::is_whitespace));
    }
}
