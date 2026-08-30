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
import { useTaskStore } from "@/stores/taskStore";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type NewTaskRecurrence,
  type TaskPriority,
} from "@/types/task";

import RecurrencePicker from "./RecurrencePicker";
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
 * Quick task creation (section 16): title, due date, priority, repeat, Add.
 * Opened by the "+ Add Task" button or Ctrl+N; both go through
 * `isQuickAddOpen` on the store, so anywhere in the app can raise it.
 */
function QuickAddTask() {
  const isOpen = useTaskStore((state) => state.isQuickAddOpen);
  const setQuickAddOpen = useTaskStore((state) => state.setQuickAddOpen);
  const createTask = useTaskStore((state) => state.createTask);

  const [title, setTitle] = useState("");
  const [due, setDue] = useState<DueOption>("today");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [recurrence, setRecurrence] = useState<NewTaskRecurrence | null>(null);
  const [routine, setRoutine] = useState(NO_ROUTINE);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset between openings so the form never shows the previous task's answers.
  useEffect(() => {
    if (!isOpen) {
      setTitle("");
      setDue("today");
      setPriority("normal");
      setRecurrence(null);
      setRoutine(NO_ROUTINE);
      setIsSaving(false);
      setError(null);
    }
  }, [isOpen]);

  const trimmed = title.trim();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || isSaving) return;

    setIsSaving(true);
    setError(null);
    try {
      const created = await createTask({
        title: trimmed,
        priority,
        due_date: dueDateFor(due),
        routine_id: routineIdFromField(routine),
        recurrence,
      });

      // A repeating task can land on a different day from the one picked —
      // the backend moves it to the schedule's first real occurrence — so the
      // toast reports where it actually went.
      toast.success("Task added", {
        description: created.recurrence_id
          ? `${created.title} — ${formatRecurrence(recurrence)}, from ${formatRelativeDate(
              created.due_date,
            )}`
          : created.title,
      });
      setQuickAddOpen(false);
    } catch (cause) {
      setIsSaving(false);
      // Shown in the form as well as in a toast: the message usually names
      // the field to fix, and the form is where the fixing happens.
      setError(String(cause));
      toast.error("Could not add task", { description: String(cause) });
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setQuickAddOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Add task</DialogTitle>
          <DialogDescription className="sr-only">
            Enter a title, pick a due date, a priority and how often it repeats, then add the
            task.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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

            <TaskRoutineField
              idPrefix="quick-add"
              value={routine}
              onChange={setRoutine}
              className="col-span-2"
            />
          </div>

          <RecurrencePicker idPrefix="quick-add" value={recurrence} onChange={setRecurrence} />

          {error && <InlineError message={error} onDismiss={() => setError(null)} />}

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!trimmed || isSaving}>
              {isSaving ? "Adding…" : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default QuickAddTask;
