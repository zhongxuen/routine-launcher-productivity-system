/**
 * Analytics store — the daily and weekly productivity figures of
 * development-plan.md sections 36 and 82.
 *
 * Written the way `progressStore.ts` is: one read, one loading flag, one
 * user-presentable error, and no opinion the backend does not also hold. The
 * whole of the Statistics tab arrives in a single call (see
 * `analyticsService.getProductivityStats`), so unlike its neighbour there is
 * only one thing to load.
 *
 * Kept apart from `progressStore` even though both feed the Progress section,
 * because they answer different questions. Progression is a running total —
 * level, lifetime XP, the streak — and the dashboard widget mounts on every
 * visit to read it. Analytics is a *window*: it is measured against a
 * particular local day, and everything in it changes at midnight whether the
 * user did anything or not. Folding the two together would make the dashboard
 * pay for four weeks of history it does not draw.
 *
 * Section 33's per-routine statistics are not here either — they belong to a
 * routine and are read by `routineStore` alongside the routines themselves.
 */

import { create } from "zustand";

import { getProductivityStats } from "@/services/analyticsService";
import type { ProductivityStats } from "@/types/analytics";

interface AnalyticsState {
  /** Today, this week, the week's days and four weeks of history. */
  stats: ProductivityStats | null;
  /** True only while the figures are being read for the first time. */
  isLoading: boolean;
  /** A failed read, already in user-presentable form. */
  error: string | null;

  /**
   * Reads the whole Statistics tab.
   *
   * Idempotent and cheap to call from an effect: nothing is cached behind the
   * command, so re-reading is how the panels pick up a task finished or a
   * session ended since the last look.
   */
  loadStats: () => Promise<void>;
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  stats: null,
  // `true`, not `false`: nothing has been read yet, and "no numbers" before
  // the first read is a wait rather than a result. Every component that reads
  // this store calls its loader on mount, so the flag is honest from the
  // first frame — and without it the widgets flash their *error* state for
  // one render, because "no data and not loading" is otherwise
  // indistinguishable from "the read came back empty-handed".
  isLoading: true,
  error: null,

  async loadStats() {
    // Only the *first* read is a loading state. A refresh leaves the figures
    // that are already on screen alone rather than blanking the panels to
    // skeletons — the numbers are still the numbers while the next answer is
    // on its way.
    set({ isLoading: get().stats === null, error: null });

    try {
      set({ stats: await getProductivityStats(), isLoading: false, error: null });
    } catch (cause) {
      // The previous figures are kept, and the tab says so underneath them.
      // Stale statistics are still worth looking at; a blank page is not.
      set({ isLoading: false, error: String(cause) });
    }
  },
}));
