import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { announceDataChanged } from "@/lib/window-sync";
import {
  atTimeReminder,
  clearTaskReminder,
  formatLeadTime,
  minutesBeforeReminder,
  setTaskReminder,
} from "@/services/notificationService";
import { useTaskStore } from "@/stores/taskStore";
import type { ReminderInput, TaskReminder } from "@/types/notification";

/** The select's value for "no reminder" — Select cannot hold "". */
const NO_REMINDER = "none";

/** The select's value for section 24's "At 5:00 PM". */
const AT_TIME = "at_time";

/** Section 24's "10 minutes before", and the round numbers either side of it. */
const LEAD_TIMES = [5, 10, 15, 30, 60];

/**
 * What the field holds: the option picked, and the time typed for "At a
 * time". The two are kept apart so that trying a lead time and coming back
 * does not lose the time already typed.
 */
export interface ReminderDraft {
  /** `NO_REMINDER`, `AT_TIME`, or a lead time in minutes. */
  choice: string;
  /** Local 24-hour `HH:MM`, or "" before one is typed. */
  atTime: string;
}

/** Section 24's default: nobody is reminded about a task they did not ask about. */
export const NO_REMINDER_DRAFT: ReminderDraft = { choice: NO_REMINDER, atTime: "" };

/** "N minutes before" as the field's value — section 52's default reminder. */
export function leadTimeDraft(minutes: number): ReminderDraft {
  return { choice: String(minutes), atTime: "" };
}

/** A stored reminder as the field's value. */
export function reminderDraft(reminder: TaskReminder | null): ReminderDraft {
  if (!reminder) return NO_REMINDER_DRAFT;
  return reminder.kind === "at_time"
    ? { choice: AT_TIME, atTime: reminder.at_time ?? "" }
    : { choice: String(reminder.minutes_before), atTime: "" };
}

/** The field's value as the backend takes it, or null for "no reminder". */
export function reminderInput(draft: ReminderDraft): ReminderInput | null {
  if (draft.choice === NO_REMINDER) return null;
  if (draft.choice === AT_TIME) return atTimeReminder(draft.atTime);
  return minutesBeforeReminder(Number(draft.choice));
}

/**
 * Whether the field says something other than the stored reminder.
 *
 * Compared as configuration only. Saving a reminder resets its delivery, so
 * re-sending an unchanged one would quietly undo a snooze the user asked for.
 */
export function reminderChanged(draft: ReminderDraft, stored: TaskReminder | null): boolean {
  const before = reminderInput(reminderDraft(stored));
  return JSON.stringify(reminderInput(draft)) !== JSON.stringify(before);
}

/**
 * Writes the field's value onto a task that is already saved — after the
 * task, because whether the reminder is allowed depends on the due date and
 * time that same save may have changed.
 *
 * Rejects with the backend's own sentence when the task cannot carry the
 * reminder, for the form to show as it is.
 */
export async function saveTaskReminder(taskId: number, draft: ReminderDraft): Promise<void> {
  const input = reminderInput(draft);
  await (input ? setTaskReminder(taskId, input) : clearTaskReminder(taskId));

  // The reminder is drawn on the task's row, and neither the list on screen
  // nor the other windows know it changed. Fire-and-forget: the write is done.
  void useTaskStore.getState().refresh();
  announceDataChanged("tasks");
}

interface TaskReminderFieldProps {
  /** Prefixed onto the control's id so two forms can be open at once. */
  idPrefix: string;
  value: ReminderDraft;
  onChange: (value: ReminderDraft) => void;
  /** Whether the task will have a due date once saved. */
  hasDueDate: boolean;
  /** Whether it will have a due time too — what "minutes before" counts back from. */
  hasDueTime: boolean;
  /** Why the lead times are unavailable, for a form with its own way to add a due time. */
  noDueTimeReason?: string;
  className?: string;
}

/**
 * The "Reminder" field on the task forms (section 24): none, a lead time
 * before the task is due, or a time of day on its due date.
 *
 * An option the task cannot use yet is disabled, with one line saying why,
 * rather than hidden — the answer is a due date or time away, and the user
 * should be able to see that. Everything finer (the time's format, a stored
 * reminder the new dates no longer support) is left to the backend, whose
 * refusal the form shows.
 */
function TaskReminderField({
  idPrefix,
  value,
  onChange,
  hasDueDate,
  hasDueTime,
  noDueTimeReason = "“Minutes before” needs a due time to count back from.",
  className,
}: TaskReminderFieldProps) {
  const id = `${idPrefix}-reminder`;

  // A stored lead time this list does not offer still has to be shown, or
  // the trigger goes blank and reads as "no reminder".
  const current = Number(value.choice);
  const leadTimes =
    Number.isInteger(current) && current > 0 && !LEAD_TIMES.includes(current)
      ? [...LEAD_TIMES, current].sort((a, b) => a - b)
      : LEAD_TIMES;

  const reason = !hasDueDate
    ? "A reminder needs the task to have a due date."
    : !hasDueTime
      ? noDueTimeReason
      : null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Reminder
      </Label>
      <div className="flex gap-2">
        <Select value={value.choice} onValueChange={(choice) => onChange({ ...value, choice })}>
          <SelectTrigger id={id} className="w-full min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_REMINDER}>None</SelectItem>
            {leadTimes.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)} disabled={!hasDueTime}>
                {formatLeadTime(minutes)}
              </SelectItem>
            ))}
            <SelectItem value={AT_TIME} disabled={!hasDueDate}>
              At a time
            </SelectItem>
          </SelectContent>
        </Select>
        {value.choice === AT_TIME && (
          <Input
            type="time"
            aria-label="Reminder time"
            className="w-32"
            value={value.atTime}
            onChange={(event) => onChange({ ...value, atTime: event.target.value })}
          />
        )}
      </div>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
    </div>
  );
}

export default TaskReminderField;
