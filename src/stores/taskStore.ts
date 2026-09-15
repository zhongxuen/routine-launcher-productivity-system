/**
 * Task store — the single place the UI talks to the task backend.
 *
 * Every action goes through `src/services/taskService.ts` to SQLite; nothing
 * here holds an opinion about task data that the database does not also hold.
 * That is what makes the views live: after any mutation the current view is
 * re-read, so derived server-side values (`completed_at`, `is_overdue`,
 * `days_overdue`, a recurring task's snapped due date) are always the
 * database's answer rather than one guessed in the browser.
 *
 * `tasks` holds **one view at a time** — whichever the visible route asked
 * for — because the filtering and ordering that decide a view belong to the
 * backend query (development-plan.md sections 14-15), not to the components.
 * `useTaskView` is how a route asks for one.
 *
 * Section 53's Yesterday / Tomorrow is still that one view. `view` stays
 * `today` and `date` names the day it is about, so paging between days swaps
 * what the single view holds rather than opening a second one beside it (the
 * trap `UpcomingTasks.tsx` describes).
 *
 * Every write also announces itself to the app's other windows — the compact
 * popup of section 25 is a second webview with its own copy of this store, so
 * a task ticked off in one has to reach the other. See
 * `src/lib/window-sync.ts`; the announcement carries no data, only the fact
 * that a re-read is worth making.
 */

import { create, type StoreApi } from "zustand";

import { todayKey } from "@/lib/task-utils";
import { emitProgressChanged } from "@/lib/progress-events";
import { announceDataChanged } from "@/lib/window-sync";
import {
  createTask as createTaskCommand,
  createTaskCategory,
  deleteTask as deleteTaskCommand,
  deleteTaskCategory,
  ensureRecurringTasks,
  listRepeatsForDate,
  listTaskCategories,
  listTaskRecurrences,
  listTasks,
  listTasksForDate,
  updateTask as updateTaskCommand,
  updateTaskCategory,
} from "@/services/taskService";
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
  TaskView,
} from "@/types/task";

/** Statuses that count as "still to do" — everything but done and abandoned. */
const OPEN_STATUSES: TaskStatus[] = ["todo", "in_progress"];

/** How much completed history the Completed view reads back. */
const COMPLETED_HISTORY_LIMIT = 200;

/**
 * How long a revealed task stays called out before the list goes back to
 * looking like a list.
 *
 * Long enough to survive the read that follows a navigation and still be on
 * screen when the user's eyes arrive; short enough that the highlight is
 * clearly an answer to something they just did rather than a state the row is
 * in. It is a pointer, not a selection — nothing else depends on it.
 */
const REVEAL_MS = 6_000;

/**
 * The filter behind each view.
 *
 * Today keeps completed tasks so section 14's "3 / 7 completed" line has a
 * denominator; the other open views drop them, because a finished task is not
 * something Upcoming or Inbox still owes you. Cancelled tasks are never
 * listed anywhere.
 */
function filterForView(view: TaskView): TaskFilter {
  switch (view) {
    case "today":
      return { view, statuses: [...OPEN_STATUSES, "completed"] };
    case "upcoming":
    case "inbox":
    case "overdue":
      return { view, statuses: OPEN_STATUSES };
    case "completed":
      return { view, limit: COMPLETED_HISTORY_LIMIT };
    case "recurring":
      return { view };
    default:
      return { view };
  }
}

interface TaskState {
  /** The tasks of the currently loaded view, in the backend's order. */
  tasks: Task[];
  /** Which view `tasks` holds, so a refresh after a mutation re-reads it. */
  view: TaskView;
  /**
   * The day a `today` view is about (`YYYY-MM-DD`), or null for the real
   * today, which keeps its carry-over of unfinished work from earlier days.
   * A dated view lists only what is due on that day. Always null for every
   * other view.
   */
  date: string | null;
  /**
   * Repeating tasks a future `date` will get but does not have yet, shown as
   * the read-only Repeats group. Empty unless `date` is after today.
   */
  repeats: RepeatPreview[];
  categories: TaskCategory[];
  /** Repeat schedules keyed by id, for labelling a task's `recurrence_id`. */
  recurrences: Record<number, TaskRecurrence>;

  /** True only while a view is being read for the first time. */
  isLoading: boolean;
  /** A failed *read*. Mutations reject instead, so the caller can toast. */
  error: string | null;

