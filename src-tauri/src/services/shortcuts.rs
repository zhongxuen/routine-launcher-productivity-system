//! The configurable global shortcut (development-plan.md sections 28 and 79).
//!
//! Section 28 asks for "a configurable shortcut" and gives `Ctrl + Alt +
//! Space` as the example, so the default is exactly that and the stored value
//! is what actually gets registered. There is only one global shortcut in the
//! app — the one that summons the quick launcher — which is why this module
//! talks about *the* shortcut rather than keeping a table of them, and why
//! rebinding can simply clear the register and start again.
//!
//! Three jobs, in the order a rebinding does them:
//!
//! 1. [`parse`] — is this accelerator something the OS can be asked for, and
//!    something it *should* be asked for? A global hotkey is taken away from
//!    every other application on the machine, so a bare key is refused here
//!    rather than left to become a `Space` bar that stops working everywhere.
//! 2. [`apply`] — take it, and drop whatever was held before.
//! 3. [`save`] — remember it, so the next launch registers the same thing.
//!
//! They are separate because the interesting failure happens between 2 and 3:
//! the accelerator parses but the OS refuses it, because another program got
//! there first. Nothing is written in that case, and the caller
//! (`commands/quick_launcher.rs`) puts the previous binding back.

use std::str::FromStr;

use rusqlite::Connection;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use super::error::ServiceResult;
use super::{quick_launcher, settings};

/// Where the binding lives in the `settings` table.
pub const QUICK_LAUNCHER_SHORTCUT_KEY: &str = "shortcuts.quick_launcher";

/// Section 28's example, and what the app ships bound to.
///
/// Written in the canonical form this module and the frontend both use:
/// modifiers in `Ctrl`, `Alt`, `Shift`, `Super` order, then a W3C key code.
pub const DEFAULT_QUICK_LAUNCHER_SHORTCUT: &str = "Ctrl+Alt+Space";

/// The modifiers that make a shortcut safe to take globally.
///
/// Shift is not among them. `Shift+A` is a capital A everywhere on the
/// machine, and a global hotkey on it would take capital As away from every
/// other program — the plugin would accept it, so this is the check that
/// stops it.
const REQUIRED_MODIFIERS: Modifiers = Modifiers::CONTROL.union(Modifiers::ALT).union(Modifiers::SUPER);

/// Checks an accelerator and returns the shortcut it names.
///
/// The error is written for the Settings card to show verbatim, because there
/// is nothing a caller could do with a structured one: the user pressed keys
/// and either they can be bound or they cannot.
pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    let trimmed = accelerator.trim();
    if trimmed.is_empty() {
        return Err("No shortcut was given.".into());
    }

    let shortcut = Shortcut::from_str(trimmed)
        .map_err(|_| format!("{trimmed} is not a shortcut this app can register."))?;

    if !shortcut.mods.intersects(REQUIRED_MODIFIERS) {
        return Err(
            "A global shortcut needs Ctrl, Alt or Win — without one it would take that key away \
             from every other program."
                .into(),
        );
    }

    Ok(shortcut)
}

/// The accelerator to register: what was stored, or the default.
///
/// A stored value that no longer parses falls back to the default rather than
/// failing. The alternative is an app that launches with no shortcut at all
/// because of one bad row, and the user's way of fixing it — Settings — is
/// behind a window they can no longer summon.
pub fn stored(conn: &Connection) -> ServiceResult<String> {
    let saved = settings::get(conn, QUICK_LAUNCHER_SHORTCUT_KEY)?;

    Ok(saved
        .filter(|accelerator| parse(accelerator).is_ok())
        .unwrap_or_else(|| DEFAULT_QUICK_LAUNCHER_SHORTCUT.to_string()))
}

/// Remembers `accelerator` as the binding. Validated by the caller first —
/// nothing should be stored that the app would refuse to read back.
pub fn save(conn: &Connection, accelerator: &str) -> ServiceResult<()> {
    settings::set(conn, QUICK_LAUNCHER_SHORTCUT_KEY, accelerator.trim())
}

/// Registers `accelerator` as *the* global shortcut, releasing any previous
/// one.
///
/// `unregister_all` rather than unregistering a remembered accelerator: this
/// is the app's only global shortcut, so "everything we hold" and "the one we
/// hold" are the same set, and clearing by description cannot drift out of
/// step with what is actually registered.
///
/// The handler fires on press and release; only the press is a summon, or the
/// launcher would open on the way down and close again on the way up.
pub fn apply(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut = parse(accelerator)?;
    let manager = app.global_shortcut();

    // A failure here means we were not holding it in the first place, which
    // is the state the next line wants anyway.
    let _ = manager.unregister_all();

    manager
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }

            if let Err(error) = quick_launcher::toggle(app) {
                crate::log_error!("could not toggle the quick launcher: {error}");
            }
        })
        .map_err(|error| {
            format!("{} could not be registered — another program may already be using it. ({error})", accelerator.trim())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    #[test]
    fn the_default_is_the_shortcut_section_28_names() {
        let shortcut = parse(DEFAULT_QUICK_LAUNCHER_SHORTCUT).unwrap();
        assert!(shortcut.mods.contains(Modifiers::CONTROL));
        assert!(shortcut.mods.contains(Modifiers::ALT));
        assert_eq!(shortcut.key, tauri_plugin_global_shortcut::Code::Space);
    }

    #[test]
    fn accepts_the_shapes_the_settings_recorder_produces() {
        for accelerator in [
            "Ctrl+Alt+Space",
            "Ctrl+Shift+KeyP",
            "Alt+F1",
            "Super+Digit1",
            "Ctrl+Alt+Shift+ArrowUp",
        ] {
            assert!(parse(accelerator).is_ok(), "{accelerator} should be bindable");
        }
    }

    #[test]
    fn refuses_shortcuts_that_would_swallow_an_ordinary_keystroke() {
        // Nothing at all, a bare key, and a Shift-only combination: each
        // would take a key the user types with away from the whole machine.
        for accelerator in ["", "   ", "Space", "KeyP", "Shift+KeyP"] {
            assert!(parse(accelerator).is_err(), "{accelerator:?} should be refused");
        }
    }

    #[test]
    fn refuses_nonsense() {
        for accelerator in ["Ctrl+Alt+Banana", "Ctrl+", "+"] {
            assert!(parse(accelerator).is_err(), "{accelerator:?} should be refused");
        }
    }

    #[test]
    fn falls_back_to_the_default_until_something_valid_is_stored() {
        let conn = init_memory_db().unwrap();

        assert_eq!(stored(&conn).unwrap(), DEFAULT_QUICK_LAUNCHER_SHORTCUT);

        save(&conn, "Ctrl+Shift+KeyK").unwrap();
        assert_eq!(stored(&conn).unwrap(), "Ctrl+Shift+KeyK");

        // A row that a future build — or a hand edit — left unreadable is not
        // allowed to leave the app with no way to open the launcher.
        settings::set(&conn, QUICK_LAUNCHER_SHORTCUT_KEY, "Ctrl+Alt+Banana").unwrap();
        assert_eq!(stored(&conn).unwrap(), DEFAULT_QUICK_LAUNCHER_SHORTCUT);
    }
}
