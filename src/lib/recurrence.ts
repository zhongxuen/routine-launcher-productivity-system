/**
 * Turning a stored repeat schedule back into the sentence the user thought
 * they were writing — "Every weekday", "Every Mon, Wed, Fri", "Every 3 days".
 *
 * Section 23 shows schedules as plain prose next to the task, so this is the
 * only place a `TaskRecurrence` is put into words; components never assemble
 * the label from the fields themselves.
 */

import {
  WEEKDAY_LABELS,
  type NewTaskRecurrence,
  type RecurrenceFrequency,
  type TaskRecurrence,
  type Weekday,
} from "@/types/task";

/** The default schedule a picker starts on when the user turns repeat on. */
export const DEFAULT_RECURRENCE: NewTaskRecurrence = { frequency: "daily" };

/** `1` becomes `1st`, `22` becomes `22nd`. */
export function ordinal(day: number): string {
  const remainderTen = day % 10;
  const remainderHundred = day % 100;

  if (remainderTen === 1 && remainderHundred !== 11) return `${day}st`;
  if (remainderTen === 2 && remainderHundred !== 12) return `${day}nd`;
  if (remainderTen === 3 && remainderHundred !== 13) return `${day}rd`;
  return `${day}th`;
}

/** `["MON", "WED"]` becomes `"Mon, Wed"`, in calendar order. */
export const formatWeekdays = (days: Weekday[]): string =>
  days.map((day) => WEEKDAY_LABELS[day]).join(", ");

/** `2` + `"week"` becomes `"2 weeks"`; `1` stays `"week"`. */
const every = (interval: number, unit: string): string =>
  interval === 1 ? unit : `${interval} ${unit}s`;

/**
 * The one-line description of a schedule, e.g. `"Every weekday"` or
 * `"Every 2 weeks on Mon, Fri"`. Works on a stored rule or on the draft a
 * picker is holding, so the form can preview what it is about to save.
 */
export function formatRecurrence(
  rule: TaskRecurrence | NewTaskRecurrence | null | undefined,
): string | null {
  if (!rule) return null;

  const interval = Math.max(1, rule.interval ?? 1);
  const days = (rule.days_of_week ?? []) as Weekday[];

  switch (rule.frequency as RecurrenceFrequency) {
    case "daily":
      return "Every day";
    case "weekdays":
      return "Every weekday";
    case "weekly":
      // With no days chosen the rule falls back to its start date's weekday,
      // which the picker has not necessarily resolved yet.
      if (days.length === 0) return `Every ${every(interval, "week")}`;
      return interval === 1
        ? `Every ${formatWeekdays(days)}`
        : `Every ${interval} weeks on ${formatWeekdays(days)}`;
    case "monthly":
      return rule.day_of_month
        ? `Every ${every(interval, "month")} on the ${ordinal(rule.day_of_month)}`
        : `Every ${every(interval, "month")}`;
    case "custom":
      return `Every ${every(interval, "day")}`;
    default:
      return null;
  }
}
