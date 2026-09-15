/**
 * Typed wrappers around the task and task-category Tauri commands.
 *
 * This is the "Service" layer of React UI -> Service -> Tauri Command ->
 * Rust -> SQLite (development-plan.md section 86): components import from
 * here and never call `invoke` themselves.
 *
 * Every command rejects with a plain, user-presentable string on failure
 * (empty title, malformed date, a category that no longer exists, ...), so
 * callers can surface `String(error)` straight to a toast.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  NewTask,
  NewTaskCategory,
  RepeatPreview,
  Task,
  TaskCategory,
  TaskCategoryUpdate,
  TaskFilter,
  TaskRecurrence,
  TaskStatus,
  TaskUpdate,
} from "@/types/task";

/** Filters minus the view, for the per-view helpers that set it themselves. */
type ViewFilter = Omit<TaskFilter, "view">;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Creates a task and returns it as stored, with the id and timestamps the
 * database assigned. Only `title` is required.
 */
export async function createTask(task: NewTask): Promise<Task> {
  return invoke<Task>("create_task", { task });
}

/** Returns the task, or `null` if it no longer exists. */
export async function getTask(id: number): Promise<Task | null> {
  return invoke<Task | null>("get_task", { id });
}

/**
 * Applies a partial update and returns the task as stored. Omitted fields
 * are left alone and `null` clears a field — see {@link TaskUpdate}.
 */
export async function updateTask(
  id: number,
  updates: TaskUpdate,
): Promise<Task> {
  return invoke<Task>("update_task", { id, updates });
}

/** Permanently deletes the task. Rejects if it is already gone. */
export async function deleteTask(id: number): Promise<void> {
  return invoke<void>("delete_task", { id });
}

/**
 * Lists tasks, newest-completed-first for the Completed view and in
 * work-through order (due date, then time of day, then priority, undated
 * last) for every other view. Passing no filter lists everything.
 */
export async function listTasks(filter: TaskFilter = {}): Promise<Task[]> {
  return invoke<Task[]>("list_tasks", { filter });
}

/**
 * The Today view (section 15): tasks due today, plus anything still
 * unfinished from an earlier day.
 *
 * Carried-over tasks come back first — longest-overdue at the top — with
 * `is_overdue` set and `days_overdue` telling you how late they are, so the
 * UI can mark them clearly rather than mixing them in with today's work.
 */
export async function listTodayTasks(filter: ViewFilter = {}): Promise<Task[]> {
  return listTasks({ ...filter, view: "today" });
}

/**
 * One day's tasks: those due on `date` (`YYYY-MM-DD`), for section 53's
 * Yesterday / Tomorrow on Tasks > Today.
 *
 * Unlike {@link listTodayTasks}, nothing is carried over from earlier days:
 * this lists what was due on that day, not what is still owed. Pass
 * `statuses` to narrow it the way `TaskFilter.statuses` does.
 */
export async function listTasksForDate(
  date: string,
  statuses?: TaskStatus[],
): Promise<Task[]> {
  return invoke<Task[]>("list_tasks_for_date", { date, statuses });
}

/**
 * The repeating tasks a future `date` will get that have not been created
 * yet: the read-only Repeats group. Writes nothing (the instances are still
 * only created on their own day by {@link ensureRecurringTasks}), and returns
 * an empty list for today and earlier.
 */
export async function listRepeatsForDate(date: string): Promise<RepeatPreview[]> {
  return invoke<RepeatPreview[]>("list_repeats_for_date", { date });
}

/**
 * Only the overdue tasks that Today carries over — past due and still open.
 * Useful for a count or badge without filtering the Today list by hand.
 */
export async function listOverdueTasks(
  filter: ViewFilter = {},
): Promise<Task[]> {
  return listTasks({ ...filter, view: "overdue" });
}

/** Tasks due on any date after today. */
export async function listUpcomingTasks(
  filter: ViewFilter = {},
): Promise<Task[]> {
  return listTasks({ ...filter, view: "upcoming" });
}

/** Tasks with no due date — the unscheduled pile. */
export async function listInboxTasks(filter: ViewFilter = {}): Promise<Task[]> {
  return listTasks({ ...filter, view: "inbox" });
}

/** Completed task history, newest first. */
export async function listCompletedTasks(
  filter: ViewFilter = {},
): Promise<Task[]> {
  return listTasks({ ...filter, view: "completed" });
}

