import { Button } from "@/components/ui/button";
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
import { formatRecurrence } from "@/lib/recurrence";
import {
  RECURRENCE_FREQUENCIES,
  RECURRENCE_FREQUENCY_LABELS,
  WEEKDAY_LABELS,
  WEEKDAYS,
  type NewTaskRecurrence,
  type RecurrenceFrequency,
  type Weekday,
} from "@/types/task";

/** The select's value when a task does not repeat at all. */
const NEVER = "never";

interface RecurrencePickerProps {
  /** The draft schedule, or null for a one-off task. */
  value: NewTaskRecurrence | null;
  onChange: (value: NewTaskRecurrence | null) => void;
  /** Prefixes the control ids so two pickers can share a page. */
  idPrefix: string;
}

/**
 * The repeat control from development-plan.md section 23: pick a frequency,
 * then only the detail that frequency actually needs — weekdays for Weekly, a
 * day of the month for Monthly, a gap in days for Custom.
 *
 * Everything else is left to the backend. It decides which date the series
 * starts on (the first date the schedule really fires), so this component
 * never computes a date — it only describes the pattern.
 */
function RecurrencePicker({ value, onChange, idPrefix }: RecurrencePickerProps) {
  const frequency = value?.frequency ?? null;
  const days = value?.days_of_week ?? [];
  const interval = value?.interval ?? 1;

  function handleFrequencyChange(next: string) {
    if (next === NEVER) {
      onChange(null);
      return;
    }

    // Each frequency carries only the fields it uses, so switching away from
    // Weekly does not leave orphaned weekdays behind for the backend to
    // ignore.
    onChange({ frequency: next as RecurrenceFrequency });
  }

  /** The detail controls only render once a frequency is chosen. */
  function patch(changes: Partial<NewTaskRecurrence>) {
    if (!value) return;
    onChange({ ...value, ...changes });
  }

  const toggleDay = (day: Weekday) =>
    patch({
      days_of_week: days.includes(day)
        ? days.filter((candidate) => candidate !== day)
        : [...days, day],
    });

  /** Blank or nonsense input falls back to 1 rather than blocking the save. */
  const setInterval = (raw: string) => patch({ interval: Math.max(1, Number(raw) || 1) });

  const setDayOfMonth = (raw: string) =>
    patch({ day_of_month: Math.min(31, Math.max(1, Number(raw) || 1)) });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-repeat`} className="text-xs text-muted-foreground">
          Repeat
        </Label>
        <Select value={frequency ?? NEVER} onValueChange={handleFrequencyChange}>
          <SelectTrigger id={`${idPrefix}-repeat`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEVER}>Does not repeat</SelectItem>
            {RECURRENCE_FREQUENCIES.map((option) => (
              <SelectItem key={option} value={option}>
                {RECURRENCE_FREQUENCY_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {frequency === "weekly" && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Days of the week">
          {WEEKDAYS.map((day) => {
            const selected = days.includes(day);
            return (
              <Button
                key={day}
                type="button"
                size="sm"
                variant={selected ? "default" : "outline"}
                aria-pressed={selected}
                className={cn("h-7 w-11 px-0 text-xs font-normal")}
                onClick={() => toggleDay(day)}
              >
                {WEEKDAY_LABELS[day]}
              </Button>
            );
          })}
        </div>
      )}

      {frequency === "monthly" && (
        <div className="flex items-center gap-2">
          <Label
            htmlFor={`${idPrefix}-day-of-month`}
            className="text-xs text-muted-foreground"
          >
            On day
          </Label>
          <Input
            id={`${idPrefix}-day-of-month`}
            type="number"
            min={1}
            max={31}
            className="h-8 w-20"
            value={value?.day_of_month ?? ""}
            placeholder="Due date"
            onChange={(event) => setDayOfMonth(event.target.value)}
          />
        </div>
      )}

      {(frequency === "weekly" || frequency === "monthly" || frequency === "custom") && (
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-interval`} className="text-xs text-muted-foreground">
            Every
          </Label>
          <Input
            id={`${idPrefix}-interval`}
            type="number"
            min={1}
            className="h-8 w-20"
            value={interval}
            onChange={(event) => setInterval(event.target.value)}
          />
          <span className="text-xs text-muted-foreground">
            {frequency === "weekly" ? "week(s)" : frequency === "monthly" ? "month(s)" : "day(s)"}
          </span>
        </div>
      )}

      {value && (
        <p className="text-xs text-muted-foreground">
          {formatRecurrence(value)}
          {frequency === "weekly" && days.length === 0 && " — from the task's due date"}
          {frequency === "monthly" && !value.day_of_month && " — on the due date's day"}
        </p>
      )}
    </div>
  );
}

export default RecurrencePicker;
