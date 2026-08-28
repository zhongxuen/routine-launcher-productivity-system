import { formatRelativeDate, groupByDueDate } from "@/lib/task-utils";
import { useTaskView } from "@/hooks/useTaskView";

import TaskSection from "./TaskSection";
import TaskViewBody from "./TaskViewBody";
import TaskViewHeader from "./TaskViewHeader";

/** Tasks for future dates (section 15), grouped by the day they are due. */
function TasksUpcoming() {
  const { tasks, isLoading, error, reload } = useTaskView("upcoming");
  const groups = groupByDueDate(tasks);

  return (
    <div className="flex flex-col gap-6 py-2">
      <TaskViewHeader eyebrow="UPCOMING" subtitle={`${tasks.length} scheduled`} />

      <TaskViewBody
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        isEmpty={groups.length === 0}
        emptyTitle="Nothing scheduled ahead."
        emptyHint="Tasks with a future due date show up here."
      >
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <TaskSection
              key={group.key}
              heading={formatRelativeDate(group.key)}
              tasks={group.tasks}
            />
          ))}
        </div>
      </TaskViewBody>
    </div>
  );
}

export default TasksUpcoming;
