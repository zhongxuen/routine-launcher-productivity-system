import { Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatFocusLength } from "@/lib/focus-utils";
import { useTaskStore } from "@/stores/taskStore";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type NewTaskRecurrence,
  type Task,
  type TaskPriority,
  type TaskRecurrence,
} from "@/types/task";

import RecurrencePicker from "./RecurrencePicker";
import TaskRoutineField, { routineFieldValue, routineIdFromField } from "./TaskRoutineField";

/** The category select's value for "no category" — Select cannot hold "". */
const NO_CATEGORY = "none";

/** A stored rule as the picker's draft shape. */
const toDraft = (rule: TaskRecurrence | undefined): NewTaskRecurrence | null =>
  rule
    ? {
        frequency: rule.frequency,
        interval: rule.interval,
        days_of_week: rule.days_of_week,
        day_of_month: rule.day_of_month,
        end_date: rule.end_date,
      }
    : null;

interface EditFormProps {
  task: Task;
  recurrence: TaskRecurrence | undefined;
  onClose: () => void;
}

/**
 * The form itself, keyed on the task id by its parent so opening a different
 * task remounts it with fresh state rather than merging the two.
 */
function EditForm({ task, recurrence, onClose }: EditFormProps) {
  const updateTask = useTaskStore((state) => state.updateTask);
  const deleteTask = useTaskStore((state) => state.deleteTask);
  const categories = useTaskStore((state) => state.categories);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [categoryId, setCategoryId] = useState(
    task.category_id === null ? NO_CATEGORY : String(task.category_id),
  );
  const [dueDate, setDueDate] = useState(task.due_date ?? "");
  const [dueTime, setDueTime] = useState(task.due_time ?? "");
  const [estimate, setEstimate] = useState(
    task.estimated_minutes === null ? "" : String(task.estimated_minutes),
  );
  const [routine, setRoutine] = useState(routineFieldValue(task.routine_id));
  const [schedule, setSchedule] = useState<NewTaskRecurrence | null>(toDraft(recurrence));

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = title.trim();
  const hadRecurrence = task.recurrence_id !== null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || isSaving) return;

    setIsSaving(true);
    setError(null);
    try {
      await updateTask(task.id, {
        title: trimmed,
        description: description.trim() || null,
        priority,
        category_id: categoryId === NO_CATEGORY ? null : Number(categoryId),
        due_date: dueDate || null,
        // A time is only meaningful with a date, and the backend rejects one
        // without it, so clearing the date clears the time too.
        due_time: dueDate && dueTime ? dueTime : null,
        estimated_minutes: estimate ? Number(estimate) : null,
        routine_id: routineIdFromField(routine),
        // Sending this only when it changed keeps an ordinary edit from
        // re-timing a series that the user did not touch.
        ...(scheduleChanged(schedule, recurrence) ? { recurrence: schedule } : {}),
      });

      toast.success("Task saved", { description: trimmed });
      onClose();
    } catch (cause) {
      setIsSaving(false);
      setError(String(cause));
    }
  }

  async function handleDelete() {
    setIsSaving(true);
    setError(null);
    try {
      await deleteTask(task.id);
      toast.success("Task deleted", { description: task.title });
      onClose();
    } catch (cause) {
      setIsSaving(false);
      setError(String(cause));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Task title"
        aria-label="Task title"
      />

      <Textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="Notes (optional)"
        aria-label="Description"
        className="min-h-16 resize-none"
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-due-date" className="text-xs text-muted-foreground">
            Due date
          </Label>
          <Input
            id="edit-due-date"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-due-time" className="text-xs text-muted-foreground">
            Due time
          </Label>
          <Input
            id="edit-due-time"
            type="time"
            value={dueTime}
            disabled={!dueDate}
            onChange={(event) => setDueTime(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-priority" className="text-xs text-muted-foreground">
            Priority
          </Label>
          <Select value={priority} onValueChange={(value) => setPriority(value as TaskPriority)}>
            <SelectTrigger id="edit-priority" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_PRIORITIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {TASK_PRIORITY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-category" className="text-xs text-muted-foreground">
            Category
          </Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger id="edit-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CATEGORY}>None</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={String(category.id)}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-estimate" className="text-xs text-muted-foreground">
            Estimate (min)
          </Label>
          <Input
            id="edit-estimate"
            type="number"
            min={1}
            value={estimate}
            onChange={(event) => setEstimate(event.target.value)}
          />
        </div>
        <TaskRoutineField
          idPrefix="edit"
          value={routine}
          onChange={setRoutine}
          className="col-span-2"
        />
      </div>

      <RecurrencePicker idPrefix="edit" value={schedule} onChange={setSchedule} />

      {hadRecurrence && schedule === null && (
        <p className="text-xs text-muted-foreground">
          Ending the repeat keeps the tasks it already created.
        </p>
      )}

      {/* Section 17's "Actual focus time", next to the estimate it is the
          answer to. Read-only, and absent until there is one: it is summed
          from the focus sessions this task has had, not something anyone
          types. */}
      {task.focus_seconds > 0 && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Timer className="size-3.5" />
          Actual focus time: {formatFocusLength(task.focus_seconds)}
        </p>
      )}

      {error && <p className="text-xs text-priority-urgent">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-priority-urgent"
          disabled={isSaving}
          onClick={handleDelete}
        >
          Delete
        </Button>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!trimmed || isSaving}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Whether the picker's draft differs from the schedule the task already has.
 *
 * Worth checking because sending `recurrence` re-times the whole series: the
 * backend snaps the task onto the schedule's next occurrence, which would
 * quietly move a task whose title was the only thing being edited.
 */
function scheduleChanged(
  draft: NewTaskRecurrence | null,
  stored: TaskRecurrence | undefined,
): boolean {
  return JSON.stringify(draft) !== JSON.stringify(toDraft(stored));
}

/**
 * Edit one task (section 9's full task shape) — and, for a repeating task,
 * the schedule behind the whole series. Opened by clicking a task's title.
 */
function TaskEditDialog() {
  const editingTaskId = useTaskStore((state) => state.editingTaskId);
  const closeTaskEditor = useTaskStore((state) => state.closeTaskEditor);
  const tasks = useTaskStore((state) => state.tasks);
  const recurrences = useTaskStore((state) => state.recurrences);

  const task = tasks.find((candidate) => candidate.id === editingTaskId) ?? null;

  // A task can vanish from under the dialog — deleted here, or filtered out
  // of the view by the very edit that was just saved.
  useEffect(() => {
    if (editingTaskId !== null && !task) closeTaskEditor();
  }, [closeTaskEditor, editingTaskId, task]);

  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && closeTaskEditor()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Edit task</DialogTitle>
          <DialogDescription className="sr-only">
            Change the task's details, its schedule, or delete it.
          </DialogDescription>
        </DialogHeader>

        {task && (
          <EditForm
            key={task.id}
            task={task}
            recurrence={
              task.recurrence_id !== null ? recurrences[task.recurrence_id] : undefined
            }
            onClose={closeTaskEditor}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export default TaskEditDialog;
