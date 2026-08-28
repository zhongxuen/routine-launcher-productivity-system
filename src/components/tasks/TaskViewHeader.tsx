import { completionCounts } from "@/lib/task-utils";
import type { Task } from "@/types/task";

interface TaskViewHeaderProps {
  /** e.g. `TODAY`. */
  eyebrow: string;
  /** e.g. `Saturday, August 15`. */
  subtitle?: string;
  /** When given, renders the `3 / 7 completed` line from section 14. */
  tasks?: Task[];
}

/**
 * The heading block at the top of a task view: the view name, the date, and
 * the completion count.
 */
function TaskViewHeader({ eyebrow, subtitle, tasks }: TaskViewHeaderProps) {
  const counts = tasks ? completionCounts(tasks) : null;

  return (
    <header className="flex flex-col gap-0.5 px-2">
      <p className="text-xs font-medium tracking-widest text-muted-foreground">{eyebrow}</p>
      {subtitle && <p className="text-lg font-medium">{subtitle}</p>}
      {counts && (
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">{counts.completed}</span> / {counts.total} completed
        </p>
      )}
    </header>
  );
}

export default TaskViewHeader;
