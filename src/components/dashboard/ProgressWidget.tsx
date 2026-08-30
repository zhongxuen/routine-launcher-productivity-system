import { useEffect } from "react";
import { Flame } from "lucide-react";

import ErrorState from "@/components/common/states/ErrorState";
import StaleNotice from "@/components/common/states/StaleNotice";
import { Card } from "@/components/ui/card";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useLevelUp } from "@/hooks/useLevelUp";
import { cn } from "@/lib/utils";
import { useProgressStore } from "@/stores/progressStore";
import { xpFraction, type LevelProgress, type StreakProgress } from "@/types/progress";

/**
 * The dashboard's Progress widget (development-plan.md section 7) — level, XP
 * bar and streak flame, in the order and the words the section 7 mockup puts
 * them in.
 *
 * It is the last of the four dashboard widgets and the smallest on purpose:
 * sections 7 and 50 both say gamification is visually secondary, so this is
 * three lines of small muted type rather than a panel competing with today's
 * tasks. That is a design constraint, not a placeholder — the widget should
 * still look like this once the numbers behind it are real.
 *
 * The numbers come from `progressStore`, which reads `xpService` — the same
 * source as the level bar at the head of the Progress page, so the two can
 * never disagree about what level the user is. This component takes no data
 * props at all, which is what let Stage 9 replace the store's body without
 * opening this file, and is why anything derived from the numbers belongs in
 * the store or in `types/progress.ts` rather than in here.
 *
 * Self-contained: Prompt 6.5 composes it into `Dashboard.tsx` and positions
 * it with `className`.
 */
function ProgressWidget({ className }: { className?: string }) {
  const progress = useProgressStore((state) => state.progress);
  const isLoading = useProgressStore((state) => state.isLoading);
  const error = useProgressStore((state) => state.error);
  const loadProgress = useProgressStore((state) => state.loadProgress);

  // Re-read on every mount rather than only on the first one: XP is earned by
  // finishing tasks, sessions and routines elsewhere in the app, so coming
  // back to the dashboard is exactly when these numbers have gone stale.
  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  return (
    <Card className={cn("gap-3 py-5", className)}>
      <header className="px-5">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">PROGRESS</p>
      </header>

      <div className="flex flex-col gap-3 px-5">
        {progress ? (
          <>
            <LevelBar level={progress.level} />
            <StreakLine streak={progress.streak} />
          </>
        ) : isLoading ? (
          <ProgressSkeleton />
        ) : (
          // Nothing has ever loaded and the read failed. Without this the
          // skeleton stayed up for good, which reads as a permanent wait
          // rather than as something the user can press a button about.
          <ErrorState
            title="Could not load your progress."
            message={error}
            onRetry={() => void loadProgress()}
            className="py-4"
          />
        )}
      </div>

      {/* Stated under the numbers rather than instead of them, the way the
          Focus widget states a short total: stale XP is still worth looking
          at, and this block is the least important thing on the page to be
          loud about failing. */}
      {error && progress && (
        <StaleNotice
          className="px-5"
          message="Progress may be out of date."
          onRetry={() => void loadProgress()}
        />
      )}
    </Card>
  );
}

/**
 * "Level 4" over a bar reading "620 / 800 XP" — section 45's three lines.
 *
 * The count sits beside the bar rather than under it so the whole widget
 * stays three lines tall, and is tabular so it does not jitter as XP lands.
 */
function LevelBar({ level }: { level: LevelProgress }) {
  const percent = Math.round(xpFraction(level) * 100);
  const isLevellingUp = useLevelUp(level.level);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Section 50 puts this widget at the bottom of the hierarchy, so the
          level-up is the same single swell as on the Progress page and no
          more. See `useLevelUp`. */}
      <p className={cn("text-sm font-medium", isLevellingUp && "animate-pop")}>
        Level {level.level}
      </p>

      <div className="flex items-center gap-3">
        <ProgressBar
          value={percent}
          className="h-1.5 flex-1"
          aria-label={`Level ${level.level} progress: ${level.xpIntoLevel} of ${level.xpForNextLevel} XP`}
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {level.xpIntoLevel} / {level.xpForNextLevel} XP
        </span>
      </div>
    </div>
  );
}

/**
 * Section 46's flame counter.
 *
 * A streak of zero still gets a line — a dim flame and an invitation — rather
 * than disappearing: the section 46 rule is deliberately easy to satisfy (one
 * task, one session, or one routine), so saying what is missing is more use
 * than saying nothing. The best run is shown only while it is ahead of the
 * current one, where it is context rather than a scolding.
 */
function StreakLine({ streak }: { streak: StreakProgress }) {
  const { currentStreak, longestStreak } = streak;
  const isActive = currentStreak > 0;

  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Flame
        className={cn("size-4 shrink-0", isActive ? "text-amber-500" : "text-muted-foreground/50")}
        aria-hidden
      />
      <span className={cn(isActive && "font-medium text-foreground")}>
        {isActive
          ? `${currentStreak} Day Streak`
          : "No streak yet — finish a task, session or routine today"}
      </span>
      {isActive && longestStreak > currentStreak ? <span>· best {longestStreak}</span> : null}
    </p>
  );
}

/** The same three lines, at the same heights, while the numbers are read. */
function ProgressSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-16" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-1.5 flex-1" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <Skeleton className="h-4 w-32" />
    </div>
  );
}

export default ProgressWidget;
export { ProgressWidget };
