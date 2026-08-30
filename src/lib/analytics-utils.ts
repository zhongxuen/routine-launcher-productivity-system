/**
 * Rendering helpers for the productivity statistics of development-plan.md
 * sections 36 and 82.
 *
 * The backend sends counts, seconds and `YYYY-MM-DD` keys and holds no
 * opinion about wording — "Wednesday", "78%" and "2h 15m" are decided here,
 * next to the panel that draws them, the same way `xpFraction` in
 * `types/progress.ts` turns a level into a bar.
 *
 * Focus time itself is formatted by `formatFocusTime` in `routine-utils.ts`
 * rather than again here, so section 33's "36h 20m" and section 36's "2h 15m"
 * round the same way.
 */

import { format } from "date-fns";

import { parseDateKey } from "@/lib/task-utils";
import type { DayStats, PeriodStats } from "@/types/analytics";

/**
 * Section 36's "Completion: 75%", or null when nothing was owed.
 *
 * A window with no tasks in it has no completion rate — 0/0 is not 0%, and a
 * page that opened on "0%" would be telling a user who had nothing scheduled
 * that they had failed. The panel renders the null as a dash.
 *
 * Rounded to whole percent because that is how the mockups write it, and
 * clamped because `tasksCompleted` can only exceed `tasksTotal` if the two
 * halves were read either side of a completion — a transient the UI should
 * ride out rather than render as "104%".
 */
export function completionPercent({ tasksCompleted, tasksTotal }: PeriodStats): number | null {
  if (tasksTotal <= 0) return null;
  return Math.min(100, Math.round((tasksCompleted / tasksTotal) * 100));
}

/** The same fraction from 0 to 1, for a progress bar. */
export function completionFraction(period: PeriodStats): number {
  const percent = completionPercent(period);
  return percent === null ? 0 : percent / 100;
}

/** `"2026-08-26"` becomes `"Wednesday"` — section 36's most productive day. */
export function weekdayName(dateKey: string): string {
  const date = parseDateKey(dateKey);
  return date ? format(date, "EEEE") : dateKey;
}

/** The one-letter column heading over a day in the streak calendar. */
export function weekdayInitial(dateKey: string): string {
  const date = parseDateKey(dateKey);
  return date ? format(date, "EEEEE") : "?";
}

/** `"26 Aug"`, for a tooltip on a bar or a square. */
export function shortDate(dateKey: string): string {
  const date = parseDateKey(dateKey);
  return date ? format(date, "d MMM") : dateKey;
}

/** `"25 Aug – 31 Aug"` — the range under the This Week heading. */
export function periodRange({ start, end }: PeriodStats): string {
  return `${shortDate(start)} – ${shortDate(end)}`;
}

/**
 * How tall a day's bar is, from 0 to 1, relative to the busiest day shown.
 *
 * Relative rather than against a fixed target, because there is no "right"
 * number of focused hours in a day and drawing one against an invented
 * ceiling would imply there is (section 88). A week with no focus at all
 * gives every day zero rather than dividing by it.
 */
export function focusBarFraction(day: DayStats, days: DayStats[]): number {
  const busiest = days.reduce((most, candidate) => Math.max(most, candidate.focusSeconds), 0);
  return busiest <= 0 ? 0 : day.focusSeconds / busiest;
}

/**
 * The streak history split into weeks of seven, oldest first.
 *
 * The backend sends a flat run of days ending today, so the last row is the
 * current part-week and the grid reads bottom-right as "now". Chunking here
 * rather than in the payload keeps the wire shape a simple list.
 */
export function inWeeks(days: DayStats[], size = 7): DayStats[][] {
  const weeks: DayStats[][] = [];
  for (let index = 0; index < days.length; index += size) {
    weeks.push(days.slice(index, index + size));
  }
  return weeks;
}

/**
 * What one day of the streak calendar says on hover: the date, and what made
 * it count — or that nothing did.
 */
export function dayTooltip(day: DayStats): string {
  if (!day.productive) return `${shortDate(day.date)} — nothing recorded`;

  const parts: string[] = [];
  if (day.tasksCompleted > 0) {
    parts.push(`${day.tasksCompleted} task${day.tasksCompleted === 1 ? "" : "s"}`);
  }
  if (day.focusSessions > 0) {
    parts.push(`${day.focusSessions} focus session${day.focusSessions === 1 ? "" : "s"}`);
  }
  if (day.routineLaunches > 0) {
    parts.push(`${day.routineLaunches} routine${day.routineLaunches === 1 ? "" : "s"}`);
  }

  return `${shortDate(day.date)} — ${parts.join(", ")}`;
}
