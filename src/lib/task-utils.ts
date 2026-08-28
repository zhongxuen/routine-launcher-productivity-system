/**
 * Formatting, sorting and grouping helpers for the task views.
 *
 * Everything here works on the wire shapes from `src/types/task.ts` exactly
 * as SQLite returns them: `YYYY-MM-DD` dates, 24-hour `HH:MM` times and UTC
 * `YYYY-MM-DD HH:MM:SS` timestamps.
 *
 * Presentation only. Anything the backend decides — whether a task is
 * overdue, which view it belongs to, when it was completed — is read off the
 * task, never recomputed here, so a component cannot disagree with the
 * database about it.
 */

import { differenceInCalendarDays, format, isValid, parseISO } from "date-fns";

import type { Task, TaskPriority } from "@/types/task";

/* -------------------------------------------------------------------------- */
/* Dates and times                                                            */
/* -------------------------------------------------------------------------- */

/** Today as a `YYYY-MM-DD` key in the user's local timezone. */
export const todayKey = () => format(new Date(), "yyyy-MM-dd");

/** Parse a `YYYY-MM-DD` key as local midnight, or null if it is unusable. */
export function parseDateKey(key: string | null): Date | null {
  if (!key) return null;
  const date = parseISO(key);
  return isValid(date) ? date : null;
}

/**
 * Parse a SQLite UTC timestamp (`YYYY-MM-DD HH:MM:SS`) into a local Date.
 * SQLite writes these without a zone marker, so the `Z` has to be added back.
 */
export function parseTimestamp(timestamp: string | null): Date | null {
  if (!timestamp) return null;
  const date = new Date(`${timestamp.replace(" ", "T")}Z`);
  return isValid(date) ? date : null;
}

/** `"16:00"` becomes `"4:00 PM"`. */
export function formatDueTime(dueTime: string | null): string | null {
  if (!dueTime) return null;
  const [hours, minutes] = dueTime.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;

  const reference = new Date();
  reference.setHours(hours, minutes, 0, 0);
  return format(reference, "h:mm a");
}

/** A UTC timestamp shown as a local clock time, e.g. `"3:42 PM"`. */
export function formatTimestampTime(timestamp: string | null): string | null {
  const date = parseTimestamp(timestamp);
  return date ? format(date, "h:mm a") : null;
}

/** `"Today"`, `"Tomorrow"`, `"Yesterday"`, otherwise `"Sat, Aug 30"`. */
export function formatRelativeDate(dateKey: string | null): string {
  const date = parseDateKey(dateKey);
  if (!date) return "No date";

  const offset = differenceInCalendarDays(date, new Date());
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  return format(date, "EEE, MMM d");
}

/** The long form used as the day heading, e.g. `"Saturday, August 15"`. */
export const formatDayHeading = (date: Date) => format(date, "EEEE, MMMM d");

/**
 * `45` becomes `"45 min"`, `90` becomes `"1h 30m"`. An hour stays `"60 min"`
 * because that is how section 14 writes it.
 */
export function formatDuration(minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes <= 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * `"3 days late"` for an overdue task, otherwise null.
 *
 * Reads the backend's flags rather than re-deriving them from `due_date`: it
 * is the database that decides what counts as overdue (a missed instance of a
 * repeating task, for one, stops counting once the next one arrives).
 */
export function formatOverdue(task: Task): string | null {
  if (!task.is_overdue) return null;
  return task.days_overdue === 1 ? "1 day late" : `${task.days_overdue} days late`;
}

/* -------------------------------------------------------------------------- */
/* Priority                                                                   */
/* -------------------------------------------------------------------------- */

/** Highest first — the order the daily view stacks its groups in. */
export const PRIORITY_ORDER: TaskPriority[] = ["urgent", "high", "normal", "low"];

/** Section 14 shows the group headings shouted; the dot carries the colour. */
export const PRIORITY_HEADINGS: Record<TaskPriority, string> = {
  urgent: "URGENT",
  high: "HIGH PRIORITY",
  normal: "NORMAL",
  low: "LOW",
};

/**
 * Background classes for the priority dot. Section 12 asks for subtle
 * indicators, so a 6px dot is the whole treatment — no chips, no coloured rows.
 */
export const PRIORITY_DOT: Record<TaskPriority, string> = {
  urgent: "bg-priority-urgent",
  high: "bg-priority-high",
  normal: "bg-priority-normal",
  low: "bg-priority-low",
};

const priorityRank = (priority: TaskPriority) => PRIORITY_ORDER.indexOf(priority);

/* -------------------------------------------------------------------------- */
/* Sorting and grouping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Overdue first, then by due time (timed before untimed), then by priority.
 * Sorting is done on a copy — the store's array is never mutated.
 */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
    if (a.due_date !== b.due_date) return (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999");
    if (a.due_time !== b.due_time) return (a.due_time ?? "99:99").localeCompare(b.due_time ?? "99:99");
    if (a.priority !== b.priority) return priorityRank(a.priority) - priorityRank(b.priority);
    return a.id - b.id;
  });
}

export interface TaskGroup<K> {
  key: K;
  tasks: Task[];
}

/**
 * Split into the priority groups of section 14, highest first. Empty groups are
 * dropped so a day with only normal-priority work shows one heading, not four.
 */
export function groupByPriority(tasks: Task[]): TaskGroup<TaskPriority>[] {
  return PRIORITY_ORDER.map((priority) => ({
    key: priority,
    tasks: sortTasks(tasks.filter((task) => task.priority === priority)),
  })).filter((group) => group.tasks.length > 0);
}

/** Group by `due_date`, earliest first. Used by the Upcoming view. */
export function groupByDueDate(tasks: Task[]): TaskGroup<string>[] {
  const buckets = new Map<string, Task[]>();

  for (const task of sortTasks(tasks)) {
    const key = task.due_date ?? "";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(task);
    else buckets.set(key, [task]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => ({ key, tasks: group }));
}

/** Group by completion day, most recent first. Used by the Completed view. */
export function groupByCompletionDate(tasks: Task[]): TaskGroup<string>[] {
  const buckets = new Map<string, Task[]>();

  for (const task of tasks) {
    const completed = parseTimestamp(task.completed_at);
    const key = completed ? format(completed, "yyyy-MM-dd") : "";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(task);
    else buckets.set(key, [task]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, group]) => ({
      key,
      tasks: [...group].sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")),
    }));
}

/** The `"3 / 7 completed"` counts from section 14. */
export function completionCounts(tasks: Task[]) {
  const total = tasks.filter((task) => task.status !== "cancelled").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  return { completed, total };
}
