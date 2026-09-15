import { ListChecks, NotebookPen, Zap } from "lucide-react";

/**
 * What a session is attached to (development-plan.md section 34): a task, a
 * routine, both, or — when the timer was launched on its own from this page —
 * neither, in which case nothing is drawn.
 *
 * A session with no task can still say what it is for: Start My Day's
 * planning session (section 21) carries a label, drawn where the task would
 * be. Only the running clock has one — it is never stored, so the completion
 * card describes the same session by its routine.
 *
 * Shared by the running clock and the completion card so a session is
 * described the same way before and after it ends.
 */
function FocusAttachment({
  taskTitle,
  routineName,
  label = null,
  className,
}: {
  taskTitle: string | null;
  routineName: string | null;
  label?: string | null;
  className?: string;
}) {
  if (!taskTitle && !routineName && !label) return null;

  return (
    <div className={className}>
      {taskTitle && (
        <p className="flex items-center justify-center gap-2 text-sm">
          <ListChecks className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            <span className="text-muted-foreground">Task: </span>
            {taskTitle}
          </span>
        </p>
      )}
      {label && !taskTitle && (
        <p className="flex items-center justify-center gap-2 text-sm">
          <NotebookPen className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </p>
      )}
      {routineName && (
        <p className="flex items-center justify-center gap-2 text-sm">
          <Zap className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            <span className="text-muted-foreground">Routine: </span>
            {routineName}
          </span>
        </p>
      )}
    </div>
  );
}

export default FocusAttachment;
