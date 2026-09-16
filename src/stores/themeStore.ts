import { create } from "zustand";

import { withThemeTransition } from "./motionStore";

export type ThemePreference = "light" | "dark" | "system";

/**
 * An accent theme (development-plan.md sections 48, 84, 92 Tier 4) — the
 * colour of primary buttons, ticked checkboxes, progress bars and focus rings.
 * The palettes themselves are CSS: see the `data-accent` blocks in `index.css`.
 */
export type AccentPreference = "default" | "ocean" | "forest" | "iris" | "copper";

export interface AccentOption {
  id: AccentPreference;
  label: string;
  /**
   * The level that opens it, or null for always available.
   *
   * Section 48 allows cosmetics as rewards and forbids them from ever locking
   * anything that matters. So this is the *only* level gate in the app, and it
   * is only ever on an accent: Light, Dark, System and the default accent are
   * never behind one, and neither is any feature.
   */
  unlockLevel: number | null;
}

/** In the order Settings lists them: free first, then by the level that opens them. */
export const ACCENTS: readonly AccentOption[] = [
  { id: "default", label: "Graphite", unlockLevel: null },
  { id: "ocean", label: "Ocean", unlockLevel: null },
  { id: "forest", label: "Forest", unlockLevel: null },
  { id: "iris", label: "Iris", unlockLevel: 3 },
  { id: "copper", label: "Copper", unlockLevel: 5 },
];

/**
 * Whether `accent` can be picked at `level`.
 *
 * A null level means progress could not be read. Rewards stay locked then
 * rather than guessing, but only for *choosing*: an accent already in use is
 * never taken away, because nothing in this app takes back something earned.
 */
export function isAccentUnlocked(accent: AccentOption, level: number | null): boolean {
  return accent.unlockLevel === null || (level !== null && level >= accent.unlockLevel);
}

const STORAGE_KEY = "routine-launcher.theme";
const ACCENT_STORAGE_KEY = "routine-launcher.accent";

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve a preference to the concrete theme that should be on screen. */
function resolve(preference: ThemePreference): "light" | "dark" {
  return preference === "system" ? (systemPrefersDark() ? "dark" : "light") : preference;
}

/**
 * The `dark` class on <html> is what every Tailwind `dark:` utility keys off,
 * and the `data-accent` attribute beside it picks a palette. The default
 * accent is the attribute's absence, so the base tokens need no selector.
 */
function applyToDocument(preference: ThemePreference, accent: AccentPreference) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolve(preference) === "dark");
  if (accent === "default") root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", accent);
}

function readStoredPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
}

/** Anything unrecognised — a missing key, a renamed palette — is the default. */
function readStoredAccent(): AccentPreference {
  const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
  return ACCENTS.find((accent) => accent.id === stored)?.id ?? "default";
}

interface ThemeState {
  preference: ThemePreference;
  /** The theme actually rendered right now, with "system" already resolved. */
  resolved: "light" | "dark";
  accent: AccentPreference;
  setPreference: (preference: ThemePreference) => void;
  /**
   * Does not check the level. Settings only offers what is unlocked, and a
   * store that re-checked would need progress it has no business loading —
   * the popup, launcher and widget apply the accent without ever reading XP.
   */
  setAccent: (accent: AccentPreference) => void;
}

// TODO: once the settings table is wired up (development-plan.md section 52),
// read/write the preference and the accent there instead of localStorage so
// they travel with the user's database rather than the webview profile. Move
// both together: they are one decision about how the app looks.
export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: readStoredPreference(),
  resolved: resolve(readStoredPreference()),
  accent: readStoredAccent(),
  setPreference: (preference) => {
    localStorage.setItem(STORAGE_KEY, preference);
    // Crossfaded rather than switched: flipping every surface in the window
    // between near-white and near-black on one frame reads as a flash.
    // `withThemeTransition` is also where that is skipped when the user has
    // asked for reduced motion — see `motionStore`.
    withThemeTransition(() => applyToDocument(preference, get().accent));
    set({ preference, resolved: resolve(preference) });
  },
  setAccent: (accent) => {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    // The same crossfade, and skipped under reduced motion for the same reason.
    withThemeTransition(() => applyToDocument(get().preference, accent));
    set({ accent });
  },
}));

/**
 * Re-reads the stored preference and accent and applies them.
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
  const accent = readStoredAccent();
  applyToDocument(preference, accent);
  useThemeStore.setState({ preference, resolved: resolve(preference), accent });
}

/**
 * Applies the stored preference and accent and keeps "system" in sync with
 * the OS. Called once at startup, before React renders, to avoid a flash of
 * the wrong theme.
 */
export function initTheme() {
  const { preference, accent } = useThemeStore.getState();
  applyToDocument(preference, accent);

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const current = useThemeStore.getState();
    if (current.preference !== "system") return;
    // Windows switching to its night theme under a window the user is looking
    // at is the case that most wants the crossfade, not least.
    withThemeTransition(() => applyToDocument(current.preference, current.accent));
    useThemeStore.setState({ resolved: resolve(current.preference) });
  });
}
