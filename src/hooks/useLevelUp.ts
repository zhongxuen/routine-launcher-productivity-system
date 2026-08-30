/**
 * Notices that the user has gone up a level, and says so as quietly as
 * possible.
 *
 * # Why this is three lines of animation and not a celebration
 *
 * Because sections 50 and 88 spend most of their words on exactly this. The
 * hierarchy in section 50 puts gamification second from the bottom, above
 * only cosmetics and below the whole productivity system — "gamification
 * should support the productivity system rather than dominate it" — and
 * section 88 is about not letting the XP become the point. A modal that
 * stopped the app to announce Level 5 would invert both: it would make the
 * number the event and the work the thing that interrupts it, and it would
 * land at the worst possible moment, because levelling up happens *precisely*
 * when the user has just completed something and is about to do the next
 * thing.
 *
 * So: the level number swells once, the sound plays if sound is on, and
 * nothing is dismissed, blocked or waited for. If the user is looking at the
 * bar they will see it; if they are not, nothing has been taken from them.
 * There is deliberately no confetti, no overlay, no "Level 5!" banner and no
 * toast — a toast would at least be non-blocking, but it would still be the
 * app talking about points while the user is working.
 *
 * # Firing once, from two places
 *
 * The level appears in two components — the dashboard's `ProgressWidget` and
 * the Progress page's `ProgressLevel` — and both re-read on mount. The
 * *animation* is per-component and should be: whichever one is on screen is
 * the one that should react. The *sound* is not, so the last level a cue was
 * played for is kept at module scope, and the second observer of the same
 * change stays silent.
 *
 * The first level seen is never a level-up. A component mounting on Level 4
 * has not just reached Level 4; it has just been rendered.
 */

import { useEffect, useRef, useState } from "react";

import { motionDuration } from "@/lib/motion";
import { playSound } from "@/lib/sounds";

/** How long `--animate-pop` runs. Matches `--duration-slow` in `index.css`. */
const POP_MS = 260;

/**
 * The highest level a cue has already been played for.
 *
 * Module scope rather than a store, for the same reason `taskStore` keeps its
 * reveal timer out there: nothing renders it, and it must not cause one.
 */
let soundedLevel: number | null = null;

/**
 * @param level The current level, or null while progress is still loading.
 * @returns True for the length of one pop animation after the level rises.
 *
 * ```tsx
 * const isLevellingUp = useLevelUp(progress?.level.level ?? null);
 *
 * <h2 className={cn(isLevellingUp && "animate-pop")}>Level {level}</h2>
 * ```
 */
export function useLevelUp(level: number | null): boolean {
  const previous = useRef<number | null>(null);
  const [isLevellingUp, setIsLevellingUp] = useState(false);

  useEffect(() => {
    if (level === null) return;

    const before = previous.current;
    previous.current = level;

    // First sighting, or a level that went *down* — which should not happen,
    // but a backend correction or a reset is not something to play a fanfare
    // for either way.
    if (before === null || level <= before) return;

    if (soundedLevel === null || level > soundedLevel) {
      soundedLevel = level;
      playSound("progress-up");
    }

    const hold = motionDuration(POP_MS);
    if (hold === 0) return;

    setIsLevellingUp(true);
    const timer = setTimeout(() => setIsLevellingUp(false), hold);
    return () => clearTimeout(timer);
  }, [level]);

  return isLevellingUp;
}
