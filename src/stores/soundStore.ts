/**
 * Whether the app makes any noise — section 84's "sound effects (optional)".
 *
 * **Off by default, and it stays off until the user goes and turns it on.**
 * That is the one rule this file exists to hold. A productivity tool that
 * started beeping the first time a task was ticked would be uninstalled by
 * lunchtime, and the app is also four windows — a tray popup, a launcher
 * summoned by a global shortcut, a desktop widget — any of which can be in
 * front of whatever else the user is doing.
 *
 * The third sibling of `themeStore` and `motionStore`, and built the same
 * way for the same reason: these are the settings every window has to agree
 * about, so they share a storage prefix, a default-when-unset path and a
 * `refresh` for the popup that is hidden rather than closed.
 *
 * Unlike those two there is no "system" option — the OS has no opinion about
 * whether an app should play a completion tone — so this is a plain boolean
 * and needs no class on `<html>`.
 */

import { create } from "zustand";

const STORAGE_KEY = "routine-launcher.sound";

/**
 * Only the exact string "on" enables sound.
 *
 * Deliberately not `stored !== "off"`: an absent key, a key from an older
 * build, a corrupted profile and a first launch must all come out silent.
 * Anything that is not an explicit yes is a no.
 */
function readStoredPreference(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "on";
}

interface SoundState {
  isEnabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useSoundStore = create<SoundState>((set) => ({
  isEnabled: readStoredPreference(),
  setEnabled: (enabled) => {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
    set({ isEnabled: enabled });
  },
}));

/**
 * The setting, readable from outside React.
 *
 * `lib/sounds.ts` is called from stores and event handlers as often as from
 * components, so the check has to work without a hook. Reading the store's
 * state directly rather than localStorage keeps it to a property lookup on a
 * path that can run on every keystroke in a list.
 */
export function isSoundEnabled(): boolean {
  return useSoundStore.getState().isEnabled;
}

/**
 * Re-reads the stored preference.
 *
 * The counterpart to `refreshTheme` and `refreshMotion`, for the same window:
 * section 25's popup is hidden rather than closed, so a setting changed in
 * the main window while it was away has to reach it when it comes back.
 */
export function refreshSound() {
  useSoundStore.setState({ isEnabled: readStoredPreference() });
}
