/**
 * Section 52's Daily Settings.
 *
 * {@link DailySettings} mirrors the payload of `get_daily_settings` /
 * `set_daily_settings` in `src-tauri/src/services/settings.rs` field for
 * field. camelCase on the wire, like `analytics.ts`: it is ten keys of the
 * `settings` table rather than a row, so there is no row shape to mirror.
 *
 * The ranges below are here to draw the controls — which lengths the input
 * accepts, which lead times the select offers. They are not the validation:
 * Rust checks every field on save and the card shows its refusal as it is.
 */

import type { TaskPriority } from "./task";

/** The first day of the statistics' week (sections 36, 82). */
export const WEEK_STARTS = ["monday", "sunday"] as const;

export type WeekStart = (typeof WEEK_STARTS)[number];

export const WEEK_START_LABELS: Record<WeekStart, string> = {
  monday: "Monday",
  sunday: "Sunday",
};

export interface DailySettings {
  /** Local 24-hour `HH:MM`. */
  dayStartTime: string;
  /** Local 24-hour `HH:MM`, after `dayStartTime`. */
  dayEndTime: string;
  /** The length the Custom focus preset starts at, in minutes. */
  defaultFocusMinutes: number;
  /** The priority a new task starts with. */
  defaultTaskPriority: TaskPriority;
  /**
   * "N minutes before" for a task given a due time, or null for no reminder.
   * One of {@link REMINDER_LEAD_TIMES}.
   */
  defaultReminderMinutes: number | null;
  /** The routine Start My Day launches, or null. */
  startOfDayRoutineId: number | null;
  /** The routine End My Day launches, or null. */
  endOfDayRoutineId: number | null;
  /** How many of the day's quests appear. {@link QUEST_COUNTS}. */
  dailyQuestCount: number;
  weekStart: WeekStart;
  /**
   * One native notification at `dayEndTime` offering the end-of-day review
   * (section 22). Off by default: the review is optional and never opens on
   * its own.
   */
  endOfDayNotification: boolean;
}

/**
 * What an unset setting reads as — the backend's defaults, repeated so a
 * window has sensible values to draw before its first read comes back.
 */
export const DEFAULT_DAILY_SETTINGS: DailySettings = {
  dayStartTime: "09:00",
  dayEndTime: "18:00",
  defaultFocusMinutes: 50,
  defaultTaskPriority: "normal",
  defaultReminderMinutes: null,
  startOfDayRoutineId: null,
  endOfDayRoutineId: null,
  dailyQuestCount: 3,
  weekStart: "monday",
  endOfDayNotification: false,
};

/** The range of the default focus length, in minutes. */
export const MIN_DEFAULT_FOCUS_MINUTES = 5;
export const MAX_DEFAULT_FOCUS_MINUTES = 240;

/** The lead times a default reminder can have — the task forms' own five. */
export const REMINDER_LEAD_TIMES = [5, 10, 15, 30, 60] as const;

/** Section 44: "Only 2–3 quests should appear per day." */
export const QUEST_COUNTS = [2, 3] as const;
