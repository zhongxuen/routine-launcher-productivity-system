import { Plus } from "lucide-react";
import { Link } from "react-router-dom";

import { PLAN_TODAY_PATH } from "@/components/tasks/PlanToday";
import TaskViewBody from "@/components/tasks/TaskViewBody";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAnimatedList } from "@/hooks/useAnimatedList";
import { useTaskView } from "@/hooks/useTaskView";
import { completionCounts, sortTasks } from "@/lib/task-utils";
import { useTaskStore } from "@/stores/taskStore";
import type { Task } from "@/types/task";

import DashboardTaskRow, { TASKS_TODAY_PATH } from "./DashboardTaskRow";

/**
 * How many tasks the widget lists before it stops and points at the full
 * view. Section 7's mockup shows four; five leaves a little headroom without
 * the dashboard turning into the Tasks page.
 */
const MAX_ROWS = 5;

/** Everything still to do — the list the mockup draws as unticked boxes. */
const openTasks = (tasks: Task[]): Task[] =>
  sortTasks(tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled"));

/**
 * The dashboard's "Today's Tasks" widget (development-plan.md section 7):
 *
 * ```text
 * Tasks                         Progress
 * ──────────────────────        ──────────────────────
 *
 * □ Finish project report       █████████░░  70%
 * □ Review database schema
 * □ Submit assignment
 * □ 30 min coding
 *
 * [ + Add Task ]
 * ```
 *
 * It reads the backend's `today` view through `useTaskView` — the same query
 * the Tasks page's daily view runs, so the dashboard and `/tasks/today` can
 * never disagree about what today holds, and the carry-forward of unfinished
 * work from earlier days (section 14) comes along for free.
 *
 * Only unfinished tasks are listed, because a dashboard is a list of what is
 * left rather than a log of what happened. The completed half of the day is
 * not thrown away, though: it is the meter beside the heading, which is the
 * mockup's `█████████░░ 70%` and moves the moment a box is ticked. That is
 * also what makes a task vanishing on completion read as progress rather than
 * as a disappearance.
 *
 * The list is capped at {@link MAX_ROWS}; the overflow is a link, not a
 * scrollbar, since the point of the cap is to keep section 7's other three
 * blocks above the fold.
 *
 * **Composition note.** "+ Add Task" raises the one quick-add dialog the app
 * shell mounts (`AppLayout`, beside section 16's `Ctrl+N`), so it works
 * wherever the widget is dropped without this widget mounting a copy of its
 * own. `QuickAddTask` is driven by one flag on the task store, and a second
 * copy anywhere would open a second dialog on top of the first.
 */
function TodaysTasks() {
  const { tasks, isLoading, error, reload } = useTaskView("today");
  const openQuickAdd = useTaskStore((state) => state.openQuickAdd);

  const open = openTasks(tasks);
  const shown = open.slice(0, MAX_ROWS);
  const rows = useAnimatedList(shown, (task) => task.id);
  const hidden = open.length - shown.length;

  const { completed, total } = completionCounts(tasks);
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  // "Nothing scheduled" and "everything done" are the same empty list and
  // very different days, so they are not given the same sentence.
  const isDayDone = total > 0;
  // A count is a claim about the day, and there is nothing to claim until the
  // read lands — "0 / 0 completed" over a skeleton would be a wrong one.
  const hasCounts = !isLoading && error === null;

  return (
    <section aria-labelledby="dashboard-tasks-heading" className="flex flex-col gap-3">
      <header className="flex items-end justify-between gap-6 px-2">
        <div className="flex flex-col gap-0.5">
          <h2 id="dashboard-tasks-heading" className="text-sm font-medium tracking-wide">
            Tasks
          </h2>
          {hasCounts && (
            <p className="text-xs text-muted-foreground">
              <span className="text-foreground">{completed}</span> / {total} completed
            </p>
          )}
        </div>

        {/* The mockup's second column. It is only drawn once there is a day to
            measure — a 0% bar on a day with no tasks is a false accusation. */}
        {hasCounts && total > 0 && (
          <div className="flex w-40 shrink-0 items-center gap-2">
            <Progress
              value={percent}
              aria-label={`${percent}% of today's tasks completed`}
              className="h-1.5"
            />
            <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
          </div>
        )}
      </header>

      <TaskViewBody
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        // `rows`, not `shown`: ticking off the last open task would
        // otherwise swap straight to "All done for today." and cut that row's
        // fade off at its first frame.
        isEmpty={rows.length === 0}
        emptyTitle={isDayDone ? "All done for today." : "Nothing scheduled for today."}
        emptyHint={
          isDayDone
            ? "Every task for today is ticked off."
            : "Add the first thing you want to get done."
        }
      >
        <ul className="flex flex-col">
          {rows.map(({ key, item, phase }) => (
            <DashboardTaskRow key={key} task={item} phase={phase} />
          ))}
        </ul>
      </TaskViewBody>

      <div className="flex items-center gap-3 px-2">
        <Button size="sm" variant="outline" onClick={openQuickAdd}>
          <Plus className="size-4" />
          Add Task
        </Button>

        {hidden > 0 && (
          <Link
            to={TASKS_TODAY_PATH}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {hidden} more {hidden === 1 ? "task" : "tasks"}
          </Link>
        )}

        {/* PLAN TODAY lives on Tasks > Today, above the full list it plans;
            this opens it there rather than drawing a second copy here. */}
        <Link
          to={PLAN_TODAY_PATH}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Plan today
        </Link>
      </div>
    </section>
  );
}

export default TodaysTasks;
