/**
 * Progress store — level, XP and streak for the dashboard's Progress widget.
 *
 * ---------------------------------------------------------------------------
 * THIS STORE IS A PLACEHOLDER. Its values are made up.
 *
 * The progression backend is Stage 9 (development-plan.md sections 43-47);
 * Stage 6 deliberately does not wait for it, because the dashboard's other
 * three widgets are real and the plan puts gamification last on purpose
 * (section 50: "Gamification should be visually secondary").
 *
 * What is *not* a placeholder is the shape. `ProgressWidget` reads this store
 * and takes no data props, so Stage 9's prompt 9.1 replaces the body of
 * `loadProgress` with an `xpService` call — the level command it specifies
 * already answers in {@link LevelProgress}'s three fields, and the `streaks`
 * row already carries {@link StreakProgress}'s three — and the widget is not
 * touched at all. That is the single integration point Stage 6 leaves open.
 *
 * Which means: when this store becomes real, delete MOCK_PROGRESS and the
 * comment above it, and nothing else here should need to move.
 * ---------------------------------------------------------------------------
 */

import { create } from "zustand";

import { todayKey } from "@/lib/task-utils";
import type { Progress } from "@/types/progress";

/**
 * The numbers from the section 7 and section 45 mockups — level 4, 620 of
 * 800 XP, a five-day streak — so the widget on screen is the widget in the
 * plan rather than a different one that happens to render.
 *
 * `totalXp` is the only value the mockups do not give; 2020 is 620 on top of
 * an invented 1400 for the first three levels. It is consistent with the
 * rest, and no more real than the rest.
 *
 * The streak's last active day is computed rather than written down: a fixed
 * date would quietly become "five days ending some time last year" the longer
 * this placeholder lives, and a mock that ages badly is worse than a mock.
 */
const MOCK_PROGRESS: Progress = {
  level: { level: 4, xpIntoLevel: 620, xpForNextLevel: 800 },
  streak: { currentStreak: 5, longestStreak: 11, lastActiveDate: todayKey() },
  totalXp: 2020,
};

interface ProgressState {
  /** Level, XP and streak. Null until the first load resolves. */
  progress: Progress | null;
  /** True only while progress is being read for the first time. */
  isLoading: boolean;
  /**
   * A failed read. Always null today — there is nothing here that can fail
   * yet — but the widget already renders it, so the Stage 9 swap does not
   * have to add an error path to a component at the same time as data.
   */
  error: string | null;

  /**
   * Reads level, XP and streak.
   *
   * Idempotent and cheap to call from an effect: the widget mounts on every
   * visit to the dashboard, and re-reading is how it picks up XP earned since
   * the last one.
   */
  loadProgress: () => Promise<void>;
}

export const useProgressStore = create<ProgressState>((set, get) => ({
  progress: null,
  isLoading: false,
  error: null,

  async loadProgress() {
    // Only the *first* read is a loading state; later ones leave the numbers
    // that are already on screen alone rather than blanking them to skeletons.
    set({ isLoading: get().progress === null, error: null });

    // Stage 9: replace with the xpService calls. Kept async even though there
    // is nothing to await, so that swap changes this function's body and not
    // its signature — or any of its callers.
    set({ progress: MOCK_PROGRESS, isLoading: false, error: null });
  },
}));
