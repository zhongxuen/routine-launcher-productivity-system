import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import TaskViewBody from "@/components/tasks/TaskViewBody";
import { useAnimatedList } from "@/hooks/useAnimatedList";
import { formatDayHeading, groupByDueDate, parseDateKey, type TaskGroup } from "@/lib/task-utils";
import { listUpcomingTasks } from "@/services/taskService";
import { useTaskStore } from "@/stores/taskStore";
import type { Task, TaskStatus } from "@/types/task";

import DashboardTaskRow, { TASKS_UPCOMING_PATH } from "./DashboardTaskRow";

/**
 * How many tasks the widget lists before it stops and points at the full
 * view — the same cap, for the same reason, as `TodaysTasks`: the dashboard
 * is a starting point, and section 7's other blocks have to stay above the
 * fold. Rows are counted across days, not per day, so a week with one task on
 * each of six days is capped exactly like a single day with six.
 */
const MAX_ROWS = 5;

/**
 * Still-to-do statuses, matching what `taskStore` asks for when it reads the
 * same view for `/tasks/upcoming`. Without it the backend would hand back
 * completed future tasks too, and the dashboard would list work the Tasks
 * page does not.
 */
const OPEN_STATUSES: TaskStatus[] = ["todo", "in_progress"];

/** The day's heading, e.g. `"Monday, September 1"`. */
function headingFor(dateKey: string): string {
  const date = parseDateKey(dateKey);
  // Upcoming is `due_date > today`, so every task in it has a date; this is
  // the belt to that braces, not a case the view is expected to produce.
  return date ? formatDayHeading(date) : "Scheduled";
}

/**
 * The first {@link MAX_ROWS} tasks, still grouped by their day.
 *
 * Cutting the flattened list and regrouping it would be the same thing, since
 * `groupByDueDate` already returns days in ascending order — this just walks
 * the days it gives back and stops when the budget runs out, so a day is
 * either partly listed or not reached, never reordered.
 */
function capGroups(groups: TaskGroup<string>[], max: number): TaskGroup<string>[] {
  const capped: TaskGroup<string>[] = [];
  let budget = max;

  for (const group of groups) {
    if (budget <= 0) break;
    const tasks = group.tasks.slice(0, budget);
    budget -= tasks.length;
    capped.push({ key: group.key, tasks });
  }

  return capped;
}

/**
 * The dashboard's upcoming block (development-plan.md sections 7 and 77) —
 * the next few days under today, so the page answers "what is next" as well
 * as "what is now".
 *
 * It sits *below* `TodaysTasks` rather than beside it. Section 7 orders the
 * dashboard by stated priority and puts today first, so what is coming is
 * read after what is due, never instead of it.
 *
 * **Why this widget owns its read.** `useTaskView` is not usable here.
 * `taskStore` holds one view at a time — the right shape for the five routes
 * under `/tasks`, where exactly one is on screen — and `TodaysTasks` already
 * owns it as `today`. A second `useTaskView` on the same page would have the
 * two widgets overwriting each other's view on every pass, and the visible
 * symptom would be today's list flickering into upcoming tasks and back. So
 * this component calls `listUpcomingTasks` into its own state and keeps its
 * own loading and error flags, which is what every other block on the
 * dashboard does anyway: `Dashboard.tsx` is composition only.
 *
 * The read re-runs whenever the task store's collection changes identity.
 * Every mutation in the app ends in `taskStore.refresh()`, which re-reads
 * today's view and sets a fresh array, so ticking a box here — or in the
 * block above, or on the Tasks page — is enough to bring this list back in
 * step without either component knowing about the other. Same trick, and the
 * same cheapness, as `DailyQuests` watching the three stores it counts.
 *
 * Rows are `DashboardTaskRow`, so a task looks and behaves the same in both
 * dashboard blocks — including the checkbox, which is the real mutation.
 * Ticking one off completes it, which takes it out of `upcoming` and drops it
 * from this list on the re-read.
 */
function UpcomingTasks() {
  // Not a copy of the store's tasks — the store holds `today` — only the
  // signal that something was written and this view may be behind.
  const storeTasks = useTaskStore((state) => state.tasks);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Retry, to re-run the read without changing what it reads. */
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;

    listUpcomingTasks({ statuses: OPEN_STATUSES })
      .then((next) => {
        // A slower read the user has already navigated away from must not
        // overwrite a newer one — the same guard `taskStore.read` makes.
        if (cancelled) return;
        setTasks(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [storeTasks, attempt]);

  const groups = groupByDueDate(tasks);
  const shown = capGroups(groups, MAX_ROWS);
  const hidden = tasks.length - shown.reduce((count, group) => count + group.tasks.length, 0);

  return (
    <section aria-labelledby="dashboard-upcoming-heading" className="flex flex-col gap-3">
      <header className="flex flex-col gap-0.5 px-2">
        <h2 id="dashboard-upcoming-heading" className="text-sm font-medium tracking-wide">
          Upcoming
        </h2>
        {/* A count is a claim about what is ahead, and there is nothing to
            claim until the read lands. */}
        {!isLoading && error === null && tasks.length > 0 && (
          <p className="text-xs text-muted-foreground">{tasks.length} scheduled</p>
        )}
      </header>

      <TaskViewBody
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        isEmpty={shown.length === 0}
        emptyTitle="Nothing scheduled ahead."
        emptyHint="Tasks with a future due date show up here."
      >
        <div className="flex flex-col gap-4">
          {shown.map((group) => (
            <UpcomingDay key={group.key} heading={headingFor(group.key)} tasks={group.tasks} />
          ))}
        </div>
      </TaskViewBody>

      {hidden > 0 && (
        <div className="px-2">
          <Link
            to={TASKS_UPCOMING_PATH}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {hidden} more {hidden === 1 ? "task" : "tasks"}
          </Link>
        </div>
      )}
    </section>
  );
}

/**
 * One day's heading and its rows.
 *
 * Its own component because the fade-out belongs per group, the way
 * `TaskSection` does it on the Tasks page: a row cannot animate its own
 * departure, and the last row of a day leaving has to keep the day's heading
 * up until it has finished going.
 */
function UpcomingDay({ heading, tasks }: { heading: string; tasks: Task[] }) {
  const rows = useAnimatedList(tasks, (task) => task.id);

  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium tracking-wide text-muted-foreground">{heading}</h3>
      <ul className="flex flex-col">
        {rows.map(({ key, item, phase }) => (
          <DashboardTaskRow key={key} task={item} phase={phase} to={TASKS_UPCOMING_PATH} />
        ))}
      </ul>
    </section>
  );
}

export default UpcomingTasks;
