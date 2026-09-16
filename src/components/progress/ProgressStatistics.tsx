import { useEffect } from "react";
import { CircleCheckBig, Flame, Rocket, Timer, type LucideIcon } from "lucide-react";

import ErrorState from "@/components/common/states/ErrorState";
import StaleNotice from "@/components/common/states/StaleNotice";
import RoutineIcon from "@/components/routines/RoutineIcon";
import { Card } from "@/components/ui/card";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  completionPercent,
  dayTooltip,
  focusBarFraction,
  inWeeks,
  shortDate,
  weekBarFraction,
  weekRange,
  weekTooltip,
  weekdayInitial,
  weekdayName,
} from "@/lib/analytics-utils";
import { formatFocusTime } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import { useAnalyticsStore } from "@/stores/analyticsStore";
import type { DayStats, PeriodStats, ProductivityStats, TrendWeek } from "@/types/analytics";

/** A figure that has nothing behind it — never a zero standing in for one. */
const NOT_MEASURED = "—";

/**
 * Progress > Statistics (development-plan.md sections 36 and 82).
 *
 * ```text
 * TODAY                       THIS WEEK
 *
 * Focus:      2h 15m          Focus:               12h 30m
 * Tasks:      6 / 8           Tasks:               32 / 41
 * Routines:   4               Completion:          78%
 * Completion: 75%             Most used routine:   Coding
 *                             Most productive day: Wednesday
 * ```
 *
 * Two panels, in the plan's own order, plus the three things section 82 adds
 * to them: the week's day-by-day focus, focus across the last eight weeks,
 * and the streak history underneath.
 *
 * # Why the figures are what they are
 *
 * Section 88 asks the app not to flatter, and it shows up here three times.
 *
 * * **Focus counts completed sessions only.** An interrupted session records
 *   real seconds, but so does one the app was killed during. These are the
 *   same hours the Deep Work achievement counts, not a more generous set.
 * * **A completion rate needs something to complete.** A day with nothing
 *   scheduled shows a dash, not "0%" — see `completionPercent`. Telling
 *   someone with an empty calendar that they are at zero percent would be a
 *   verdict on a day that never asked anything of them.
 * * **An empty week has no best day.** `mostProductiveDay` is null until
 *   something has actually happened, rather than crowning whichever blank
 *   day sorted first.
 *
 * The whole tab is one read (`getProductivityStats`), so every panel is
 * measured against the same local day — a load that straddled midnight cannot
 * leave Today and This Week disagreeing about which day it is.
 *
 * "This week" starts on the day chosen in Settings (section 52): Monday, or
 * Sunday. The backend decides the week's dates, and everything here that
 * names a day — the range under THIS WEEK, the letters under the bars — is
 * rendered from those dates, so nothing on this tab assumes either one.
 *
 * # Application usage (section 37) is not here
 *
 * Section 37 describes tracking how long applications stay open, and then
 * says plainly: do not call this productivity time. This pass leaves it out
 * altogether rather than shipping a panel that has to argue with itself — it
 * is a "potential future feature" in the plan, it needs a table `0001_init`
 * deliberately deferred, and nothing else on this page would be honest next
 * to a figure that counts an idle editor as work. If it is built later it
 * belongs under its own heading, labelled usage time.
 */
function ProgressStatistics() {
  const stats = useAnalyticsStore((state) => state.stats);
  const isLoading = useAnalyticsStore((state) => state.isLoading);
  const error = useAnalyticsStore((state) => state.error);
  const loadStats = useAnalyticsStore((state) => state.loadStats);

  // Re-read on mount: every figure here is made of work done elsewhere in the
  // app, so arriving on this tab is exactly when they have gone stale.
  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  return (
    <div className="flex flex-col gap-6 py-2">
      <header className="flex flex-col gap-0.5 px-2">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">STATISTICS</p>
        <p className="text-sm text-muted-foreground">
          What you actually did, today and this week
        </p>
      </header>

      {stats ? (
        <Panels stats={stats} />
      ) : isLoading ? (
        <Loading />
      ) : (
        // Nothing read and nothing cached. The muted line below is right for
        // figures that have merely gone stale, but on its own it left the
        // whole tab blank with no way to ask again.
        <ErrorState
          title="Could not load your statistics."
          message={error}
          onRetry={() => void loadStats()}
        />
      )}

      {error && stats && (
        <StaleNotice
          className="px-2"
          message="These figures may be out of date."
          onRetry={() => void loadStats()}
        />
      )}
    </div>
  );
}

