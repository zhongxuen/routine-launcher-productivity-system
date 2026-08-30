import { useEffect } from "react";

import ErrorState from "@/components/common/states/ErrorState";
import StaleNotice from "@/components/common/states/StaleNotice";
import { Card } from "@/components/ui/card";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useLevelUp } from "@/hooks/useLevelUp";
import { cn } from "@/lib/utils";
import { useProgressStore } from "@/stores/progressStore";
import { xpFraction } from "@/types/progress";

/**
 * The Progress section's headline — development-plan.md section 45.
 *
 * ```text
 * Level 4
 *
 * 620 / 800 XP
 *
 * ████████████░░░
 * ```
 *
 * It sits above the sub-nav rather than inside one of the three tabs,
 * because the level is what the whole section is about: Statistics,
 * Achievements and Streak are three views of the same progression, and a
 * level that appeared and disappeared as the user moved between them would
 * read as three unrelated pages.
 *
 * The lifetime total beside it is the sum of `xp_transactions` (section 63)
 * — the only number here that keeps going up. It is deliberately quiet: this
 * is a record of consistency, not a score, and section 45 asks for XP to be
 * "primarily a visual representation of consistency".
 *
 * Reads `progressStore` and takes no data props, the same as the dashboard's
 * widget, so the two can never disagree about what level the user is.
 */
function ProgressLevel({ className }: { className?: string }) {
  const progress = useProgressStore((state) => state.progress);
  const isLoading = useProgressStore((state) => state.isLoading);
  const error = useProgressStore((state) => state.error);
  const loadProgress = useProgressStore((state) => state.loadProgress);

  // Called before the early return below, as every hook must be.
  const isLevellingUp = useLevelUp(progress?.level.level ?? null);

  // Re-read on mount: XP is earned everywhere else in the app, so arriving
  // here is exactly when these numbers have gone stale.
  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  if (!progress) {
    return (
      <Card className={cn("gap-3 py-5", className)}>
        <div className="flex flex-col gap-3 px-5">
          {isLoading ? (
            <div role="status" aria-busy className="flex flex-col gap-3">
              <span className="sr-only">Loading your level</span>
              <div className="flex items-baseline justify-between gap-4" aria-hidden>
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-4 w-28" />
              </div>
              <Skeleton className="h-2 w-full" aria-hidden />
            </div>
          ) : (
            // The read failed with nothing cached behind it. Showing the
            // skeleton here instead would leave the page waiting for ever on
            // something that has already given up.
            <ErrorState
              title="Could not load your progress."
              message={error}
              onRetry={() => void loadProgress()}
              className="py-4"
            />
          )}
        </div>
      </Card>
    );
  }

  const { level, totalXp } = progress;
  const percent = Math.round(xpFraction(level) * 100);

  return (
    <Card className={cn("gap-3 py-5", className)}>
      <div className="flex flex-col gap-3 px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {/* The whole of the level-up celebration: it swells once. See
              `useLevelUp` for why sections 50 and 88 mean it stops there. */}
          <h2
            className={cn(
              "text-xl font-semibold tracking-tight",
              isLevellingUp && "animate-pop",
            )}
          >
            Level {level.level}
          </h2>
          <p className="text-sm tabular-nums text-muted-foreground">
            {level.xpIntoLevel} / {level.xpForNextLevel} XP
          </p>
        </div>

        <ProgressBar
          value={percent}
          className="h-2"
          aria-label={`Level ${level.level} progress: ${level.xpIntoLevel} of ${level.xpForNextLevel} XP`}
        />

        <p className="text-xs text-muted-foreground">
          {totalXp.toLocaleString()} XP earned in total
        </p>
      </div>

      {error && (
        <StaleNotice
          className="px-5"
          message="Progress may be out of date."
          onRetry={() => void loadProgress()}
        />
      )}
    </Card>
  );
}

export default ProgressLevel;
export { ProgressLevel };
