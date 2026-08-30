/**
 * Progress store — level, XP, streak and achievements.
 *
 * Everything here comes from `src/services/xpService.ts`, the same way the
 * task store goes through `taskService` and the focus store through
 * `focusService`. Nothing in this file holds an opinion about progression
 * that the backend does not also hold: the level curve, the streak rule of
 * section 46 and the six achievement unlocks of section 47 are all decided
 * behind that service, and this store's whole job is to ask, to keep the
 * answer, and to say so when the asking fails.
 *
 * (The service is mock-backed until Stage 9's prompt 9.1 builds the Rust
 * side. That is stated once, at the top of the service, and is invisible from
 * here on purpose — see the banner in `xpService.ts`. This store is not a
 * placeholder, and there is nothing left in it to swap.)
 *
 * Two reads rather than one, each with its own loading and error state, in
 * the shape `focusStore` uses for its history: the dashboard's Progress
 * widget mounts on every visit and wants the numbers, while the six
 * achievement tiles are a page the user has to go to. Folding them into one
 * call would make the dashboard pay for a grid it is not drawing.
 */

import { create } from "zustand";

import { listAchievements, getProgress } from "@/services/xpService";
import type { Achievement, Progress } from "@/types/progress";

interface ProgressState {
  /** Level, XP and streak. Null until the first load resolves. */
  progress: Progress | null;
  /** True only while progress is being read for the first time. */
  isLoading: boolean;
  /** A failed read, already in user-presentable form. */
  error: string | null;

  /** Section 47's six, locked ones included. Empty until the first load. */
  achievements: Achievement[];
  isAchievementsLoading: boolean;
  achievementsError: string | null;

  /**
   * Reads level, XP and streak.
   *
   * Idempotent and cheap to call from an effect: the widget mounts on every
   * visit to the dashboard, and re-reading is how it picks up XP earned since
   * the last one.
   */
  loadProgress: () => Promise<void>;

  /** Reads the achievement grid. Same contract as {@link loadProgress}. */
  loadAchievements: () => Promise<void>;
}

export const useProgressStore = create<ProgressState>((set, get) => ({
  progress: null,
  // `true`, not `false`: nothing has been read yet, and "no numbers" before
  // the first read is a wait rather than a result. Every component that reads
  // this store calls its loader on mount, so the flag is honest from the
  // first frame — and without it the widgets flash their *error* state for
  // one render, because "no data and not loading" is otherwise
  // indistinguishable from "the read came back empty-handed".
  isLoading: true,
  error: null,

  achievements: [],
  isAchievementsLoading: true,
  achievementsError: null,

  async loadProgress() {
    // Only the *first* read is a loading state; later ones leave the numbers
    // that are already on screen alone rather than blanking them to skeletons.
    set({ isLoading: get().progress === null, error: null });

    try {
      set({ progress: await getProgress(), isLoading: false, error: null });
    } catch (cause) {
      // The previous numbers are kept. Stale XP is still worth looking at,
      // and the widget states the staleness under them rather than instead
      // of them.
      set({ isLoading: false, error: String(cause) });
    }
  },

  async loadAchievements() {
    set({
      isAchievementsLoading: get().achievements.length === 0,
      achievementsError: null,
    });

    try {
      set({
        achievements: await listAchievements(),
        isAchievementsLoading: false,
        achievementsError: null,
      });
    } catch (cause) {
      set({ isAchievementsLoading: false, achievementsError: String(cause) });
    }
  },
}));
