import { Checkbox } from "@/components/ui/checkbox";
import { PRIORITY_DOT } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import type { Task } from "@/types/task";

/**
 * The height of one row, in CSS pixels — `h-7`.
 *
 * Exported because `useFittedRows` has to be told it: how many of today's
 * tasks the widget can show is this number divided into the space there is.
 * It is a constant rather than a measurement for the same reason the rows are
 * a fixed height — a list whose capacity depended on which tasks were in it
 * would resize itself as they were ticked off.
 */
export const WIDGET_TASK_ROW_HEIGHT = 28;

interface WidgetTaskRowProps {
  task: Task;
  /** Ticks the box. The caller owns the write, so it owns the error too. */
  onToggle: (task: Task) => void;
  /** True while this row's write is in flight. */
  isBusy: boolean;
}

/**
 * One line of section 26's list — the `□ Finish report` and `✓ Check emails`
 * of the mockup.
 *
 * Thinner even than the popup's row, and by the same reasoning taken one step
 * further: a priority dot, the title, and nothing else. The popup can afford
 * a due time because it is a window you open, look at and dismiss; this one
 * is furniture on the desktop, and every glyph it draws is a glyph that is
 * there all day. The dot survives the cut because it costs 6px and answers
 * "which of these first"; a time does not, because the widget is a list of
 * what is left rather than a schedule.
 *
 * The checkbox is the real one — `taskStore.toggleTaskCompletion`, the same
 * write the Tasks page makes, straight to SQLite — so a task ticked here is
 * ticked in the main window a moment later. See `WidgetContent` for what
 * carries the news the other way.
 *
 * The row is a fixed `h-7` because the list above it is measured rather than
 * scrolled; see {@link WIDGET_TASK_ROW_HEIGHT}.
 */
function WidgetTaskRow({ task, onToggle, isBusy }: WidgetTaskRowProps) {
  const isCompleted = task.status === "completed";

  return (
    <li
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-1 transition-colors hover:bg-accent/50",
        isBusy && "opacity-60",
      )}
    >
      <Checkbox
        checked={isCompleted}
        disabled={isBusy}
        onCheckedChange={() => onToggle(task)}
        className="size-3.5"
        aria-label={
          isCompleted ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`
        }
      />

      <span
        className={cn("size-1.5 shrink-0 rounded-full", PRIORITY_DOT[task.priority])}
        aria-hidden
      />

      {/* The full text in a tooltip, because a 300px window truncates a lot of
          titles and hovering is the only way left to read one. */}
      <span
        title={task.title}
        className={cn(
          "min-w-0 flex-1 truncate text-[0.8rem] leading-none",
          isCompleted && "text-muted-foreground line-through decoration-muted-foreground/50",
        )}
      >
        {task.title}
      </span>
    </li>
  );
}

export default WidgetTaskRow;
