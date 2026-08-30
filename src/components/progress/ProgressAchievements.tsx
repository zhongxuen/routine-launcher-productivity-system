import { useEffect } from "react";
import { format } from "date-fns";
import { Lock, Trophy } from "lucide-react";

import AsyncBody from "@/components/common/states/AsyncBody";
import StaleNotice from "@/components/common/states/StaleNotice";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { achievementIcon, sortAchievements } from "@/lib/achievements";
import { formatRelativeDate, parseTimestamp } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import { useProgressStore } from "@/stores/progressStore";
import {
  ACHIEVEMENT_KEYS,
  achievementFraction,
  isUnlocked,
  type Achievement,
} from "@/types/progress";

/**
 * Progress > Achievements (development-plan.md sections 47 and 64) — the six
 * achievements as a grid, locked ones included.
 *
 * Showing the locked five is the whole point of the page. Section 47's list
 * is short and its conditions are plain ("Complete 10 focus sessions",
 * "Maintain a 7-day streak"), so a grid that hid them would be a grid that
 * only ever told the user what they had already done. Locked tiles keep
 * their name and their condition and lose their colour — recognisably the
 * same tile, waiting.
 *
 * Nothing on this page is a control. Achievements are earned by using the
 * app, so there is nothing to press, and section 50 keeps it that way: this
 * is a record, sitting under the level bar, that the productivity system
 * writes to as a side effect.
 */
function ProgressAchievements() {
  const achievements = useProgressStore((state) => state.achievements);
  const isLoading = useProgressStore((state) => state.isAchievementsLoading);
  const error = useProgressStore((state) => state.achievementsError);
  const loadAchievements = useProgressStore((state) => state.loadAchievements);

  useEffect(() => {
    void loadAchievements();
  }, [loadAchievements]);

  const sorted = sortAchievements(achievements);
  const unlocked = sorted.filter(isUnlocked).length;

  return (
    <div className="flex flex-col gap-6 py-2">
      <header className="flex flex-col gap-0.5 px-2">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">ACHIEVEMENTS</p>
        <p className="text-sm text-muted-foreground">
          {sorted.length === 0
            ? "Earned by using the app"
            : `${unlocked} of ${sorted.length} unlocked`}
        </p>
      </header>

      {/* A re-read that fails with tiles already on screen keeps the tiles:
          an achievement is a record of something that happened, so a stale
          one is not wrong, only possibly missing its newest entry. */}
      <AsyncBody
        isLoading={isLoading && sorted.length === 0}
        error={sorted.length === 0 ? error : null}
        onRetry={() => void loadAchievements()}
        loading={<AchievementSkeleton />}
        loadingLabel="Loading your achievements"
        errorTitle="Could not load your achievements."
        isEmpty={sorted.length === 0}
        emptyIcon={Trophy}
        emptyTitle="No achievements to earn yet."
        emptyHint="They arrive with the app — if this stays empty, the database has not been seeded."
      >
        <ul className="grid gap-3 px-2 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((achievement) => (
            <AchievementTile key={achievement.key} achievement={achievement} />
          ))}
        </ul>
      </AsyncBody>

      {error && sorted.length > 0 && (
        <StaleNotice
          className="px-2"
          message="These may be missing something you just earned."
          onRetry={() => void loadAchievements()}
        />
      )}
    </div>
  );
}

/**
 * One tile: icon, name, what it takes, and where the user has got to.
 *
 * Locked and unlocked are told apart by three quiet things at once — a
 * dashed border, a muted icon, and a small padlock — rather than by one loud
 * one. Colour alone would not survive being colour-blind, and a greyscale
 * filter alone reads as "disabled", which is the wrong idea: a locked
 * achievement is available, not unavailable.
 *
 * The bar under a locked tile appears only when the backend can count the
 * thing being asked for. "Complete your first task" has nothing to count, so
 * it gets no bar rather than an empty one.
 */
function AchievementTile({ achievement }: { achievement: Achievement }) {
  const unlocked = isUnlocked(achievement);
  const Icon = achievementIcon(achievement);
  // Bound to a local so the block below narrows: a `showBar` boolean would
  // not, and `progress.current` inside it would be a null dereference away.
  const progress = unlocked ? null : achievement.progress;

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        unlocked ? "bg-card shadow-sm" : "border-dashed bg-transparent",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            unlocked ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground/60",
          )}
        >
          <Icon className="size-5" aria-hidden />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <p className={cn("truncate text-sm", unlocked ? "font-medium" : "text-muted-foreground")}>
              {achievement.name}
            </p>
            {!unlocked && <Lock className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />}
          </div>
          {achievement.description && (
            <p className="text-xs text-muted-foreground">{achievement.description}</p>
          )}
        </div>
      </div>

      {progress && progress.target > 0 && (
        <div className="flex items-center gap-3">
          <ProgressBar
            value={Math.round(achievementFraction(achievement) * 100)}
            className="h-1.5 flex-1"
            aria-label={`${achievement.name}: ${progress.current} of ${progress.target}`}
          />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {progress.current} / {progress.target}
          </span>
        </div>
      )}

      <p className="text-xs text-muted-subtle">
        {unlocked ? `Unlocked · ${unlockedOn(achievement)}` : "Locked"}
      </p>
      <span className="sr-only">{unlocked ? "Unlocked" : "Locked"}</span>
    </li>
  );
}

/**
 * `"Today"`, `"Yesterday"`, otherwise `"Sat, Aug 30"` — the same words the
 * task views use for a date, so a date means the same thing everywhere. It
 * follows a separator rather than the word "Unlocked" directly, so the two
 * capitalised forms and the two lowercase ones all read the same.
 *
 * `unlockedAt` is a UTC timestamp; the day it belongs to is the local one, so
 * the key is built from a parsed `Date`'s local fields rather than sliced off
 * the front of the string — those are different days for half the world.
 */
function unlockedOn(achievement: Achievement): string {
  const at = parseTimestamp(achievement.unlockedAt);
  return at ? formatRelativeDate(format(at, "yyyy-MM-dd")) : "";
}

/** Six tiles' worth of space, so the grid does not jump when they arrive. */
function AchievementSkeleton() {
  return (
    <div role="status" aria-busy className="grid gap-3 px-2 sm:grid-cols-2 xl:grid-cols-3">
      <span className="sr-only">Loading your achievements</span>
      {ACHIEVEMENT_KEYS.map((key) => (
        <Skeleton key={key} className="h-28 w-full rounded-xl" aria-hidden />
      ))}
    </div>
  );
}

export default ProgressAchievements;
