import { create } from "zustand";

import { withThemeTransition } from "./motionStore";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "routine-launcher.theme";

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve a preference to the concrete theme that should be on screen. */
function resolve(preference: ThemePreference): "light" | "dark" {
  return preference === "system" ? (systemPrefersDark() ? "dark" : "light") : preference;
}

/** The `dark` class on <html> is what every Tailwind `dark:` utility keys off. */
function applyToDocument(preference: ThemePreference) {
  document.documentElement.classList.toggle("dark", resolve(preference) === "dark");
}

function readStoredPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
}

interface ThemeState {
  preference: ThemePreference;
  /** The theme actually rendered right now, with "system" already resolved. */
  resolved: "light" | "dark";
  setPreference: (preference: ThemePreference) => void;
}

// TODO: once the settings table is wired up (development-plan.md section 52),
// read/write the preference there instead of localStorage so it travels with
// the user's database rather than the webview profile.
export const useThemeStore = create<ThemeState>((set) => ({
  preference: readStoredPreference(),
  resolved: resolve(readStoredPreference()),
  setPreference: (preference) => {
    localStorage.setItem(STORAGE_KEY, preference);
    // Crossfaded rather than switched: flipping every surface in the window
    // between near-white and near-black on one frame reads as a flash.
    // `withThemeTransition` is also where that is skipped when the user has
    // asked for reduced motion — see `motionStore`.
    withThemeTransition(() => applyToDocument(preference));
    set({ preference, resolved: resolve(preference) });
  },
}));

/**
 * Re-reads the stored preference and applies it.
 *
 * For a window that was on screen while the setting changed somewhere else.
 * The compact popup (development-plan.md section 25) is the case: it is a
 * second webview sharing this origin's localStorage, but it is only *hidden*
 * when dismissed, so a theme switched in Settings meanwhile would otherwise
 * still be the old one when it comes back. Called from the popup when it is
 * shown again.
 */
export function refreshTheme() {
  const preference = readStoredPreference();
  applyToDocument(preference);
  useThemeStore.setState({ preference, resolved: resolve(preference) });
}

/**
 * Applies the stored preference and keeps "system" in sync with the OS.
 * Called once at startup, before React renders, to avoid a flash of the
 * wrong theme.
 */
export function initTheme() {
  const { preference } = useThemeStore.getState();
  applyToDocument(preference);

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const current = useThemeStore.getState().preference;
    if (current !== "system") return;
    // Windows switching to its night theme under a window the user is looking
    // at is the case that most wants the crossfade, not least.
    withThemeTransition(() => applyToDocument(current));
    useThemeStore.setState({ resolved: resolve(current) });
  });
}
