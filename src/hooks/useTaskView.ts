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
import type { Task, TaskView } from "@/types/task";

export interface TaskViewState {
  tasks: Task[];
  /** True while the first read of this view is in flight. */
  isLoading: boolean;
  /** A failed read, already in user-presentable form. */
  error: string | null;
  /** Try the read again — wired to the error state's Retry button. */
  reload: () => void;
}

export function useTaskView(view: TaskView): TaskViewState {
  const loadView = useTaskStore((state) => state.loadView);
  const tasks = useTaskStore((state) => state.tasks);
  const loadedView = useTaskStore((state) => state.view);
  const isLoading = useTaskStore((state) => state.isLoading);
  const error = useTaskStore((state) => state.error);

  useEffect(() => {
    void loadView(view);
  }, [loadView, view]);

  // Between the route changing and the effect running, the store still holds
  // the previous view's tasks; showing them under the new heading would be
  // wrong, so they are treated as not-here-yet.
  const isCurrent = loadedView === view;

  return {
    tasks: isCurrent ? tasks : [],
    isLoading: isLoading || !isCurrent,
    error: isCurrent ? error : null,
    reload: () => void loadView(view),
  };
}
