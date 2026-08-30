import AsyncBody from "@/components/common/states/AsyncBody";

import TaskListSkeleton from "./TaskListSkeleton";

interface TaskViewBodyProps {
  isLoading: boolean;
  /** A failed read, already user-presentable. */
  error: string | null;
  onRetry: () => void;
  /** True when the read succeeded but produced nothing to show. */
  isEmpty: boolean;
  emptyTitle: string;
  emptyHint?: string;
  /** Something to do about the empty view — quick-add, a link to the builder. */
  emptyAction?: React.ReactNode;
  /** The list itself, rendered only when there is something in it. */
  children: React.ReactNode;
}

/**
 * The three things that can be under a task view's heading — still loading,
 * failed to load, or nothing here — and the list when it is none of them.
 *
 * Shared by all five views so a view component is only its own filtering and
 * grouping, and so an empty Inbox and an empty Upcoming behave identically.
 *
 * Stage 13 moved the states themselves into `common/states`, where the rest
 * of the app shares them; what stays here is the one thing a *task* view does
 * differently — a skeleton shaped like a task row, checkbox and all, rather
 * than a plain bar.
 */
function TaskViewBody({
  isLoading,
  error,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyHint,
  emptyAction,
  children,
}: TaskViewBodyProps) {
  return (
    <AsyncBody
      isLoading={isLoading}
      error={error}
      onRetry={onRetry}
      isEmpty={isEmpty}
      loading={<TaskListSkeleton />}
      loadingLabel="Loading your tasks"
      errorTitle="Could not load your tasks."
      emptyTitle={emptyTitle}
      emptyHint={emptyHint}
      emptyAction={emptyAction}
    >
      {children}
    </AsyncBody>
  );
}

export default TaskViewBody;
