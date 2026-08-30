/**
 * Whether the app animates — the motion half of section 84's polish pass.
 *
 * Deliberately built as a twin of `themeStore`: same three-way preference
 * with a "system" default, same localStorage key prefix, same
 * class-on-`<html>` mechanism, same `init`/`refresh` pair for the secondary
 * windows. Motion and theme are the two settings every window in the app has
 * to agree about, and they are far easier to keep in step when they work the
 * same way.
 *
 * The default is "system", not "full". Reduced motion is an accessibility
 * preference the user has already expressed to their OS, and an app that
 * ignored it until it was told a second time would be getting that backwards.
 */

import { create } from "zustand";

import { assertMotionDurationsMatch } from "@/lib/motion";

export type MotionPreference = "full" | "reduced" | "system";

const STORAGE_KEY = "routine-launcher.motion";

/** How long the theme crossfade class stays on. Matches `--duration-slow`. */
const THEME_CROSSFADE_MS = 260;

function systemPrefersReduced() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Resolve a preference to what should actually be happening on screen. */
function resolve(preference: MotionPreference): boolean {
  return preference === "system" ? systemPrefersReduced() : preference === "reduced";
}

/** The `reduce-motion` class on <html> is what `index.css` keys everything off. */
function applyToDocument(preference: MotionPreference) {
  document.documentElement.classList.toggle("reduce-motion", resolve(preference));
}

function readStoredPreference(): MotionPreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "full" || stored === "reduced" || stored === "system" ? stored : "system";
}

interface MotionState {
  preference: MotionPreference;
  /** What is actually in effect right now, with "system" already resolved. */
  isReduced: boolean;
  setPreference: (preference: MotionPreference) => void;
}

export const useMotionStore = create<MotionState>((set) => ({
  preference: readStoredPreference(),
  isReduced: resolve(readStoredPreference()),
  setPreference: (preference) => {
    localStorage.setItem(STORAGE_KEY, preference);
    applyToDocument(preference);
    set({ preference, isReduced: resolve(preference) });
  },
}));

/**
 * Re-reads the stored preference and applies it.
 *
 * The counterpart to `themeStore`'s `refreshTheme`, and there for the same
 * window: the compact popup of section 25 is only hidden when dismissed, so a
 * preference changed in Settings meanwhile would otherwise not reach it until
 * the app restarted.
 */
export function refreshMotion() {
  const preference = readStoredPreference();
  applyToDocument(preference);
  useMotionStore.setState({ preference, isReduced: resolve(preference) });
}

/**
 * Applies the stored preference and keeps "system" in sync with the OS.
 *
 * Called once at startup alongside `initTheme`, before React renders, so the
 * first frame is already animating — or already not.
 */
export function initMotion() {
  const { preference } = useMotionStore.getState();
  applyToDocument(preference);
  assertMotionDurationsMatch();

  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => {
    const current = useMotionStore.getState().preference;
    if (current !== "system") return;
    applyToDocument(current);
    useMotionStore.setState({ isReduced: resolve(current) });
  });
}

/**
 * Crossfades the window's colours for the length of one theme change.
 *
 * The transition rule in `index.css` is scoped to a class rather than left on
 * permanently, because it matches every element in the document: leaving it
 * there would put a 260ms colour transition on hovering a task row, which
 * would make the app feel slower than it is. So it goes on immediately
 * before the theme flips and comes off once the crossfade has run.
 *
 * Lives here rather than in `themeStore` because whether it happens at all is
 * a motion question — with reduced motion on, the theme should simply be the
 * new one on the next frame.
 */
export function withThemeTransition(change: () => void) {
  const root = document.documentElement;

  if (useMotionStore.getState().isReduced) {
    change();
    return;
  }

  root.classList.add("theme-transition");
  change();

  window.setTimeout(() => {
    root.classList.remove("theme-transition");
  }, THEME_CROSSFADE_MS);
}
