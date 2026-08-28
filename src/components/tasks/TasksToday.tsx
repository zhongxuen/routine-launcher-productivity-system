import { formatDayHeading, groupByPriority, PRIORITY_HEADINGS } from "@/lib/task-utils";
import { useTaskView } from "@/hooks/useTaskView";

import TaskSection from "./TaskSection";
import TaskViewBody from "./TaskViewBody";
import TaskViewHeader from "./TaskViewHeader";

/**
 * The daily task view (section 14): today's work, plus anything still
 * unfinished from an earlier day, grouped by priority with a completion count
 * on top.
 *
 * The carry-forward and the overdue flags are the backend's `today` view —
 * they are computed against the user's local today on every read, so this
 * component only groups what it is given.
 */
function TasksToday() {
  const { tasks, isLoading, error, reload } = useTaskView("today");
  const groups = groupByPriority(tasks);

  return (
    <div className="flex flex-col gap-6 py-2">
      <TaskViewHeader eyebrow="TODAY" subtitle={formatDayHeading(new Date())} tasks={tasks} />

      <TaskViewBody
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        isEmpty={groups.length === 0}
        emptyTitle="Nothing scheduled for today."
        emptyHint="Press Ctrl+N to add a task."
      >
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <TaskSection
              key={group.key}
              heading={PRIORITY_HEADINGS[group.key]}
              tasks={group.tasks}
            />
          ))}
        </div>
      </TaskViewBody>
    </div>
  );
}

export default TasksToday;
