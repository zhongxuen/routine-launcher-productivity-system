import { useEffect } from "react";
import { CircleCheckBig, Flame, Rocket, Timer, type LucideIcon } from "lucide-react";

import ErrorState from "@/components/common/states/ErrorState";
import StaleNotice from "@/components/common/states/StaleNotice";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeDate, todayKey } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import { useProgressStore } from "@/stores/progressStore";
import type { StreakProgress } from "@/types/progress";

/**
 * Progress > Streak (development-plan.md sections 46 and 64).
 *
 * ```text
 * 🔥 7 DAY STREAK
 * ```
 *
 * Section 46's whole point is that the requirement is easy — one task, one
 * focus session, or one routine, and the day counts — so the three ways to
 * keep it are written out under the number rather than left for the user to
 * discover by losing it. A streak system whose rule is invisible is a streak
 * system that feels arbitrary the first time it breaks.
 *
 * The number is the biggest type in the app outside the focus clock, and it
 * is still on one small page two clicks from the dashboard. That is section
 * 50's hierarchy: gamification can be prominent *within* Progress without
 * being prominent within the app.
 */
function ProgressStreak() {
  const progress = useProgressStore((state) => state.progress);
  const isLoading = useProgressStore((state) => state.isLoading);
  const error = useProgressStore((state) => state.error);
  const loadProgress = useProgressStore((state) => state.loadProgress);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  return (
    <div className="flex flex-col gap-6 py-2">
      <header className="flex flex-col gap-0.5 px-2">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">STREAK</p>
        <p className="text-sm text-muted-foreground">Days in a row you got something done</p>
      </header>

      {progress ? (
        <StreakCard streak={progress.streak} />
      ) : isLoading ? (
        <div role="status" aria-busy>
          <span className="sr-only">Loading your streak</span>
          <Skeleton className="h-40 w-full max-w-md rounded-xl" aria-hidden />
        </div>
      ) : (
        // A first read that failed used to leave this space blank with only a
        // muted line under it — an empty page that looked like a streak of
        // nothing rather than a streak nobody could read.
        <ErrorState
          title="Could not load your streak."
          message={error}
          onRetry={() => void loadProgress()}
        />
      )}

      {error && progress && (
        <StaleNotice
          className="px-2"
          message="Your streak may be out of date."
          onRetry={() => void loadProgress()}
        />
      )}
    </div>
  );
}

/**
 * The flame, the count, and the rule behind it.
 *
 * A streak of zero is drawn rather than hidden: it is the state the rule is
 * most worth reading in, and a page that disappeared when the user most
 * needed to know how to start would be a strange page. The flame goes cold
 * instead of going away.
 *
 * "Counted today" appears only when today has already counted, so it is a
 * confirmation rather than a demand — the difference between telling someone
 * they are safe and telling them they are not.
 */
function StreakCard({ streak }: { streak: StreakProgress }) {
  const { currentStreak, longestStreak, lastActiveDate } = streak;
  const isActive = currentStreak > 0;
  const countedToday = lastActiveDate === todayKey();

  return (
    <Card className="max-w-md gap-5 px-6 py-6">
      <div className="flex items-center gap-4">
        <Flame
          className={cn(
            "size-12 shrink-0",
            isActive ? "text-amber-500" : "text-muted-foreground/40",
          )}
          aria-hidden
        />
        <div className="flex flex-col gap-0.5">
          <p className="text-4xl font-semibold tabular-nums leading-none">{currentStreak}</p>
          <p className="text-xs font-medium tracking-widest text-muted-foreground">
            DAY STREAK
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          Longest streak: <span className="tabular-nums text-foreground">{longestStreak}</span>
          {longestStreak === 1 ? " day" : " days"}
        </p>
        <p>
          {lastActiveDate === null
            ? "No productive day recorded yet"
            : countedToday
              ? "Today already counts"
              : `Last counted ${formatRelativeDate(lastActiveDate)}`}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t pt-4">
        <p className="text-xs text-muted-foreground">
          {countedToday ? "A day counts when you:" : "Keep it going today — a day counts when you:"}
        </p>
        <ul className="flex flex-col gap-1.5 text-sm">
          <StreakRule icon={CircleCheckBig} label="Complete at least one task" />
          <StreakRule icon={Timer} label="Complete a focus session" />
          <StreakRule icon={Rocket} label="Launch a routine" />
        </ul>
      </div>
    </Card>
  );
}

/** One of section 46's three ways, each with the icon its system uses. */
function StreakRule({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{label}</span>
    </li>
  );
}

export default ProgressStreak;