/** Everything, once there is something to draw. */
function Panels({ stats }: { stats: ProductivityStats }) {
  const mostUsedRoutine = stats.routineUsage[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel heading="TODAY" caption={shortDate(stats.todayDate)}>
          <Figure label="Focus" value={formatFocusTime(stats.today.focusSeconds)} icon={Timer} />
          <Figure
            label="Tasks"
            value={`${stats.today.tasksCompleted} / ${stats.today.tasksTotal}`}
            icon={CircleCheckBig}
          />
          <Figure
            label="Routines"
            value={String(stats.today.routineLaunches)}
            icon={Rocket}
          />
          <Completion period={stats.today} />
        </Panel>

        <Panel heading="THIS WEEK" caption={weekRange(stats.week)}>
          <Figure label="Focus" value={formatFocusTime(stats.week.focusSeconds)} icon={Timer} />
          <Figure
            label="Tasks"
            value={`${stats.week.tasksCompleted} / ${stats.week.tasksTotal}`}
            icon={CircleCheckBig}
          />
          <Figure
            label="Routines"
            value={String(stats.week.routineLaunches)}
            icon={Rocket}
          />
          <Completion period={stats.week} />

          <div className="col-span-2 flex flex-col gap-2 border-t pt-4">
            <Line label="Most used routine">
              {mostUsedRoutine ? (
                <span className="flex items-center gap-1.5">
                  <RoutineIcon icon={mostUsedRoutine.icon} className="size-6 text-sm" />
                  <span className="truncate">{mostUsedRoutine.name}</span>
                  <span className="text-xs text-muted-foreground">
                    ×{mostUsedRoutine.launches}
                  </span>
                </span>
              ) : (
                <Absent>No routines launched yet</Absent>
              )}
            </Line>
            <Line label="Most productive day">
              {stats.mostProductiveDay ? (
                <span className="flex items-baseline gap-1.5">
                  <span>{weekdayName(stats.mostProductiveDay.date)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatFocusTime(stats.mostProductiveDay.focusSeconds)}
                  </span>
                </span>
              ) : (
                <Absent>Nothing recorded yet</Absent>
              )}
            </Line>
          </div>
        </Panel>
      </div>

      <WeekTrend days={stats.weekDays} today={stats.todayDate} />
      <WeeklyTrend weeks={stats.weekTrend} />
      <StreakHistory stats={stats} />
    </div>
  );
}

/** One of section 36's two boxes: a heading, a date range, and its figures. */
function Panel({
  heading,
  caption,
  children,
}: {
  heading: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-4 px-6 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium tracking-widest text-muted-foreground">{heading}</h2>
        <p className="text-xs text-muted-subtle tabular-nums">{caption}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">{children}</dl>
    </Card>
  );
}

/** One headline number, with the icon of the system it came from. */
function Figure({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </dt>
      <dd className="text-2xl font-medium tabular-nums leading-tight">{value}</dd>
    </div>
  );
}

/**
 * Section 36's "Completion: 75%", with the bar the number is easier to read
 * as. A window that asked nothing of the user shows a dash and no bar.
 */
function Completion({ period }: { period: PeriodStats }) {
  const percent = completionPercent(period);

  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">Completion</dt>
      <dd
        className={cn(
          "text-2xl font-medium tabular-nums leading-tight",
          percent === null && "text-muted-foreground/40",
        )}
      >
        {percent === null ? NOT_MEASURED : `${percent}%`}
      </dd>
      {percent !== null && <ProgressBar value={percent} className="mt-1 h-1.5" />}
    </div>
  );
}

