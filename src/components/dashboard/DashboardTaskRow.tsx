import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { phaseClass, type ItemPhase } from "@/hooks/useAnimatedList";
import { playSound } from "@/lib/sounds";
import { formatDueTime, formatOverdue, PRIORITY_DOT } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import { useTaskStore } from "@/stores/taskStore";
import { TASK_PRIORITY_LABELS, type Task } from "@/types/task";

/** The full daily view, where a dashboard row goes when it is clicked. */
export const TASKS_TODAY_PATH = "/tasks/today";

/** The same, for the rows of `UpcomingTasks` — a future task is not in Today. */
export const TASKS_UPCOMING_PATH = "/tasks/upcoming";

interface DashboardTaskRowProps {
  task: Task;
  /** Where the row is in its life on screen, from the list that owns it. */
  phase?: ItemPhase;
  /**
   * The view this row's task lives in, which is where clicking it goes.
   * Defaults to Today; `UpcomingTasks` sends its rows to Upcoming, because a
   * link to a list the task is not on is a link to a search for it.
   */
  to?: string;
}

/**
 * One line of the dashboard's task list — the `□ Finish project report` of
 * section 7's mockup.
 *
 * Deliberately thinner than the Tasks page's row: no estimate, no focus time,
 * no START TASK. The dashboard is a glance and a jumping-off point (section
 * 7 ranks today's tasks first *and* keeps the whole screen scannable), so
 * this row carries only what changes a decision — the priority dot, the
 * title, and whether the task is late or due at a time — and everything else
 * is one click away in the daily view.
 *
 * Two things it does keep are the two things the mockup implies you can do
 * from here: tick a task off, which is the real mutation and not a preview of
 * one, and open the task where it lives.
 *
 * Shared by both of the dashboard's task blocks — `TodaysTasks` and
 * `UpcomingTasks` — so a task reads and behaves identically wherever it is
 * listed. The only thing either block chooses is {@link
 * DashboardTaskRowProps.to}, the view its rows belong to.
 */
function DashboardTaskRow({ task, phase = "present", to = TASKS_TODAY_PATH }: DashboardTaskRowProps) {
  const setTaskStatus = useTaskStore((state) => state.setTaskStatus);

  const isCompleted = task.status === "completed";
  const overdue = formatOverdue(task);
  const dueTime = formatDueTime(task.due_time);

  async function handleToggle() {
    try {
      // `setTaskStatus` rather than `toggleTaskCompletion`, which finds the
      // task in the store's loaded view first and silently does nothing when
      // it is not there. The store holds one view — Today — so that lookup
      // would fail for every row of `UpcomingTasks`. The status this row is
      // drawn from is the status to flip, and it is already in hand.
      await setTaskStatus(task.id, isCompleted ? "todo" : "completed");
      // The same cue the Tasks page plays, for the same action — the two
      // lists are two views of one thing, and a task ticked off here should
      // not sound different from the same task ticked off there.
      if (!isCompleted) playSound("task-complete");
    } catch (cause) {
      // The checkbox reflects the stored status, so it snaps back by itself
      // when the write fails; the toast is what explains the snap-back.
      toast.error(isCompleted ? "Could not reopen task" : "Could not complete task", {
        description: String(cause),
      });
    }
  }

  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50",
        phaseClass(phase),
      )}
    >
      <Checkbox
        id={`dashboard-task-${task.id}`}
        checked={isCompleted}
        onCheckedChange={() => void handleToggle()}
        aria-label={isCompleted ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("size-1.5 shrink-0 rounded-full", PRIORITY_DOT[task.priority])} />
        </TooltipTrigger>
        <TooltipContent side="left">{TASK_PRIORITY_LABELS[task.priority]} priority</TooltipContent>
      </Tooltip>

      <Link
        to={to}
        className={cn(
          "min-w-0 flex-1 truncate text-sm leading-6 hover:underline",
          isCompleted && "text-muted-foreground line-through decoration-muted-foreground/50",
        )}
      >
        {task.title}
      </Link>

      {/* One piece of meta at most. Late beats due-at: a task that is already
          overdue is not helped by being told what time it was meant to start. */}
      {overdue ? (
        <span className="shrink-0 text-xs text-priority-urgent">{overdue}</span>
      ) : (
        dueTime && <span className="shrink-0 text-xs text-muted-foreground">{dueTime}</span>
      )}
    </li>
  );
}

export default DashboardTaskRow;
