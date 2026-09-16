/**
 * The end-of-day review's rules (development-plan.md sections 22 and 52).
 *
 * ```text
 * DAY COMPLETE
 *
 * Tasks:       6 / 8 completed
 * Focus:       3h 12m
 * Routines:    4
 * Incomplete:  2 tasks
 * Tomorrow:    5 tasks planned
 *
 * 🔥 Streak maintained
 *
 * [ Review Tomorrow ]
 * ```
 *
 * Not a second way of counting anything. Tasks, focus and routines are
 * section 36's TODAY figures from `getProductivityStats`, the streak is the
 * progress store's, and the incomplete tasks are the backend's `today` view —
 * the list the dashboard shows. What lives here is only what is particular to
 * the evening: when the day has ended, which tasks are still open, and what
 * "tomorrow" is.
 *
 * Section 22 calls the review optional, so nothing here opens it, and nothing
 * moves a task. "Move to tomorrow" is a button the user presses, and each
 * press is one ordinary `updateTask` — section 67's user-initiated rule,
 * applied to tasks.
 */

import { addDays, format } from "date-fns";

import { isOpenTask, timeLeftToday } from "@/lib/daily-plan";
import type { DailySettings } from "@/types/settings";
import type { StreakProgress } from "@/types/progress";
import type { Task } from "@/types/task";

/**
 * Whether the day's end from Settings > Daily has come — from which the
 * dashboard offers the review. The same clock arithmetic PLAN TODAY uses for
 * its time left, so the review appears the minute that reaches zero.
 */
export function dayHasEnded(
  daily: Pick<DailySettings, "dayStartTime" | "dayEndTime">,
  now: Date,
): boolean {
  return timeLeftToday(daily, now).phase === "after";
}

/** Tomorrow's local `YYYY-MM-DD`: the date "Move to tomorrow" sets. */
export function tomorrowKey(now: Date = new Date()): string {
  return format(addDays(now, 1), "yyyy-MM-dd");
}

/**
 * Today's tasks still open, in the list's own order — carried-over tasks
 * included, since they are as unfinished as today's.
 */
export function incompleteTasks(tasks: Task[]): Task[] {
  return tasks.filter(isOpenTask);
}

/**
 * Tomorrow's figure: the tasks due then, less any cancelled. A task already
 * finished ahead of time still counts — it was planned for tomorrow.
 */
export function tasksPlanned(tasks: Task[]): number {
  return tasks.filter((task) => task.status !== "cancelled").length;
}

/**
 * Whether today has already counted towards section 46's streak. The backend
 * stamps `lastActiveDate` with the day a task, a completed focus session or a
 * routine launch last kept it.
 */
export function streakKeptToday(streak: StreakProgress, todayKey: string): boolean {
  return streak.lastActiveDate === todayKey;
}