/**
 * One task per repeating series (section 23) rather than every instance it
 * has produced: each schedule's most recent task. That is the live row — so
 * editing it changes both the schedule and what tomorrow's instance says.
 */
export async function listRecurringTasks(
  filter: ViewFilter = {},
): Promise<Task[]> {
  return listTasks({ ...filter, view: "recurring" });
}

/**
 * Tasks in one category, or — when `categoryId` is `null` — the tasks with
 * no category at all.
 */
export async function listTasksByCategory(
  categoryId: number | null,
  filter: TaskFilter = {},
): Promise<Task[]> {
  return listTasks({ ...filter, category_id: categoryId });
}

/** Tasks in the given status, or in any of the given statuses. */
export async function listTasksByStatus(
  status: TaskStatus | TaskStatus[],
  filter: TaskFilter = {},
): Promise<Task[]> {
  return listTasks({
    ...filter,
    statuses: Array.isArray(status) ? status : [status],
  });
}

/**
 * Moves a task to a new status. The backend keeps `completed_at` in step,
 * so nothing else needs to be sent.
 */
export async function setTaskStatus(
  id: number,
  status: TaskStatus,
): Promise<Task> {
  return updateTask(id, { status });
}

/** Marks a task completed and stamps its completion time (section 17). */
export async function completeTask(id: number): Promise<Task> {
  return setTaskStatus(id, "completed");
}

/** Sends a completed task back to Todo and clears its completion time. */
export async function reopenTask(id: number): Promise<Task> {
  return setTaskStatus(id, "todo");
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

/**
 * Brings today's repeating tasks into existence and returns the ones that
 * were missing — section 23's "the system automatically creates/activates the
 * appropriate task for the day".
 *
 * Safe to call on every load: a series that already has today's task is left
 * alone, so this is idempotent within a day and the caller does not have to
 * remember when it last ran.
 *
 * Only today is generated. Days the app was closed are not back-filled (a
 * backlog nobody can act on) and future days are not pre-created (rows the
 * user would have to maintain by hand).
 */
export async function ensureRecurringTasks(): Promise<Task[]> {
  return invoke<Task[]>("ensure_recurring_tasks");
}

/**
 * Every repeat schedule. The Recurring view keeps these keyed by id so a task
 * can be labelled from its `recurrence_id` without a call per row.
 */
export async function listTaskRecurrences(): Promise<TaskRecurrence[]> {
  return invoke<TaskRecurrence[]>("list_task_recurrences");
}

/** Returns the schedule, or `null` if it no longer exists. */
export async function getTaskRecurrence(
  id: number,
): Promise<TaskRecurrence | null> {
  return invoke<TaskRecurrence | null>("get_task_recurrence", { id });
}

/**
 * Ends a series. The tasks it already produced are kept and become ordinary
 * one-off tasks — stopping a repeat should not erase the work it made.
 *
 * Prefer `updateTask(id, { recurrence: null })` when you have the task in
 * hand; it does the same thing and returns the updated task.
 */
export async function deleteTaskRecurrence(id: number): Promise<void> {
  return invoke<void>("delete_task_recurrence", { id });
}

// ---------------------------------------------------------------------------
// Task categories
// ---------------------------------------------------------------------------

/**
 * Lists every category: the seeded defaults from section 13 first, in that
 * order, then any the user has created.
 */
export async function listTaskCategories(): Promise<TaskCategory[]> {
  return invoke<TaskCategory[]>("list_task_categories");
}

/** Returns the category, or `null` if it no longer exists. */
export async function getTaskCategory(
  id: number,
): Promise<TaskCategory | null> {
  return invoke<TaskCategory | null>("get_task_category", { id });
}

/** Creates a custom category. Rejects if the name is blank or taken. */
export async function createTaskCategory(
  category: NewTaskCategory,
): Promise<TaskCategory> {
  return invoke<TaskCategory>("create_task_category", { category });
}

export async function updateTaskCategory(
  id: number,
  updates: TaskCategoryUpdate,
): Promise<TaskCategory> {
  return invoke<TaskCategory>("update_task_category", { id, updates });
}

/**
 * Deletes a category. Tasks that used it are kept and become uncategorised
 * rather than being deleted along with it.
 */
export async function deleteTaskCategory(id: number): Promise<void> {
  return invoke<void>("delete_task_category", { id });
}
