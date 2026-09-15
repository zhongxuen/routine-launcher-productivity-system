import { useEffect, useState } from "react";
import { addDays, format } from "date-fns";
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
import { formatRecurrence } from "@/lib/recurrence";
import { formatRelativeDate } from "@/lib/task-utils";
import { useRoutineStore } from "@/stores/routineStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTaskStore } from "@/stores/taskStore";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type NewTaskRecurrence,
  type Task,
  type TaskPriority,
} from "@/types/task";

import RecurrencePicker from "./RecurrencePicker";
import TaskCategoryField, { NO_CATEGORY, categoryIdFromField } from "./TaskCategoryField";
import TaskReminderField, {
  NO_REMINDER_DRAFT,
  reminderInput,
  saveTaskReminder,
  type ReminderDraft,
} from "./TaskReminderField";
import TaskRoutineField, { NO_ROUTINE, routineIdFromField } from "./TaskRoutineField";

/**
 * The due-date choices. Section 16 wants a one-tap dropdown rather than a date
 * picker, so these are the handful of dates a task actually gets given.
 */
const DUE_OPTIONS = [
  { value: "today", label: "Today", offset: 0 },
  { value: "tomorrow", label: "Tomorrow", offset: 1 },
  { value: "next-week", label: "Next week", offset: 7 },
  { value: "none", label: "No date (Inbox)", offset: null },
] as const;

type DueOption = (typeof DUE_OPTIONS)[number]["value"];

const dueDateFor = (option: DueOption): string | null => {
  const match = DUE_OPTIONS.find((candidate) => candidate.value === option);
  return match?.offset === null || match === undefined
    ? null
    : format(addDays(new Date(), match.offset), "yyyy-MM-dd");
};

/**
 * The reminder a new task starts with. None: section 24 reminds about what
 * the user asked to be reminded about. Section 52's default reminder applies
 * only to a task with a due time, which this form cannot give — so it is
 * offered in the edit dialog, when a task is given its first due time.
 */
const NEW_TASK_REMINDER = NO_REMINDER_DRAFT;

/**
 * Quick task creation (section 16): title, due date, priority, category,
 * routine, repeat, reminder, Add. Opened by the "+ Add Task" buttons, the tray, or Ctrl+N; all
 * go through `isQuickAddOpen` on the store, so anywhere in the app can raise
 * it.
 *
 * Mounted once, by the app shell (`AppLayout`) — never by a page, or two
 * dialogs would answer the one flag.
 */
