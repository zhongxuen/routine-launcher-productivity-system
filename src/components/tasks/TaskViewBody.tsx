import TaskEmptyState from "./TaskEmptyState";
import TaskErrorState from "./TaskErrorState";
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
  /** The list itself, rendered only when there is something in it. */
  children: React.ReactNode;
}

/**
 * The three things that can be under a task view's heading — still loading,
 * failed to load, or nothing here — and the list when it is none of them.
 *
 * Shared by all five views so a view component is only its own filtering and
 * grouping, and so an empty Inbox and an empty Upcoming behave identically.
 */
function TaskViewBody({
  isLoading,
  error,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyHint,
  children,
}: TaskViewBodyProps) {
  if (isLoading) return <TaskListSkeleton />;
  if (error) return <TaskErrorState message={error} onRetry={onRetry} />;
  if (isEmpty) return <TaskEmptyState title={emptyTitle} hint={emptyHint} />;

  return <>{children}</>;
}

export default TaskViewBody;
