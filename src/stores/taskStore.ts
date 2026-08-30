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
  deleteTask as deleteTaskCommand,
  ensureRecurringTasks,
  listTaskCategories,
  listTaskRecurrences,
  listTasks,
  updateTask as updateTaskCommand,
} from "@/services/taskService";
import type {
  NewTask,
  Task,
  TaskCategory,
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

  loadView: (view: TaskView) => Promise<void>;
  /** Re-read the current view. Called after every mutation. */
  refresh: () => Promise<void>;

  createTask: (input: NewTask) => Promise<Task>;
  updateTask: (id: number, patch: TaskUpdate) => Promise<Task>;
  setTaskStatus: (id: number, status: TaskStatus) => Promise<Task>;
  /** Flip a task between `todo` and `completed`. */
  toggleTaskCompletion: (id: number) => Promise<void>;
  deleteTask: (id: number) => Promise<void>;

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
  categories: [],
  recurrences: {},
  isLoading: true,
  error: null,
  isQuickAddOpen: false,
  editingTaskId: null,
  revealedTaskId: null,

  async loadView(view) {
    // Switching views clears the old list rather than showing it under the
    // new heading while the read is in flight.
    set({ view, tasks: [], isLoading: true, error: null });
    await read(set, get, view);
  },

  async refresh() {
    await read(set, get, get().view);
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
 */
async function read(set: Set, get: Get, view: TaskView): Promise<void> {
  try {
    await syncRecurringTasks();
  } catch (cause) {
    // Leave the marker unset so the next load tries again.
    console.error("Could not create today's recurring tasks:", cause);
  }

  try {
    const [tasks, recurrences, categories] = await Promise.all([
      listTasks(filterForView(view)),
      listTaskRecurrences(),
      // Categories change rarely; re-read only until we have them.
      get().categories.length > 0 ? get().categories : listTaskCategories(),
    ]);

    // A slower read for a view the user has already navigated away from must
    // not overwrite the newer one.
    if (get().view !== view) return;

    set({
      tasks,
      categories,
      recurrences: byId(recurrences),
      isLoading: false,
      error: null,
    });
  } catch (cause) {
    if (get().view !== view) return;
    set({ isLoading: false, error: String(cause) });
  }
}
