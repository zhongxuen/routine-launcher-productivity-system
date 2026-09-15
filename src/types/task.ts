/**
 * Task and task-category types.
 *
 * These mirror the Rust payloads in `src-tauri/src/services/tasks.rs` and
 * `src-tauri/src/services/task_categories.rs` exactly, field name for field
 * name, so a value crossing the `invoke` boundary needs no reshaping in
 * either direction. Field names stay snake_case to match the columns in
 * development-plan.md section 58.
 *
 * Dates are `YYYY-MM-DD` and times are 24-hour `HH:MM`. The `created_at`,
 * `updated_at` and `completed_at` timestamps are UTC `YYYY-MM-DD HH:MM:SS`
 * strings written by SQLite, so convert them to local time before display.
 */

import type { TaskReminder } from "./notification";

/** The four statuses from development-plan.md section 11. */
export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Display names for the wire values above. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * The four priority levels from development-plan.md section 12, ordered
 * lowest to highest.
 */
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/**
 * The task views from development-plan.md section 15, plus "overdue".
 *
 * - `today` — due today, **plus** anything still unfinished from an earlier
 *   day, so a task you forgot to do (or forgot to tick off) is carried
 *   forward instead of disappearing at midnight. Overdue ones sort first and
 *   carry `is_overdue` / `days_overdue`. A missed instance of a repeating
 *   task is the exception: it drops out once the next one arrives.
 * - `overdue` — only those carried-over tasks, for a count or badge.
 * - `recurring` — one row per repeating series rather than every instance it
 *   has produced: each schedule's most recent task (see
 *   {@link TaskRecurrence}).
 */
export const TASK_VIEWS = [
  "all",
  "today",
  "upcoming",
  "inbox",
  "completed",
  "overdue",
  "recurring",
] as const;

export type TaskView = (typeof TASK_VIEWS)[number];

/**
 * A task exactly as stored (section 58), plus the derived `is_overdue` and
 * `days_overdue` flags.
 */
export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category_id: number | null;
  /** `YYYY-MM-DD`, or null for an Inbox task with no scheduled date. */
  due_date: string | null;
  /** 24-hour `HH:MM`. Only ever set when `due_date` is set. */
  due_time: string | null;
  estimated_minutes: number | null;
  /**
   * The routine this task starts with (section 18), or null. Look it up in
   * the routine store to draw the icon and name, and to launch it.
   *
   * Cleared by the database if the routine is deleted, so a task never points
   * at a workspace that is no longer there.
   */
  routine_id: number | null;
  /**
   * The repeating series this task belongs to, or null for a one-off. Look
   * the rule up in the store's `recurrences` map to label it.
   *
   * Every day's instance is a separate task sharing this id; the newest one
   * is what the Recurring view lists and what the next day is cloned from.
   */
  recurrence_id: number | null;
  created_at: string;
  updated_at: string;
  /**
   * Set by the backend when the task enters `completed` and cleared when it
   * leaves again — never sent by the frontend.
   */
  completed_at: string | null;
  /**
   * True when the due date has passed and the task is still `todo` or
   * `in_progress`. Completing or cancelling a late task clears it — a
   * finished task is done, not overdue — and so does a repeating task's next
   * instance arriving, so a skipped habit does not stack up a row per day.
   *
   * Computed by the backend against the user's local today on every read, so
   * never derive this from `due_date` in a component. It is a snapshot from
   * when the row was read: a list left on screen across midnight needs
   * re-fetching to stay accurate.
   */
  is_overdue: boolean;
  /**
   * How many days past due the task is, or 0 when it is not overdue. 1 means
   * it was due yesterday — use it for the "3 days late" style of label.
   */
  days_overdue: number;
  /**
   * Seconds of focus actually recorded against this task (section 17's
   * "Actual focus time", section 19's "Focus: 43 minutes"), summed over every
   * focus session that named it.
   *
   * `0` is a measured zero — nobody has focused on this task — rather than a
   * missing figure, which is why it is a number and not `number | null`.
   * Sessions still running are not in it: they have no duration yet, so the
   * figure grows when a session *ends*, not while it runs. Like `is_overdue`
   * it is computed on read, so a list on screen while a session finishes needs
   * re-fetching to catch up — which `useFocusLifecycle` does for it.
   *
   * Format it with `formatFocusLength` from `@/lib/focus-utils`, the same
   * function the focus history uses, so a length reads the same wherever it
   * appears.
   */
  focus_seconds: number;
  /**
   * The reminder set on this task (section 24), or null if nobody asked to be
   * reminded about it.
   *
   * Read-only from here: it is not a field of {@link TaskUpdate}, because
   * whether a reminder is even valid depends on the due date and time the
   * same edit might be changing. Set one with `setTaskReminder` from
   * `@/services/notificationService`, which returns the task back with this
   * filled in.
   */
  reminder: TaskReminder | null;
}

/**
 * Fields accepted when creating a task. Only `title` is required, so
 * quick-add (section 16) can post a title on its own.
 *
 * `recurrence_id` is not settable: pass `recurrence` and the backend creates
 * the rule and links it, so the UI can never reference a rule that is not
 * really there. `routine_id` names a routine that already exists, so it is
 * passed as an id and rejected if the routine is gone.
 */