function QuickAddTask() {
  const isOpen = useTaskStore((state) => state.isQuickAddOpen);
  const setQuickAddOpen = useTaskStore((state) => state.setQuickAddOpen);
  const createTask = useTaskStore((state) => state.createTask);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);
  // Section 52's default task priority: what the form opens on.
  const defaultPriority = useSettingsStore((state) => state.daily.defaultTaskPriority);

  const [title, setTitle] = useState("");
  const [due, setDue] = useState<DueOption>("today");
  const [priority, setPriority] = useState<TaskPriority>(defaultPriority);
  const [category, setCategory] = useState(NO_CATEGORY);
  const [recurrence, setRecurrence] = useState<NewTaskRecurrence | null>(null);
  const [routine, setRoutine] = useState(NO_ROUTINE);
  const [reminder, setReminder] = useState<ReminderDraft>(NEW_TASK_REMINDER);
  /**
   * The task an earlier press added, when its reminder was refused. The task
   * is saved by then, so pressing again saves only the reminder — adding it a
   * second time would leave the user with two.
   */
  const [added, setAdded] = useState<Task | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset between openings so the form never shows the previous task's answers
  // — and again if the default priority changes while it is closed, since the
  // settings can be read after this is mounted.
  useEffect(() => {
    if (!isOpen) {
      setTitle("");
      setDue("today");
      setPriority(defaultPriority);
      setCategory(NO_CATEGORY);
      setRecurrence(null);
      setRoutine(NO_ROUTINE);
      setReminder(NEW_TASK_REMINDER);
      setAdded(null);
      setIsSaving(false);
      setError(null);
    }
  }, [isOpen, defaultPriority]);

  // The Routine field reads the routine store, and Ctrl+N can open this on a
  // page that never read it — Settings, Cleanup — where an empty list would
  // tell someone with routines to go and build one. Once read, the store is
  // kept current by every save in this window and by `useWindowSync` for the
  // others, so only an empty list is worth asking again about.
  useEffect(() => {
    if (isOpen && useRoutineStore.getState().routines.length === 0) void loadRoutines();
  }, [isOpen, loadRoutines]);

  const trimmed = title.trim();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || isSaving) return;

    setIsSaving(true);
    setError(null);

    let task = added;
    if (!task) {
      try {
        task = await createTask({
          title: trimmed,
          priority,
          category_id: categoryIdFromField(category),
          due_date: dueDateFor(due),
          routine_id: routineIdFromField(routine),
          recurrence,
        });
      } catch (cause) {
        setIsSaving(false);
        // Shown in the form as well as in a toast: the message usually names
        // the field to fix, and the form is where the fixing happens.
        setError(String(cause));
        toast.error("Could not add task", { description: String(cause) });
        return;
      }
    }

    // After the task, since a reminder hangs off a task that exists. A new
    // task has nothing to clear, so "None" costs no call.
    if (reminderInput(reminder) !== null) {
      try {
        await saveTaskReminder(task.id, reminder);
      } catch (cause) {
        setAdded(task);
        setIsSaving(false);
        setError(String(cause));
        return;
      }
    }

    // A repeating task can land on a different day from the one picked —
    // the backend moves it to the schedule's first real occurrence — so the
    // toast reports where it actually went.
    toast.success("Task added", {
      description: task.recurrence_id
        ? `${task.title} — ${formatRecurrence(recurrence)}, from ${formatRelativeDate(
            task.due_date,
          )}`
        : task.title,
    });
    setQuickAddOpen(false);
  }

  return (
    <Dialog open={isOpen} onOpenChange={setQuickAddOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Add task</DialogTitle>
          <DialogDescription className="sr-only">
            Enter a title, pick a due date, a priority, a category, how often it repeats and a
            reminder, then add the task.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Locked once the task is saved and only its reminder is left: an
              edit here would no longer reach the task. */}
          <fieldset disabled={added !== null} className="flex min-w-0 flex-col gap-4">
            <Input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs doing?"
              aria-label="Task title"
            />

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="quick-add-due" className="text-xs text-muted-foreground">
                  Due
                </Label>
                <Select value={due} onValueChange={(value) => setDue(value as DueOption)}>
                  <SelectTrigger id="quick-add-due" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DUE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="quick-add-priority" className="text-xs text-muted-foreground">
                  Priority
                </Label>
                <Select
                  value={priority}
                  onValueChange={(value) => setPriority(value as TaskPriority)}
                >
                  <SelectTrigger id="quick-add-priority" className="w-full">
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

              <TaskCategoryField idPrefix="quick-add" value={category} onChange={setCategory} />

              <TaskRoutineField idPrefix="quick-add" value={routine} onChange={setRoutine} />
            </div>

            <RecurrencePicker
              idPrefix="quick-add"
              value={recurrence}
              onChange={setRecurrence}
            />
          </fieldset>

          {/* This form has no due time, so "minutes before" is always a step
              away: the edit dialog, where the due time is. */}
          <TaskReminderField
            idPrefix="quick-add"
            value={reminder}
            onChange={setReminder}
            hasDueDate={due !== "none"}
            hasDueTime={false}
            noDueTimeReason="“Minutes before” needs a due time. Add one by editing the task."
          />

          {error && <InlineError message={error} onDismiss={() => setError(null)} />}

          {added && (
            <p className="text-xs text-muted-foreground">
              &ldquo;{added.title}&rdquo; was added without its reminder. Change the reminder and
              save it, or close this to keep the task as it is.
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!trimmed || isSaving}>
              {added ? (isSaving ? "Saving…" : "Save reminder") : isSaving ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default QuickAddTask;