  /**
   * Whether the quick-add form (section 16) is open. It lives in the store
   * rather than in `Tasks.tsx` so the Ctrl+N handler, the "+ Add Task" button
   * and — later — the dashboard and the tray popup can all reach it.
   */
  isQuickAddOpen: boolean;
  /** The task the edit dialog is open on, if any. */
  editingTaskId: number | null;
  /**
   * The task the user has just been pointed at — a reminder's Start Task
   * (section 24), and whatever else later needs to say "this one".
   *
   * Held here rather than in the route because the row that has to react to
   * it may not be mounted yet: the reveal is set, the view navigates, the
   * read lands, and the row highlights itself on mount. It clears itself
   * after {@link REVEAL_MS}.
   */
  revealedTaskId: number | null;

  /**
   * Switch to a view. `date` applies to `today` only (section 53) and is
   * ignored for the others. Leave it out, or pass null, for the real today.
   */
  loadView: (view: TaskView, date?: string | null) => Promise<void>;
  /** Re-read the current view. Called after every mutation. */
  refresh: () => Promise<void>;

  createTask: (input: NewTask) => Promise<Task>;
  updateTask: (id: number, patch: TaskUpdate) => Promise<Task>;
  setTaskStatus: (id: number, status: TaskStatus) => Promise<Task>;
  /** Flip a task between `todo` and `completed`. */
  toggleTaskCompletion: (id: number) => Promise<void>;
  deleteTask: (id: number) => Promise<void>;

  /**
   * Re-read the category list. Every category change below ends with this,
   * so each select and row rendered from `categories` shows the new name the
   * moment it is saved. A failed re-read is logged and leaves the old list:
   * the write it follows has already landed.
   */
  loadCategories: () => Promise<void>;
  createCategory: (input: NewTaskCategory) => Promise<TaskCategory>;
  updateCategory: (id: number, patch: TaskCategoryUpdate) => Promise<TaskCategory>;
  /** Tasks that used the category are kept, with no category. */
  deleteCategory: (id: number) => Promise<void>;

  setQuickAddOpen: (open: boolean) => void;
  openQuickAdd: () => void;
  closeQuickAdd: () => void;
  openTaskEditor: (id: number) => void;
  closeTaskEditor: () => void;
  /** Call the row out, or pass null to stop. */
  revealTask: (id: number | null) => void;
}

/**
 * The local day today's repeating tasks were last materialised for.
 *
 * `ensureRecurringTasks` is idempotent within a day, so this is only about
 * not making a round trip on every view switch. It deliberately lives outside
 * the store: it is bookkeeping, not state anything renders. Comparing against
 * the *date* rather than a boolean is what makes a window left open overnight
 * pick up the new day's tasks on its next load.
 */
let recurrenceSyncedOn: string | null = null;

async function syncRecurringTasks(): Promise<void> {
  const today = todayKey();
  if (recurrenceSyncedOn === today) return;

  await ensureRecurringTasks();
  recurrenceSyncedOn = today;
}

/**
 * The timer clearing the current reveal, outside the store because it is
 * bookkeeping rather than anything rendered — the same reason
 * `recurrenceSyncedOn` lives out here.
 */
let revealTimer: ReturnType<typeof setTimeout> | null = null;

