import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

interface TaskErrorStateProps {
  /** The message from the failed command — already user-presentable. */
  message: string;
  onRetry?: () => void;
}

/**
 * Shown in place of a task list when the read failed. Deliberately plain:
 * what went wrong, and a way to try again. Full polish is Stage 13's job.
 */
function TaskErrorState({ message, onRetry }: TaskErrorStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center">
      <AlertCircle className="size-5 text-priority-urgent" />
      <div className="flex flex-col gap-1">
        <p className="text-sm">Could not load your tasks.</p>
        <p className="max-w-md text-xs text-muted-foreground">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export default TaskErrorState;
