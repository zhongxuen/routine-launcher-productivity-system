import { useAnimatedList } from "@/hooks/useAnimatedList";

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
 *
 * Rows are animated in and out (section 84). This is the place for it rather
 * than the row itself, because a row cannot animate its own departure: by the
 * time the task is gone from the store the element has already been unmounted.
 * `useAnimatedList` holds it for the length of the fade — see that hook for
 * the whole argument.
 *
 * Ticking a task off Today is what this is for. Completing it drops it out of
 * the view, and the row that just got a checkmark disappearing on the next
 * frame reads as the app having lost it rather than filed it. Now it dims and
 * collapses, which is the same information with the cause attached.
 */
function TaskSection({ heading, tasks, showDate, showRecurrence }: TaskSectionProps) {
  const rows = useAnimatedList(tasks, (task) => task.id);

  // The heading goes with the last row out. Checked against `rows` rather
  // than `tasks`, so a section emptied by its final task being completed
  // stays up until that task has finished leaving — otherwise the heading
  // would vanish out from over a row still fading beneath it.
  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium tracking-wide text-muted-foreground">{heading}</h3>
      <ul className="flex flex-col">
        {rows.map(({ key, item, phase }) => (
          <TaskRow
            key={key}
            task={item}
            phase={phase}
            showDate={showDate}
            showRecurrence={showRecurrence}
          />
        ))}
      </ul>
    </section>
  );
}

export default TaskSection;