/** Rules keyed by id, so a row can be labelled without a call per task. */
const byId = (rules: TaskRecurrence[]): Record<number, TaskRecurrence> =>
  Object.fromEntries(rules.map((rule) => [rule.id, rule]));

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  view: "today",
  date: null,
  repeats: [],
  categories: [],
  recurrences: {},
  isLoading: true,
  error: null,
  isQuickAddOpen: false,
  editingTaskId: null,
  revealedTaskId: null,

  async loadView(view, date = null) {
    const day = view === "today" ? date : null;
    // Switching views clears the old list rather than showing it under the
    // new heading while the read is in flight. Another day counts as another
    // view here: yesterday's rows under tomorrow's heading would be wrong.
    set({ view, date: day, tasks: [], repeats: [], isLoading: true, error: null });
    await read(set, get, view, day);
  },

  async refresh() {
    await read(set, get, get().view, get().date);
  },

  async createTask(input) {
    const created = await createTaskCommand(input);
    await get().refresh();
    announceDataChanged("tasks");
    return created;
  },

  async updateTask(id, patch) {
    const updated = await updateTaskCommand(id, patch);
    await get().refresh();
    announceDataChanged("tasks");
    // Section 94's last arrow. `update` awards section 43's +10 the moment a
    // task enters `completed`, so the figures on the dashboard are already
    // out of date by the time this returns — see `src/lib/progress-events.ts`
    // for why they are told rather than read from here.
    emitProgressChanged();
    return updated;
  },

  async setTaskStatus(id, status) {
    return get().updateTask(id, { status });
  },

  async toggleTaskCompletion(id) {
    const task = get().tasks.find((candidate) => candidate.id === id);
    if (!task) return;

    // The backend owns `completed_at`: entering `completed` stamps it and
    // leaving clears it, so the status is the only thing to send.
    await get().setTaskStatus(id, task.status === "completed" ? "todo" : "completed");
  },

  async deleteTask(id) {
    await deleteTaskCommand(id);
    await get().refresh();
    announceDataChanged("tasks");
  },

  async loadCategories() {
    try {
      set({ categories: await listTaskCategories() });
    } catch (cause) {
      console.error("Could not re-read the task categories:", cause);
    }
  },

  async createCategory(input) {
    const created = await createTaskCategory(input);
    await get().loadCategories();
    return created;
  },

  async updateCategory(id, patch) {
    const updated = await updateTaskCategory(id, patch);
    await get().loadCategories();
    return updated;
  },

  async deleteCategory(id) {
    await deleteTaskCategory(id);
    await get().loadCategories();
    // The database has just set `category_id` to NULL on every task that used
    // it (`ON DELETE SET NULL`), so the loaded rows are out of date too — here
    // and in any other window holding them.
    await get().refresh();
    announceDataChanged("tasks");
  },

  setQuickAddOpen: (open) => set({ isQuickAddOpen: open }),
  openQuickAdd: () => set({ isQuickAddOpen: true }),
  closeQuickAdd: () => set({ isQuickAddOpen: false }),
  openTaskEditor: (id) => set({ editingTaskId: id }),
  closeTaskEditor: () => set({ editingTaskId: null }),

  revealTask: (id) => {
    if (revealTimer !== null) clearTimeout(revealTimer);
    revealTimer = null;

    set({ revealedTaskId: id });
    if (id === null) return;

    revealTimer = setTimeout(() => {
      revealTimer = null;
      // A second reveal in the meantime owns the highlight now; clearing it
      // would put out a light somebody else just turned on.
      if (get().revealedTaskId === id) set({ revealedTaskId: null });
    }, REVEAL_MS);
  },
}));


type Set = StoreApi<TaskState>["setState"];
type Get = StoreApi<TaskState>["getState"];

/**
 * Reads one view plus the reference data the rows are rendered against.
 *
 * Recurring tasks for today are materialised first so a fresh instance shows
 * up in the very first list the user sees, not on the next refresh.
 *
 * A failed recurrence sync is logged rather than surfaced: the tasks that
 * already exist are still worth showing, and the sync is retried on the next
 * load anyway. A failed *list* is the error the view reports.
 *
 * A dated Today reads that one day's tasks instead of the carry-over view,
 * with the same statuses, and asks the backend which repeats the day will
 * get. The backend returns none for today or earlier, so that call makes no
 * judgement of its own about the date.
 */
async function read(set: Set, get: Get, view: TaskView, date: string | null): Promise<void> {
  try {
    await syncRecurringTasks();
  } catch (cause) {
    // Leave the marker unset so the next load tries again.
    console.error("Could not create today's recurring tasks:", cause);
  }

  const filter = filterForView(view);
  // Both keys, because another day of `today` is another view as far as a
  // late read is concerned.
  const isStale = () => get().view !== view || get().date !== date;

  try {
    const [tasks, repeats, recurrences, categories] = await Promise.all([
      date === null ? listTasks(filter) : listTasksForDate(date, filter.statuses),
      date === null ? [] : listRepeatsForDate(date),
      listTaskRecurrences(),
      // Read only until we have them: every category change re-reads them
      // itself (`loadCategories`), so a view read has nothing to add.
      get().categories.length > 0 ? null : listTaskCategories(),
    ]);

    // A slower read for a view the user has already navigated away from must
    // not overwrite the newer one.
    if (isStale()) return;

    set({
      tasks,
      repeats,
      // Only a list this read fetched is written back. Writing back the one
      // it started from could put a category deleted mid-read back on screen.
      ...(categories ? { categories } : {}),
      recurrences: byId(recurrences),
      isLoading: false,
      error: null,
    });
  } catch (cause) {
    if (isStale()) return;
    set({ isLoading: false, error: String(cause) });
  }
}
