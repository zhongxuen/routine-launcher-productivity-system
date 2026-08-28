import { Clock, Repeat, Timer } from "lucide-react";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatRecurrence } from "@/lib/recurrence";
import {
  formatDuration,
  formatDueTime,
  formatOverdue,
  formatRelativeDate,
  formatTimestampTime,
  PRIORITY_DOT,
} from "@/lib/task-utils";
import { useTaskStore } from "@/stores/taskStore";
import { TASK_PRIORITY_LABELS, type Task } from "@/types/task";

interface TaskRowProps {
  task: Task;
  /** Show the due date alongside the time — off inside a per-date group. */
  showDate?: boolean;
  /** Show the repeat schedule — on in the Recurring view, off elsewhere. */
  showRecurrence?: boolean;
}

/**
 * One task line: a completion toggle, the title, and a thin meta row of due
 * time and estimated duration (section 14). A completed task swaps that meta
 * row for its completion time and the focus-time placeholder (section 17).
 *
 * The title opens the edit dialog; the checkbox is the only other control, so
 * the row stays as quiet as section 12 asks for.
 */
function TaskRow({ task, showDate = false, showRecurrence = false }: TaskRowProps) {
  const toggleTaskCompletion = useTaskStore((state) => state.toggleTaskCompletion);
  const openTaskEditor = useTaskStore((state) => state.openTaskEditor);
  const recurrence = useTaskStore((state) =>
    task.recurrence_id === null ? undefined : state.recurrences[task.recurrence_id],
  );

  const isCompleted = task.status === "completed";
  const dueTime = formatDueTime(task.due_time);
  const duration = formatDuration(task.estimated_minutes);
  const completedAt = formatTimestampTime(task.completed_at);
  const overdue = formatOverdue(task);
  const repeat = showRecurrence ? formatRecurrence(recurrence) : null;

  async function handleToggle() {
    try {
      await toggleTaskCompletion(task.id);
    } catch (cause) {
      // The checkbox is driven by the stored status, so it snaps back on its
      // own; the toast is what explains why.
      toast.error(isCompleted ? "Could not reopen task" : "Could not complete task", {
        description: String(cause),
      });
    }
  }

  return (
    <li className="group flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50">
      <Checkbox
        id={`task-${task.id}`}
        checked={isCompleted}
        onCheckedChange={() => void handleToggle()}
        className="mt-0.5"
        aria-label={isCompleted ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 self-start rounded-full",
                  PRIORITY_DOT[task.priority],
                  isCompleted && "opacity-40",
                )}
              />
            </TooltipTrigger>
            <TooltipContent side="left">
              {TASK_PRIORITY_LABELS[task.priority]} priority
            </TooltipContent>
          </Tooltip>

          <button
            type="button"
            onClick={() => openTaskEditor(task.id)}
            className={cn(
              "min-w-0 flex-1 cursor-pointer text-left text-sm leading-6 hover:underline",
              isCompleted && "text-muted-foreground line-through decoration-muted-foreground/50",
            )}
          >
            {task.title}
          </button>
        </div>

        <div className="ml-3.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {isCompleted ? (
            <>
              {completedAt && <span>Completed at {completedAt}</span>}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 border-b border-dashed border-muted-foreground/30">
                    <Timer className="size-3" />
                    Focus time —
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Actual focus time appears once focus sessions are linked to tasks.
                </TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              {overdue && <span className="text-priority-urgent">{overdue}</span>}
              {showDate && task.due_date && !overdue && (
                <span>{formatRelativeDate(task.due_date)}</span>
              )}
              {dueTime && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  Due {dueTime}
                </span>
              )}
              {duration && <span>{duration}</span>}
            </>
          )}
          {repeat && (
            <span className="inline-flex items-center gap-1">
              <Repeat className="size-3" />
              {repeat}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export default TaskRow;
