import { Clock, Repeat } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatRecurrence } from "@/lib/recurrence";
import { formatDueTime, formatDuration, PRIORITY_DOT } from "@/lib/task-utils";
import { useTaskStore } from "@/stores/taskStore";
import { TASK_PRIORITY_LABELS, type RepeatPreview } from "@/types/task";

interface RepeatsSectionProps {
  repeats: RepeatPreview[];
}

/**
 * The read-only Repeats group on a future day of Tasks > Today (section 53).
 *
 * Section 23's generator only creates today's instance of a repeating task,
 * so tomorrow's does not exist yet. The rows say what will arrive; they are
 * not tasks. There is no checkbox, since there is nothing to complete, and no
 * edit, since there is nothing to edit. Changing what arrives is done by
 * editing today's instance, which is what tomorrow's is cloned from.
 *
 * Kept visibly apart from the day's real tasks, under its own heading and
 * with a repeat glyph where the checkbox would be. A preview that looked
 * like a task would invite a click it cannot answer.
 */
function RepeatsSection({ repeats }: RepeatsSectionProps) {
  const recurrences = useTaskStore((state) => state.recurrences);

  if (repeats.length === 0) return null;

  return (
    <section aria-labelledby="task-repeats-heading" className="flex flex-col gap-1">
      <div className="flex flex-col px-2">
        <h3
          id="task-repeats-heading"
          className="text-xs font-medium tracking-wide text-muted-foreground"
        >
          REPEATS
        </h3>
        <p className="text-xs text-muted-foreground">
          Added automatically on the day, so there is nothing to tick off yet.
        </p>
      </div>

      <ul className="flex flex-col">
        {repeats.map((repeat) => {
          const dueTime = formatDueTime(repeat.due_time);
          const duration = formatDuration(repeat.estimated_minutes);
          const schedule = formatRecurrence(recurrences[repeat.recurrence_id]);

          return (
            <li key={repeat.recurrence_id} className="flex items-start gap-3 rounded-md px-2 py-2">
              <Repeat aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span
                    title={`${TASK_PRIORITY_LABELS[repeat.priority]} priority`}
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 self-start rounded-full opacity-60",
                      PRIORITY_DOT[repeat.priority],
                    )}
                  />
                  <span className="min-w-0 flex-1 text-sm leading-6 text-foreground/80">
                    {repeat.title}
                  </span>
                </div>

                <div className="ml-3.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {dueTime && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-3" />
                      Due {dueTime}
                    </span>
                  )}
                  {duration && <span>{duration}</span>}
                  {schedule && <span>{schedule}</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default RepeatsSection;
