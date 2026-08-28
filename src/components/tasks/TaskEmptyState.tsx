interface TaskEmptyStateProps {
  title: string;
  hint?: string;
}

/** Shown in place of a task list when a view has nothing in it. */
function TaskEmptyState({ title, hint }: TaskEmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-1 py-14 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

export default TaskEmptyState;
