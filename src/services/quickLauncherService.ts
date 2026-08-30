/**
 * Typed wrappers around the quick launcher's Tauri commands
 * (development-plan.md section 28).
 *
 * The "Service" layer of React UI -> Service -> Tauri Command -> Rust
 * (section 86): components import from here and never call `invoke`
 * themselves. Every command rejects with a plain, user-presentable string.
 *
 * Two unrelated things live here because section 28 is one feature: the
 * overlay window, and the global accelerator that is the only thing which
 * normally opens it. The window half is Rust's for the same reason the
 * popup's is — showing, hiding and sizing an always-on-top window are OS
 * operations. The shortcut half is Rust's because the binding has to be held
 * whether or not any window is open, which is the entire point of it.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Emitted to the launcher when a window that was only hidden is shown again. */
const LAUNCHER_SHOWN_EVENT = "launcher://shown";

/* -------------------------------------------------------------------------- */
/* The window                                                                 */
/* -------------------------------------------------------------------------- */

/** Shows the launcher, building it the first time. Takes focus. */
export async function openQuickLauncher(): Promise<void> {
  return invoke<void>("open_quick_launcher");
}

/**
 * Puts the launcher away. This is what Escape calls — the window has no title
 * bar to close it with.
 */
export async function dismissQuickLauncher(): Promise<void> {
  return invoke<void>("dismiss_quick_launcher");
}

/** Flips the launcher between shown and hidden, answering with whether it is now visible. */
export async function toggleQuickLauncher(): Promise<boolean> {
  return invoke<boolean>("toggle_quick_launcher");
}

/**
 * Sizes the window to its contents, in logical pixels.
 *
 * Rust clamps the value, so a mis-measured frame stops at the ceiling rather
 * than turning the overlay into a full-screen panel.
 */
export async function setQuickLauncherHeight(height: number): Promise<void> {
  return invoke<void>("set_quick_launcher_height", { height });
}

/**
 * Keeps the launcher on screen through a lost focus.
 *
 * Held across a routine launch: the applications it opens take the
 * foreground, and that blur would otherwise sweep away the very line
 * reporting on whether they opened.
 */
export async function holdQuickLauncher(held: boolean): Promise<void> {
  return invoke<void>("hold_quick_launcher", { held });
}

/**
 * Subscribes to the launcher being shown again after being hidden.
 *
 * A hidden window's webview is never torn down, so without this the next
 * summon would land on the last search's query, selection and results.
 * Returns the unsubscribe function.
 */
export async function onQuickLauncherShown(handler: () => void): Promise<UnlistenFn> {
  return listen<void>(LAUNCHER_SHOWN_EVENT, () => handler());
}

/* -------------------------------------------------------------------------- */
/* The shortcut                                                               */
/* -------------------------------------------------------------------------- */

/** The accelerator currently bound, in the canonical `Ctrl+Alt+Space` form. */
export async function getQuickLauncherShortcut(): Promise<string> {
  return invoke<string>("get_quick_launcher_shortcut");
}

/**
 * Rebinds the shortcut, answering with what is now bound.
 *
 * Rejects with a sentence worth showing when the accelerator is refused —
 * either because it is not one a global hotkey may be (see `parse` in
 * `services/shortcuts.rs`) or because another program already holds it. The
 * previous binding is still in force in both cases; nothing is lost by
 * trying.
 */
export async function setQuickLauncherShortcut(accelerator: string): Promise<string> {
  return invoke<string>("set_quick_launcher_shortcut", { accelerator });
}

/** Puts section 28's `Ctrl + Alt + Space` back. */
export async function resetQuickLauncherShortcut(): Promise<string> {
  return invoke<string>("reset_quick_launcher_shortcut");
}
