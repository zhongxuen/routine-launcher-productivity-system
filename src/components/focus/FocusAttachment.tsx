import { ListChecks, Zap } from "lucide-react";

/**
 * What a session is attached to (development-plan.md section 34): a task, a
 * routine, both, or — when the timer was launched on its own from this page —
 * neither, in which case nothing is drawn.
 *
 * Shared by the running clock and the completion card so a session is
 * described the same way before and after it ends.
 */
function FocusAttachment({
  taskTitle,
  routineName,
  className,
}: {
  taskTitle: string | null;
  routineName: string | null;
  className?: string;
}) {
  if (!taskTitle && !routineName) return null;

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
