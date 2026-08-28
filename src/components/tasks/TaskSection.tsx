import TaskRow from "./TaskRow";
import type { Task } from "@/types/task";

interface TaskSectionProps {
  /** The group heading, e.g. `HIGH PRIORITY` or `Tomorrow`. */
  heading: React.ReactNode;
  tasks: Task[];
  showDate?: boolean;
  /** Show each task's repeat schedule — on in the Recurring view. */
  showRecurrence?: boolean;
}

/**
 * A labelled run of task rows. The heading is the only chrome — no cards, no
 * borders, no toolbars, per section 12.
 */
function TaskSection({ heading, tasks, showDate, showRecurrence }: TaskSectionProps) {
  if (tasks.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium tracking-wide text-muted-foreground">{heading}</h3>
      <ul className="flex flex-col">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            showDate={showDate}
            showRecurrence={showRecurrence}
          />
        ))}
      </ul>
    </section>
  );
}

export default TaskSection;
