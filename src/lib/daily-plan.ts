/**
 * PLAN TODAY's rules (development-plan.md sections 20 and 51).
 *
 * ```text
 * PLAN TODAY
 *
 * Saturday, August 15
 *
 * Top priorities:          Other tasks:
 * 1. Finish project report □ Reply to emails
 * 2. Complete database     □ Organize Downloads
 * 3. Study JavaScript      □ Review notes
 *
 * Estimated workload: 4h 10m      Available focus time: 4h
 *
 * [ Start My Day ]
 * ```
 *
 * Section 20 says what the figures are for: "a quick overview of whether
 * their planned workload is realistic". So they are compared, and a day that
 * does not fit gets one quiet sentence. Nothing is blocked, moved or
 * rescheduled.
 *
 * Only the priorities are stored (`daily_plans`). Everything here works on
 * the Today view the panel sits above, and on the clock, so the panel and the
 * list under it cannot disagree about what today holds.
 */

import { estimatedWork, hasEstimate } from "@/lib/analytics-utils";
import type { DailySettings } from "@/types/settings";
import type { Task } from "@/types/task";

/** Neither finished nor abandoned: still part of the day's work. */
export const isOpenTask = (task: Task): boolean =>
  task.status !== "completed" && task.status !== "cancelled";

/** The day's tasks, split the way section 51 draws them. */
export interface PlanSplit {
  /** The picked tasks still on today's list, rank 1 first. */
  priorities: Task[];
  /** Everything else on today's list, in the list's own order. */
  others: Task[];
}

/**
 * Splits today's list by the stored picks.
 *
 * A picked id that is not on the list is dropped rather than shown. That is a
 * task moved to another day since it was picked (a deleted one has already
 * gone, by the table's cascade), and today's plan is about today's list. The
 * next save leaves it out, because it saves {@link PlanSplit.priorities}.
 */
export function splitPlan(tasks: Task[], taskIds: number[]): PlanSplit {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const priorities = taskIds.flatMap((id) => byId.get(id) ?? []);
  const picked = new Set(priorities.map((task) => task.id));

  return {
    priorities,
    others: tasks.filter((task) => !picked.has(task.id) && task.status !== "cancelled"),
  };
}

/** Section 51's "Estimated workload". */
export interface Workload {
  /** `estimated_minutes` summed over the open tasks. */
  minutes: number;
  /**
   * The open tasks that have no estimate, which `minutes` leaves out. They
   * are named rather than counted as zero, because "3h" over a day with two
   * unestimated tasks in it is not a 3h day.
   */
  unestimated: Task[];
}

/**
 * The work left today: the same sum as Start My Day's "Estimated work"
 * (`estimatedWork`), with the unestimated tasks kept rather than counted.
 */
export function workload(tasks: Task[]): Workload {
  const open = tasks.filter(isOpenTask);
  return {
    minutes: estimatedWork(open).minutes,
    unestimated: open.filter((task) => !hasEstimate(task)),
  };
}

/** Where the clock is against the day's hours from Settings > Daily. */
export type DayPhase = "before" | "during" | "after";

/** Section 20's "Available focus time". */
export interface TimeLeft {
  /** Whole minutes from {@link TimeLeft.from} to {@link TimeLeft.until}. */
  minutes: number;
  /** Now, or the day's start if that is still to come. */
  from: Date;
  /** The day's end, today. */
  until: Date;
  phase: DayPhase;
}

/**
 * The time left in today's working day: from now, or from the day's start if
 * it has not come yet, to the day's end.
 *
 * Focus already done today is not subtracted. It happened before now, so it
 * is already outside this window, and taking it off again would count the
 * morning twice: two hours focused by 1 PM on a day that ends at 6 PM would
 * read as three hours left, and a busy day would reach zero long before its
 * end.
 */
export function timeLeftToday(
  { dayStartTime, dayEndTime }: Pick<DailySettings, "dayStartTime" | "dayEndTime">,
  now: Date,
): TimeLeft {
  const start = atTime(now, dayStartTime);
  const until = atTime(now, dayEndTime);
  const from = now < start ? start : now;
  const phase: DayPhase = now < start ? "before" : now < until ? "during" : "after";

  return {
    minutes: Math.max(0, Math.floor((until.getTime() - from.getTime()) / 60_000)),
    from,
    until,
    phase,
  };
}

/** `now`'s date at a stored 24-hour `HH:MM`. */
function atTime(now: Date, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  return at;
}

/**
 * The note's figure: how much the estimated work exceeds the time left,
 * rounded to five minutes because the note says "about". Null when it fits,
 * or when it is over by less than five minutes, which no estimate is precise
 * enough to be.
 */
export function overrunMinutes(workloadMinutes: number, availableMinutes: number): number | null {
  const rounded = Math.round((workloadMinutes - availableMinutes) / 5) * 5;
  return rounded >= 5 ? rounded : null;
}