/** A label-and-value row, for the two named things under the week's figures. */
function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{children}</span>
    </div>
  );
}

/** A figure with nothing behind it yet, said in words rather than as a zero. */
function Absent({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-normal text-muted-subtle">{children}</span>;
}

/**
 * Section 82's "productivity trends": the week's focus, day by day.
 *
 * Bars are drawn relative to the week's own busiest day rather than against a
 * target, because there is no correct number of focused hours in a day and a
 * fixed ceiling would invent one. A week with no focus in it draws seven
 * empty tracks — the shape of the week is still worth seeing, and it is where
 * the next bar will appear.
 *
 * Days still to come are dimmed rather than left out, so the row keeps its
 * width from the week's first morning onwards.
 */
function WeekTrend({ days, today }: { days: DayStats[]; today: string }) {
  return (
    <Card className="gap-4 px-6 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium tracking-widest text-muted-foreground">
          FOCUS THIS WEEK
        </h2>
        <p className="text-xs text-muted-subtle">Relative to the week&rsquo;s best day</p>
      </div>

      <ol className="flex h-32 items-end gap-2">
        {days.map((day) => {
          const fraction = focusBarFraction(day, days);
          const isFuture = day.date > today;

          return (
            <li
              key={day.date}
              className="flex h-full flex-1 flex-col items-center justify-end gap-1.5"
              title={
                isFuture
                  ? `${shortDate(day.date)} — still to come`
                  : `${shortDate(day.date)} — ${formatFocusTime(day.focusSeconds)} focused`
              }
            >
              <span className="text-[0.65rem] tabular-nums text-muted-foreground">
                {day.focusSeconds > 0 ? formatFocusTime(day.focusSeconds) : ""}
              </span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className={cn(
                    "w-full rounded-t-sm",
                    day.focusSeconds > 0 ? "bg-primary" : "bg-muted",
                    isFuture && "opacity-40",
                  )}
                  // A day with no focus still gets a sliver of track, so the
                  // row reads as seven days rather than as a gap.
                  style={{ height: `${Math.max(2, fraction * 100)}%` }}
                />
              </div>
              <span
                className={cn(
                  "text-xs",
                  day.date === today
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                  isFuture && "text-muted-foreground/50",
                )}
              >
                {weekdayInitial(day.date)}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/**
 * Section 82's "productivity trends" across weeks: the last eight weeks of
 * focus, one bar each, with the tasks completed underneath.
 *
 * Bars are relative to the busiest week shown, for the same reason the days
 * above are relative to the busiest day. Each bar is a plain SVG stretched to
 * its column — no chart library for eight rectangles.
 *
 * Two kinds of nothing are drawn differently, because they mean different
 * things (section 88):
 *
 * * **A week before the first recorded activity** has no bar and no track —
 *   only a dashed baseline — and its figures are dashes. The app was not
 *   keeping a record then, so a zero would draw a slump that never happened.
 * * **A quiet week after it** is a real zero: a sliver of track, "0m", "0".
 *
 * The current week is lighter while it is still under way, so a Wednesday
 * does not read as a bad week.
 */
function WeeklyTrend({ weeks }: { weeks: TrendWeek[] }) {
  const current = weeks[weeks.length - 1];
  const anyRecorded = weeks.some((week) => week.totals !== null);

  return (
    <Card className="gap-4 px-6 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium tracking-widest text-muted-foreground">
          FOCUS BY WEEK
        </h2>
        <p className="flex items-center gap-1.5 text-xs text-muted-subtle">
          <CircleCheckBig className="size-3" aria-hidden />
          tasks completed under each week
        </p>
      </div>

      <ol className="flex items-end gap-2" aria-label="Focus time and tasks completed by week">
        {weeks.map((week) => {
          const isCurrent = week === current;
          const totals = week.totals;
          const height = totals ? Math.max(2, weekBarFraction(week, weeks) * 100) : 0;

          return (
            <li
              key={week.start}
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
              title={weekTooltip(week, isCurrent)}
            >
              <span
                className={cn(
                  "truncate text-[0.65rem] tabular-nums",
                  totals ? "text-muted-foreground" : "text-muted-foreground/40",
                )}
              >
                {totals ? formatFocusTime(totals.focusSeconds) : NOT_MEASURED}
              </span>

              <svg
                viewBox="0 0 10 100"
                preserveAspectRatio="none"
                className="h-24 w-full"
                aria-hidden
              >
                {totals ? (
                  <rect
                    x={0}
                    y={100 - height}
                    width={10}
                    height={height}
                    className={cn(
                      totals.focusSeconds > 0 ? "fill-primary" : "fill-muted",
                      isCurrent && totals.focusSeconds > 0 && "opacity-60",
                    )}
                  />
                ) : (
                  <line
                    x1={0}
                    x2={10}
                    y1={99}
                    y2={99}
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                    className="stroke-muted-foreground/40"
                  />
                )}
              </svg>

              <span
                className={cn(
                  "truncate text-xs",
                  isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {isCurrent ? "This week" : shortDate(week.start)}
              </span>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  totals ? "text-foreground" : "text-muted-foreground/40",
                )}
              >
                {totals ? totals.tasksCompleted : NOT_MEASURED}
              </span>
            </li>
          );
        })}
      </ol>

      {!anyRecorded && (
        <p className="text-xs text-muted-foreground">
          Weeks fill in from your first finished task, focus session or routine launch.
        </p>
      )}
    </Card>
  );
}

/**
 * Section 82's streak history: four weeks of days, filled where the day
 * counted.
 *
 * A day counts on section 46's rule — one task, one completed focus session,
 * or one routine launch — which is the same condition the flame is counted
 * from, so this grid is a picture of the streak rather than a second opinion
 * about it. The current and longest runs sit beside it as the numbers the
 * Streak tab shows in full.
 */
function StreakHistory({ stats }: { stats: ProductivityStats }) {
  const weeks = inWeeks(stats.streakHistory);

  return (
    <Card className="gap-4 px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium tracking-widest text-muted-foreground">
          LAST FOUR WEEKS
        </h2>
        <p className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Flame
              className={cn(
                "size-3.5",
                stats.streak.currentStreak > 0 ? "text-amber-500" : "text-muted-foreground/40",
              )}
              aria-hidden
            />
            <span className="tabular-nums text-foreground">{stats.streak.currentStreak}</span>
            day streak
          </span>
          <span>
            best <span className="tabular-nums text-foreground">{stats.streak.longestStreak}</span>
          </span>
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        {weeks.map((week) => (
          <div key={week[0]?.date} className="flex gap-1.5">
            {week.map((day) => (
              <div
                key={day.date}
                title={dayTooltip(day)}
                className={cn(
                  "h-6 flex-1 rounded-sm",
                  day.productive ? "bg-primary" : "bg-muted",
                  day.date === stats.todayDate && "ring-2 ring-primary/50 ring-offset-1",
                )}
              />
            ))}
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        A day counts when you complete a task, finish a focus session, or launch a routine.
      </p>
    </Card>
  );
}

/** The page's shape while the first read is in flight. */
function Loading() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-4">
      <span className="sr-only">Loading your statistics</span>
      <div className="grid gap-4 lg:grid-cols-2" aria-hidden>
        <Skeleton className="h-52 w-full rounded-xl" />
        <Skeleton className="h-52 w-full rounded-xl" />
      </div>
      <Skeleton className="h-48 w-full rounded-xl" aria-hidden />
      <Skeleton className="h-52 w-full rounded-xl" aria-hidden />
      <Skeleton className="h-44 w-full rounded-xl" aria-hidden />
    </div>
  );
}

export default ProgressStatistics;
