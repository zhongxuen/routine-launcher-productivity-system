/**
 * Productivity analytics types — the daily and weekly figures of
 * development-plan.md sections 36 and 82, and the per-routine figures of
 * section 33.
 *
 * These mirror the payloads `src-tauri/src/services/analytics.rs` returns,
 * field for field. camelCase on the wire, like `progress.ts` and for the same
 * reason: nothing here is a row, so there is no row shape to mirror. Every
 * value is computed across `tasks`, `focus_sessions`, `routine_launches` and
 * `routines` at read time — the backend stores no aggregate, so a deleted
 * task or an ended session simply changes what the next read says.
 *
 * The values behind these types come from `src/services/analyticsService.ts`,
 * which is the only place that talks to the commands. The formatting and the
 * derived percentages live in `src/lib/analytics-utils.ts`.
 *
 * Application usage (section 37) is deliberately absent — see the note at the
 * foot of `src/components/progress/ProgressStatistics.tsx`.
 */

import type { StreakProgress } from "./progress";

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** One local day's totals, and whether it counted towards the streak. */
export interface DayStats {
  /** Local `YYYY-MM-DD`. The weekday is rendered from this, not sent. */
  date: string;
  /** Seconds of *completed* focus that ended on this day. */
  focusSeconds: number;
  /** How many completed sessions those seconds came from. */
  focusSessions: number;
  tasksCompleted: number;
  routineLaunches: number;
  /**
   * Whether the day met section 46's rule — one task, one completed focus
   * session, or one routine launch. The same condition the streak counts, so
   * a filled square in the history is a day the flame kept.
   */
  productive: boolean;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/**
 * The totals for a window of days — section 36's TODAY and THIS WEEK panels.
 *
 * `tasksTotal` is the work that was *owed* for the window rather than every
 * task that exists: what was completed inside it, plus what is still open and
 * was due by the end of it. That is the same population the Today view lists,
 * so this panel and the task list cannot report different fractions of the
 * same day. See `PeriodStats` in `analytics.rs` for the full rule.
 */
export interface PeriodStats {
  /** First local day of the window, `YYYY-MM-DD`. */
  start: string;
  /**
   * Last local day, inclusive. Equal to `start` for TODAY; the week's last
   * day for THIS WEEK, which is usually still in the future.
   */
  end: string;
  focusSeconds: number;
  focusSessions: number;
  tasksCompleted: number;
  tasksTotal: number;
  routineLaunches: number;
}

/** How often one routine was launched in a window (section 82's routine usage). */
export interface RoutineUsage {
  routineId: number;
  name: string;
  /** The routine's emoji, or null — what `RoutineIcon` renders. */
  icon: string | null;
  launches: number;
}

/** Everything the Statistics tab draws, in one read. */
export interface ProductivityStats {
  /** Local `YYYY-MM-DD` the whole payload was computed for. */
  todayDate: string;
  today: PeriodStats;
  week: PeriodStats;
  /**
   * The current week, from the week start chosen in Settings (Monday or
   * Sunday, section 52) — always seven entries, days still to come included
   * as zeroes so the bars keep their shape as the week fills in.
   */
  weekDays: DayStats[];
  /**
   * Every routine launched this week, most-launched first. `[0]` is section
   * 36's "Most used routine"; empty when none were launched.
   */
  routineUsage: RoutineUsage[];
  /**
   * The week's best day by focus time, or null while the week is still empty
   * — naming a winner out of seven blank days would be the app flattering
   * (section 88).
   */
  mostProductiveDay: DayStats | null;
  /** Section 46's streak, recomputed on the way through the read. */
  streak: StreakProgress;
  /**
   * The last four weeks ending today, oldest first — section 82's "streak
   * history" as a calendar of the days that counted.
   */
  streakHistory: DayStats[];
  /**
   * The last eight weeks, oldest first, ending with the current one — section
   * 82's trend across weeks. Weeks start on the same day as `week`, and the
   * last entry's totals are `week`.
   */
  weekTrend: TrendWeek[];
}

/** One week of the trend across weeks. */
export interface TrendWeek {
  /** First local day of the week, `YYYY-MM-DD`. */
  start: string;
  /** Last local day, inclusive. */
  end: string;
  /**
   * The week's totals, or null for a week that ended before the first
   * recorded activity — a week the app has no record of, drawn empty rather
   * than as a zero. A quiet week after that first activity is a real zero.
   */
  totals: PeriodStats | null;
}

// ---------------------------------------------------------------------------
// Routine statistics (section 33)
// ---------------------------------------------------------------------------

/**
 * Section 33's five figures for one routine, all of them measured.
 *
 * Three of them were `null` through Stages 2 to 10 because nothing wrote
 * `focus_sessions` or set `tasks.routine_id` yet. Both are written now, so
 * the dash-and-footnote the panel used to show is gone: a zero here means
 * zero, not "not tracked".
 *
 * `averageSessionSeconds` is the one that stays nullable, because no sessions
 * is not the same as a session of no length.
 */
export interface RoutineStatistics {
  routineId: number;
  /**
   * Lifetime launches — `routines.launch_count`, which predates the dated
   * `routine_launches` log and so counts launches the log never saw.
   */
  launches: number;
  /** Total focus time recorded against this routine, in seconds. */
  focusSeconds: number;
  /** Mean length of one of those sessions, or null when there are none. */
  averageSessionSeconds: number | null;
  /** Completed tasks that name this routine. */
  tasksCompleted: number;
  /** UTC timestamp of the last launch, or null if never launched. */
  lastUsed: string | null;
}
