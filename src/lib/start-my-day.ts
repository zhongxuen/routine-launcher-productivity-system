/**
 * Start My Day's rules (development-plan.md sections 21 and 89).
 *
 * ```text
 * ☀️ START MY DAY
 *
 * Tasks today:     7
 * High priority:   2
 * Estimated work:  4h 10m
 *
 * Actions:
 * ✓ Open calendar
 * ✓ Open email
 * ✓ Open task dashboard
 * ✓ Start 10-minute planning session
 *
 * [ START MY DAY ]
 * ```
 *
 * Not a second way of launching anything. The routine is the one set as the
 * start-of-day routine in Settings > Daily (section 52), launched through
 * `routineStore.launchRoutine` like every other launch, and the planning
 * session is an ordinary focus session asked for through `requestFocus`. What
 * lives here is only what is particular to the morning: which routine that
 * is, what the three figures count, and whether today's has already run.
 */

import { isSameDay } from "date-fns";

import { estimatedWork } from "@/lib/analytics-utils";
import { parseTimestamp } from "@/lib/task-utils";
import type { RoutineWithActions } from "@/types/routine";
import type { RoutineRunPlanning } from "@/types/routine-ui";
import type { Task } from "@/types/task";

/**
 * Section 21's "Start 10-minute planning session": what the clock calls it,
 * and how long it runs.
 */
export const PLANNING_SESSION: RoutineRunPlanning = { label: "Planning", minutes: 10 };

/** Section 21's three figures. */
export interface DaySummary {
  /** Today's tasks, less any cancelled — the dashboard's `N` in `x / N completed`. */
  tasksToday: number;
  /** How many of those are already done. */
  completed: number;
  /** Open tasks marked High or Urgent. */
  highPriority: number;
  /** `estimated_minutes` summed over the open tasks. */
  estimatedMinutes: number;
  /** Open tasks with no estimate, which the figure above leaves out. */
  unestimated: number;
}

/**
 * The figures, from the backend's `today` view — the same list the dashboard
 * and Tasks > Today read, carried-over tasks included.
 *
 * High priority counts only what is still open: an urgent task finished at
 * 8am is not something the morning still has to face.
 */
export function daySummary(tasks: Task[]): DaySummary {
  const counted = tasks.filter((task) => task.status !== "cancelled");
  const open = counted.filter((task) => task.status !== "completed");
  const { minutes, unestimated } = estimatedWork(open);

  return {
    tasksToday: counted.length,
    completed: counted.length - open.length,
    highPriority: open.filter((task) => task.priority === "high" || task.priority === "urgent")
      .length,
    estimatedMinutes: minutes,
    unestimated,
  };
}

/**
 * The start-of-day routine, if one is set and still exists.
 *
 * A stored id the routine list does not hold is treated as none. Rust reads a
 * deleted routine's id back as null already; this covers the window that
 * deleted it and has not re-read the settings since.
 */
export function startOfDayRoutine(
  routineId: number | null,
  routines: RoutineWithActions[],
): RoutineWithActions | null {
  if (routineId === null) return null;
  return routines.find((routine) => routine.id === routineId) ?? null;
}

/**
 * Whether the routine was launched today — from Start My Day, its own card,
 * the tray or anywhere else. Read off the routine's own `last_launched_at`,
 * which every launch stamps, so "has the day been started" is a fact about
 * the launches rather than a flag of its own that could disagree with them.
 */
export function launchedToday(routine: RoutineWithActions, now: Date = new Date()): boolean {
  const launched = parseTimestamp(routine.last_launched_at);
  return launched !== null && isSameDay(launched, now);
}
