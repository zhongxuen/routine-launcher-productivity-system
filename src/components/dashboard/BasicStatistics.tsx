import { useEffect } from "react";
import { CircleCheckBig, Rocket, Timer, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

import ErrorState from "@/components/common/states/ErrorState";
import StaleNotice from "@/components/common/states/StaleNotice";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { completionPercent } from "@/lib/analytics-utils";
import { formatFocusTime } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import { useAnalyticsStore } from "@/stores/analyticsStore";
import { useFocusStore } from "@/stores/focusStore";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";
import type { PeriodStats } from "@/types/analytics";

/** A figure with nothing behind it — never a zero standing in for one. */
const NOT_MEASURED = "—";

/**
 * The dashboard's statistics block (development-plan.md sections 7, 36 and
 * 77) — section 36's TODAY panel, reduced to one row.
 *
 * ```text
 * STATISTICS                                       All statistics
 *
 * Focus        Tasks        Routines     Completion
 * 2h 15m       6 / 8        4            75%
 * ```
 *
 * A summary, not the tab. `/progress/statistics` draws the same four figures
 * plus the week, the week's day-by-day focus and four weeks of streak
 * history; this is the four the dashboard can act on before breakfast, in
 * section 36's own order, with a link for everything else. The dashboard is a
 * starting point rather than a second analytics page — the same reason
 * `UpcomingTasks` caps at five rows and hands the rest to `/tasks/upcoming`.
 *
 * # One command, one day
 *
 * `getProductivityStats` returns the whole of section 36 measured against a
 * single local `todayDate`, which is why this widget calls it as-is rather
 * than adding a lighter dashboard-only command. Two commands is how the
 * dashboard and the statistics page start disagreeing about which day it is
 * across midnight — the exact failure that made the backend answer in one
 * call in the first place. Nothing is cached behind it, so re-reading is
 * cheap and is how the figures pick up work done since the last look.
 *
 * The re-read watches the three stores whose contents these figures are made
 * of, the way `DailyQuests` does: a task ticked in `TodaysTasks` directly
 * above changes `6 / 8` here without either component knowing about the
 * other. The dashboard has already loaded all three for its other widgets,
 * so this adds one command call per mutation rather than a page of queries.
 *
 * # Why every figure can be a dash
 *
 * A zero is a claim and a dash is not — section 88's rule about not
 * flattering, run the other way. `completionPercent` already refuses to call
 * 0/0 zero percent, and the same reasoning covers the other three: no
 * completed session is not a session of no length (which is why
 * `formatSessionLength` dashes it too), no tasks owed is not a fraction, and
 * no launches is not a measured usage of anything.
 *
 * This is stricter than `ProgressStatistics`, which writes "0m" and "0"
 * beside a caption, a week panel and seven bars that say what the zero is
 * relative to. Here the four numbers stand alone under a heading, and a row
 * of bare zeroes at nine in the morning reads as a verdict on the day rather
 * than as a day that has not started. The *formatting* is shared either way —
 * `formatFocusTime` and `completionPercent` — so a duration or a percentage
 * that exists is written identically in both places.
 *
 * Self-contained, like every other block on the page: it owns its read, its
 * loading state and its error state, and `Dashboard.tsx` only positions it.
 */
function BasicStatistics({ className }: { className?: string }) {
  const stats = useAnalyticsStore((state) => state.stats);
  const isLoading = useAnalyticsStore((state) => state.isLoading);
  const error = useAnalyticsStore((state) => state.error);
  const loadStats = useAnalyticsStore((state) => state.loadStats);

  // The three systems these figures are aggregates of, watched where they
  // already live. Each collection changes identity on every reload and every
  // mutation, so finishing anything on this page re-counts the day.
  const tasks = useTaskStore((state) => state.tasks);
  const focusHistory = useFocusStore((state) => state.history);
  const routines = useRoutineStore((state) => state.routines);

  useEffect(() => {
    void loadStats();
  }, [loadStats, tasks, focusHistory, routines]);

  return (
    <Card className={cn("gap-3 py-5", className)}>
      <header className="flex items-baseline justify-between gap-3 px-5">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">STATISTICS</p>

        {/* Offered whatever state the figures are in — the page behind it is
            where a failed read can be retried in full, and it is the only
            thing here that still works when this card cannot. */}
        <Button variant="link" size="xs" className="px-0 text-muted-foreground" asChild>
          <Link to="/progress/statistics">All statistics</Link>
        </Button>
      </header>

      <div className="px-5">
        {stats ? (
          <Figures today={stats.today} />
        ) : isLoading ? (
          <FiguresSkeleton />
        ) : (
          // Nothing has ever loaded and the read failed. Without this the
          // skeleton would stay up for good, which reads as a permanent wait
          // rather than as something the user can press a button about.
          <ErrorState
            title="Could not load your statistics."
            message={error}
            onRetry={() => void loadStats()}
            className="py-4"
          />
        )}
      </div>

      {/* Stated under the numbers rather than instead of them, the way the
          Progress and Objectives widgets state theirs: figures from a minute
          ago are still worth reading, and blanking the row would lose more
          than the staleness costs. */}
      {error && stats && (
        <StaleNotice
          className="px-5"
          message="These figures may be out of date."
          onRetry={() => void loadStats()}
        />
      )}
    </Card>
  );
}

/**
 * Section 36's TODAY panel, in its order: focus, tasks, routines, completion.
 *
 * Four across on a wide window and two-by-two on a narrow one, so the row
 * stays a row of figures rather than wrapping into a list that would compete
 * with the task blocks above it.
 */
function Figures({ today }: { today: PeriodStats }) {
  const percent = completionPercent(today);

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
      <Figure
        label="Focus"
        icon={Timer}
        // Zero seconds is no completed session at all rather than a session
        // of no length — `formatSessionLength` draws the same distinction.
        value={today.focusSeconds > 0 ? formatFocusTime(today.focusSeconds) : null}
      />
      <Figure
        label="Tasks"
        icon={CircleCheckBig}
        // Dashed on the same condition as the completion rate beside it, so
        // the fraction and the percentage can never disagree about whether
        // the day asked anything of the user.
        value={today.tasksTotal > 0 ? `${today.tasksCompleted} / ${today.tasksTotal}` : null}
      />
      <Figure
        label="Routines"
        icon={Rocket}
        value={today.routineLaunches > 0 ? String(today.routineLaunches) : null}
      />
      <Figure label="Completion" value={percent === null ? null : `${percent}%`} />
    </dl>
  );
}

/**
 * One headline number, with the icon of the system it came from.
 *
 * A null is a figure with nothing behind it, drawn as a dash in the muted
 * colour so it reads as absent rather than as zero — the same treatment the
 * routine statistics dialog gives an average with no sessions to average.
 * Completion carries no icon: it is the only one of the four that is derived
 * from another rather than counted by a system of its own.
 */
function Figure({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | null;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
        {label}
      </dt>
      <dd
        className={cn(
          "text-xl font-medium tabular-nums leading-tight",
          value === null && "text-muted-foreground/40",
        )}
      >
        {value ?? NOT_MEASURED}
      </dd>
    </div>
  );
}

/** The same four figures, at the same heights, while the day is counted. */
function FiguresSkeleton() {
  return (
    <div role="status" aria-busy className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
      <span className="sr-only">Loading today&apos;s statistics</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex flex-col gap-1" aria-hidden>
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-14" />
        </div>
      ))}
    </div>
  );
}

export default BasicStatistics;
export { BasicStatistics };
