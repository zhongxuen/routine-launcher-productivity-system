import { Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
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
import { getTaskReminder } from "@/services/notificationService";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTaskStore } from "@/stores/taskStore";
import type { TaskReminder } from "@/types/notification";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type NewTaskRecurrence,
  type Task,
  type TaskPriority,
  type TaskRecurrence,
} from "@/types/task";

import RecurrencePicker from "./RecurrencePicker";
import TaskCategoryField, { categoryFieldValue, categoryIdFromField } from "./TaskCategoryField";
import TaskReminderField, {
  NO_REMINDER_DRAFT,
  leadTimeDraft,
  reminderChanged,
  reminderDraft,
  reminderInput,
  saveTaskReminder,
  type ReminderDraft,
} from "./TaskReminderField";
import TaskRoutineField, { routineFieldValue, routineIdFromField } from "./TaskRoutineField";

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

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [categoryId, setCategoryId] = useState(categoryFieldValue(task.category_id));
  const [dueDate, setDueDate] = useState(task.due_date ?? "");
  const [dueTime, setDueTime] = useState(task.due_time ?? "");
  const [estimate, setEstimate] = useState(
    task.estimated_minutes === null ? "" : String(task.estimated_minutes),
  );
  const [routine, setRoutine] = useState(routineFieldValue(task.routine_id));
  const [schedule, setSchedule] = useState<NewTaskRecurrence | null>(toDraft(recurrence));

  // Seeded from the row so the field does not open on "None" and then jump;
  // the `getTaskReminder` read below is what it settles on.
  const [storedReminder, setStoredReminder] = useState<TaskReminder | null>(task.reminder);
  const [reminder, setReminder] = useState<ReminderDraft>(() => reminderDraft(task.reminder));
  const reminderTouched = useRef(false);
  // The dates the dialog opened with, fixed for its life: a save that got the
  // task through but had its reminder refused must still count them as moved.
  const [openedDates] = useState(() => `${task.due_date} ${task.due_time}`);
  const [openedWithoutDueTime] = useState(() => task.due_time === null);
  const defaultReminderMinutes = useSettingsStore(
    (state) => state.daily.defaultReminderMinutes,
  );
  /** Whether the field is showing section 52's default rather than a stored reminder. */
  const showsDefaultReminder = useRef(false);

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = title.trim();
  const hadRecurrence = task.recurrence_id !== null;

  // The row can be a read behind — a reminder snoozed from the popup a moment
  // ago — so the field is filled from the reminder as it is stored now.
  useEffect(() => {
    let cancelled = false;
    getTaskReminder(task.id)
      .then((stored) => {
        if (cancelled) return;
        setStoredReminder(stored);
        // A default suggested before this landed stays, when there is still
        // nothing stored for it to be replacing.
        if (reminderTouched.current) return;
        if (stored === null && showsDefaultReminder.current) return;
        showsDefaultReminder.current = false;
        setReminder(reminderDraft(stored));
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  /**
   * Section 52's default reminder, for a task being given its first due time.
   *
   * This is where the default can apply at all: it is "N minutes before", and
   * the quick-add form cannot give a task the due time that counts back from.
   * So it follows the due date and time for as long as that is the only
   * reason the field has a value — the task had no due time and no reminder
   * when the dialog opened, and nobody has touched the field since — and goes
   * back to None if the time is cleared again. It is on screen before it is
   * saved, like any other value in the form.
   */
  function followDefaultReminder(nextDate: string, nextTime: string) {
    if (defaultReminderMinutes === null || reminderTouched.current) return;
    if (!openedWithoutDueTime || storedReminder !== null) return;

    showsDefaultReminder.current = Boolean(nextDate && nextTime);
    setReminder(
      showsDefaultReminder.current ? leadTimeDraft(defaultReminderMinutes) : NO_REMINDER_DRAFT,
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || isSaving) return;

    // A time is only meaningful with a date, and the backend rejects one
    // without it, so clearing the date clears the time too.
    const nextDueDate = dueDate || null;
    const nextDueTime = dueDate && dueTime ? dueTime : null;

    setIsSaving(true);
    setError(null);
    try {
      await updateTask(task.id, {
        title: trimmed,
        description: description.trim() || null,
        priority,
        category_id: categoryIdFromField(categoryId),
        due_date: nextDueDate,
        due_time: nextDueTime,
        estimated_minutes: estimate ? Number(estimate) : null,
        routine_id: routineIdFromField(routine),
        // Sending this only when it changed keeps an ordinary edit from
        // re-timing a series that the user did not touch.
        ...(scheduleChanged(schedule, recurrence) ? { recurrence: schedule } : {}),
      });

      // After the task, because the reminder is judged against the dates just
      // saved. An unchanged reminder is sent again when those dates moved, so
      // the backend can refuse one they no longer support rather than let it go
      // quiet, and a snooze taken against the old dates does not outlive them.
      const datesMoved = `${nextDueDate} ${nextDueTime}` !== openedDates;
      if (
        reminderChanged(reminder, storedReminder) ||
        (datesMoved && reminderInput(reminder) !== null)
      ) {
        await saveTaskReminder(task.id, reminder);
      }

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
            onChange={(event) => {
              setDueDate(event.target.value);
              followDefaultReminder(event.target.value, dueTime);
            }}
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
            onChange={(event) => {
              setDueTime(event.target.value);
              followDefaultReminder(dueDate, event.target.value);
            }}
          />
        </div>

        <TaskReminderField
          idPrefix="edit"
          value={reminder}
          onChange={(value) => {
            reminderTouched.current = true;
            setReminder(value);
          }}
          hasDueDate={dueDate !== ""}
          hasDueTime={dueDate !== "" && dueTime !== ""}
          className="col-span-2"
        />

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

        <TaskCategoryField idPrefix="edit" value={categoryId} onChange={setCategoryId} />

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

      {error && <InlineError message={error} onDismiss={() => setError(null)} />}

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
