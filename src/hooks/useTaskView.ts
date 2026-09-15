/**
 * How a task route asks the store for its view.
 *
 * Each of the five views under /tasks (section 15) is one backend query, so a
 * component says which view it is and gets back that view's tasks plus the
 * loading and error state to render around them. Re-reading on mount is what
 * keeps a list correct across a day boundary: `is_overdue` and the Today
 * window are computed against the user's local today when the row is read.
 */

import { useEffect } from "react";

import { useTaskStore } from "@/stores/taskStore";
import type { RepeatPreview, Task, TaskView } from "@/types/task";

export interface TaskViewState {
  tasks: Task[];
  /**
   * Repeating tasks a future day will get but does not have yet (section 53).
   * Only ever non-empty for a `today` view dated after today.
   */
  repeats: RepeatPreview[];
  /** True while the first read of this view is in flight. */
  isLoading: boolean;
  /** A failed read, already in user-presentable form. */
  error: string | null;
  /** Try the read again — wired to the error state's Retry button. */
  reload: () => void;
}

/**
 * @param date For `today` only: the `YYYY-MM-DD` day to show (section 53), or
 *   null for the real today with its carry-over. Pass null rather than
 *   today's own key, since the two are different reads.
 */
export function useTaskView(view: TaskView, date: string | null = null): TaskViewState {
  const loadView = useTaskStore((state) => state.loadView);
  const tasks = useTaskStore((state) => state.tasks);
  const repeats = useTaskStore((state) => state.repeats);
  const loadedView = useTaskStore((state) => state.view);
  const loadedDate = useTaskStore((state) => state.date);
  const isLoading = useTaskStore((state) => state.isLoading);
  const error = useTaskStore((state) => state.error);

  // The store ignores a date on any view but `today`, so the comparison below
  // has to as well.
  const day = view === "today" ? date : null;

  useEffect(() => {
    void loadView(view, day);
  }, [loadView, view, day]);

  // Between the route changing and the effect running, the store still holds
  // the previous view's tasks; showing them under the new heading would be
  // wrong, so they are treated as not-here-yet. Paging to another day is the
  // same case.
  const isCurrent = loadedView === view && loadedDate === day;

  return {
    tasks: isCurrent ? tasks : [],
    repeats: isCurrent ? repeats : [],
    isLoading: isLoading || !isCurrent,
    error: isCurrent ? error : null,
    reload: () => void loadView(view, day),
  };
}