export interface NewTask {
  title: string;
  description?: string | null;
  /** Defaults to `"todo"`. */
  status?: TaskStatus;
  /** Defaults to `"normal"`. */
  priority?: TaskPriority;
  category_id?: number | null;
  due_date?: string | null;
  /** Requires `due_date` to be set as well. */
  due_time?: string | null;
  /** Must be at least 1. */
  estimated_minutes?: number | null;
  /** The routine this task starts with (section 18). */
  routine_id?: number | null;
  /**
   * Makes this a repeating task (section 23). The backend snaps `due_date` to
   * the schedule's first occurrence, so "every weekday" added on a Saturday
   * comes back dated Monday.
   */
  recurrence?: NewTaskRecurrence | null;
}

/**
 * A partial update. Every field is three-state:
 *
 * - omitted (or `undefined`) — leave the column as it is
 * - `null` — clear the column
 * - a value — set the column
 *
 * `completed_at` is not listed because it is derived: set `status` to
 * `"completed"` and the backend stamps it, move away from `"completed"` and
 * the backend clears it.
 */
export interface TaskUpdate {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  category_id?: number | null;
  due_date?: string | null;
  due_time?: string | null;
  estimated_minutes?: number | null;
  /**
   * Three-state like the rest: omitted leaves the assignment alone, an id
   * assigns that routine, and `null` unassigns it. Unassigning only breaks
   * the link — the routine itself is untouched.
   */
  routine_id?: number | null;
  /**
   * Three-state like the rest: omitted leaves the schedule alone, a rule sets
   * or re-times it, and `null` stops the task repeating. Stopping a repeat
   * keeps every task the series already produced — they simply become
   * ordinary one-off tasks.
   */
  recurrence?: NewTaskRecurrence | null;
}

/**
 * A repeating task that a future day will get but does not have yet: one row
 * of the read-only Repeats group when Tasks > Today is looking at tomorrow
 * (development-plan.md section 53).
 *
 * Not a {@link Task}, because none exists yet. `ensureRecurringTasks` only
 * creates today's instance, so tomorrow's is created on the day. The fields
 * are what that instance will be cloned with, taken from the series' most
 * recent task, and there is no id, status or checkbox, because there is
 * nothing to tick.
 */
export interface RepeatPreview {
  /** Look it up in the store's `recurrences` map to label the schedule. */
  recurrence_id: number;
  title: string;
  priority: TaskPriority;
  category_id: number | null;
  /** 24-hour `HH:MM`, carried over from the series. */
  due_time: string | null;
  estimated_minutes: number | null;
  routine_id: number | null;
}

/** Filters for `listTasks`. Every field combines with AND. */
export interface TaskFilter {
  /** Date-based view. Defaults to `"all"`. */
  view?: TaskView;
  /** Keep only these statuses. An empty array is treated as no filter. */
  statuses?: TaskStatus[];
  priority?: TaskPriority;
  /** A category id, or `null` for uncategorised tasks only. */
  category_id?: number | null;
  /** Cap the number of rows returned. */
  limit?: number;
}

/**
 * A task category. The seven defaults from development-plan.md section 13
 * are seeded on first run and are ordinary rows from then on — they can be
 * renamed, recoloured or deleted like any user-created category.
 */
export interface TaskCategory {
  id: number;
  name: string;
  /** Hex colour, e.g. `#3b82f6`. */
  color: string | null;
  /** A lucide-react icon name, e.g. `briefcase`. */
  icon: string | null;
  created_at: string;
}

export interface NewTaskCategory {
  /** Must be unique, case-sensitively. */
  name: string;
  color?: string | null;
  icon?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Recurrence (development-plan.md section 23)                                */
/* -------------------------------------------------------------------------- */

/**
 * The five repeat options from section 23. They are deliberately
 * non-overlapping, so each one means exactly one thing:
 *
 * - `daily` — every day
 * - `weekdays` — Monday to Friday
 * - `weekly` — the chosen `days_of_week`, every `interval` weeks
 * - `monthly` — `day_of_month`, every `interval` months
 * - `custom` — every `interval` days
 */
export const RECURRENCE_FREQUENCIES = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "custom",
] as const;

export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** Names for the repeat picker. */
export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom",
};

/** Weekday tokens as stored, in calendar order starting on Sunday. */
export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  SUN: "Sun",
  MON: "Mon",
  TUE: "Tue",
  WED: "Wed",
  THU: "Thu",
  FRI: "Fri",
  SAT: "Sat",
};

/** A repeat schedule as stored. Mirrors the `task_recurrence` row. */
export interface TaskRecurrence {
  id: number;
  frequency: RecurrenceFrequency;
  /** "every N weeks/months/days". Always 1 for `daily` and `weekdays`. */
  interval: number;
  /** Weekday tokens for `weekly`; empty means "the start date's weekday". */
  days_of_week: Weekday[];
  /** 1-31 for `monthly`; a short month falls back to its last day. */
  day_of_month: number | null;
  /**
   * The first date the rule fires — the backend snaps this forward from
   * whatever the task was dated, so it is always a real occurrence.
   */
  start_date: string;
  /** Last date the rule may fire, or null for "forever". */
  end_date: string | null;
  created_at: string;
}

/**
 * A schedule as sent when creating or editing a task. Only `frequency` is
 * required; the rest default from the task's due date.
 */
export interface NewTaskRecurrence {
  frequency: RecurrenceFrequency;
  interval?: number | null;
  days_of_week?: Weekday[] | null;
  day_of_month?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

/** Partial update; `null` clears `color`/`icon`, omitted leaves them alone. */
export interface TaskCategoryUpdate {
  name?: string;
  color?: string | null;
  icon?: string | null;
}
