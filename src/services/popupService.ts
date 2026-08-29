/**
 * Typed wrappers around the popup-window Tauri commands
 * (development-plan.md section 25).
 *
 * The "Service" layer of React UI -> Service -> Tauri Command -> Rust
 * (section 86): components import from here and never call `invoke`
 * themselves. Every command rejects with a plain, user-presentable string.
 *
 * The popup is a real second OS window, so opening and closing it are Rust
 * operations rather than JS ones — see `src-tauri/src/services/popup.rs` for
 * why, and for the rule that closing it hides rather than destroys it.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Emitted to the popup when a window that was only hidden is shown again. */
const POPUP_SHOWN_EVENT = "popup://shown";

/** Shows the popup, building it the first time. Takes focus. */
export async function openPopupWindow(): Promise<void> {
  return invoke<void>("open_popup_window");
}

/**
 * Puts the popup away. The webview survives, so the next open is instant and
 * lands on whatever was on screen.
 */
export async function dismissPopupWindow(): Promise<void> {
  return invoke<void>("dismiss_popup_window");
}

/**
 * Flips the popup between shown and hidden, answering with whether it is now
 * visible. Stage 8's global shortcut binds to this.
 */
export async function togglePopupWindow(): Promise<boolean> {
  return invoke<boolean>("toggle_popup_window");
}

/** Whether the popup is on screen right now. */
export async function isPopupWindowOpen(): Promise<boolean> {
  return invoke<boolean>("is_popup_window_open");
}

/**
 * Brings the full app forward — the popup's one link back to the dashboard.
 * Everything in the popup works without it; this is for when the user wants
 * the rest.
 */
export async function focusMainWindow(): Promise<void> {
  return invoke<void>("focus_main_window");
}

/**
 * Subscribes to the popup being shown again after being hidden.
 *
 * A hidden window's webview is never torn down, so nothing else would make it
 * re-read a database that has moved on — possibly by a whole day — since it
 * was last looked at. Returns the unsubscribe function.
 */
export async function onPopupShown(handler: () => void): Promise<UnlistenFn> {
  return listen<void>(POPUP_SHOWN_EVENT, () => handler());
}
