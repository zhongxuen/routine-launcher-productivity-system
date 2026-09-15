/**
 * The system tray's side of the `invoke` boundary
 * (development-plan.md sections 27, 79).
 *
 * Unusually for this layer, most of the traffic goes the other way. The tray
 * menu is built in Rust from the database — today's count, the most-used
 * routines — and clicking an item arrives here as {@link onTrayAction} rather
 * than leaving as a command. See `src-tauri/src/services/tray.rs` for why:
 * everything a menu item does (the launch panel, the focus clock, the
 * quick-add dialog) already lives in a store, so the tray asks for it instead
 * of re-implementing it.
 *
 * What does go out is the one preference section 27 leaves to the user —
 * whether closing the main window puts the app in the tray or quits it.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Emitted by Rust when a tray menu item is chosen. */
const TRAY_ACTION_EVENT = "tray://action";

/**
 * What the user picked from the menu.
 *
 * An *intent*, not a result: "launch this routine", not "this routine was
 * launched". `useTrayActions` is what decides what each one involves, so the
 * tray and the button beside it in the app do the same thing.
 */
export type TrayAction =
  | { kind: "launch-routine"; routine_id: number }
  | { kind: "start-my-day" }
  | { kind: "start-focus" }
  | { kind: "add-task" }
  | { kind: "open-dashboard" }
  | { kind: "open-settings" };

/**
 * Subscribes to tray menu choices. Returns the unsubscribe function, so it
 * can be returned straight out of a `useEffect`.
 *
 * Only the main window is sent these — Rust addresses them by label — so
 * mounting this in the app shell cannot double up with the popup.
 */
export async function onTrayAction(
  handler: (action: TrayAction) => void,
): Promise<UnlistenFn> {
  return listen<TrayAction>(TRAY_ACTION_EVENT, (event) => handler(event.payload));
}

/**
 * Whether closing the main window minimises to the tray. True on a fresh
 * install: a tray that the app stopped being reachable from the moment its
 * window was closed would not be much of an access point.
 */
export async function getMinimizeToTray(): Promise<boolean> {
  return invoke<boolean>("get_minimize_to_tray");
}

/** Turns close-to-tray on or off, answering with what was stored. */
export async function setMinimizeToTray(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_minimize_to_tray", { enabled });
}

/**
 * Rebuilds the tray menu now.
 *
 * Rarely needed: the tray already refreshes from the cross-window
 * `app://data-changed` broadcast and whenever the pointer reaches the icon.
 * This is for a window that wants the menu to catch up with something those
 * two would not hear about.
 */
export async function refreshTrayMenu(): Promise<void> {
  return invoke<void>("refresh_tray_menu");
}
