/**
 * Re-reads level, XP, streak and achievements when something earns them.
 *
 * Mounted once per window that draws any of those, alongside
 * `useWindowSync` — which is the same job for the *other* windows' writes,
 * and the reason both are here rather than in the widgets. A dashboard has
 * three components reading `progressStore` (the Progress card, and on the
 * Progress page the level and the streak); subscribing in each of them would
 * mean three re-reads for one completed task, and the two that arrived second
 * would be answering a question already asked.
 *
 * See `src/lib/progress-events.ts` for why the stores announce rather than
 * calling this store directly, and section 94 for the arrow this closes.
 */

import { useEffect } from "react";

import { onProgressChanged } from "@/lib/progress-events";
import { useProgressStore } from "@/stores/progressStore";

export function useProgressSync(): void {
  useEffect(() => {
    return onProgressChanged(() => {
      const { loadProgress, loadAchievements, achievements } =
        useProgressStore.getState();

      void loadProgress();

      // The achievement grid is a page the user has to go to, and its read is
      // the more expensive of the two — so it is refreshed only once it has
      // something to refresh. A window that has never opened the Progress
      // page has an empty list and will read it on arrival anyway.
      if (achievements.length > 0) void loadAchievements();
    });
  }, []);
}
