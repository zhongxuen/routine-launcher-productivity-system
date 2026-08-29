/**
 * Formatting, labelling and ordering helpers for the routine views.
 *
 * Presentation only, and deliberately backend-agnostic: everything here works
 * on the wire shapes in `src/types/routine.ts`, which are the Rust payloads
 * field for field. Anything the backend decides —
 * whether an action succeeded, how many times a routine has been launched —
 * is read off the value, never recomputed here.
 */

import {
  AppWindow,
  FileText,
  Folder,
  Globe,
  Rocket,
  Terminal,
  Timer,
  type LucideIcon,
} from "lucide-react";

import { parseTimestamp } from "@/lib/task-utils";
import {
  MAX_TIMER_MINUTES,
  ROUTINE_ACTION_TYPE_LABELS,
  type NewRoutineAction,
  type RoutineAction,
  type RoutineActionType,
} from "@/types/routine";
import type { RoutineRunAction } from "@/types/routine-ui";

/* -------------------------------------------------------------------------- */
/* Action presentation                                                        */
/* -------------------------------------------------------------------------- */

/** The icon that stands for each action type in lists and pickers. */
export const ROUTINE_ACTION_ICONS: Record<RoutineActionType, LucideIcon> = {
  application: AppWindow,
  url: Globe,
  folder: Folder,
  file: FileText,
  timer: Timer,
  command: Terminal,
};

/** Shown when a routine has no icon of its own. */
export const DEFAULT_ROUTINE_ICON = Rocket;

/** Placeholder text for the target field: what this type expects. */
export const ROUTINE_ACTION_TARGET_HINTS: Record<RoutineActionType, string> = {
  application: "Code.exe, or the app name",
  url: "https://github.com",
  folder: "C:\\Projects",
  file: "C:\\Projects\\notes.md",
  timer: "50",
  command: "npm run dev",
};

/** The label above the target field, which is not "Target" for every type. */
export const ROUTINE_ACTION_TARGET_LABELS: Record<RoutineActionType, string> = {
  application: "Application",
  url: "URL",
  folder: "Folder path",
  file: "File path",
  timer: "Minutes",
  command: "Command",
};

/** Timer targets are whole minutes stored as text; this is the safe read. */
export function timerMinutes(target: string): number | null {
  const minutes = Number.parseInt(target.trim(), 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

/**
 * The short name an action goes by in a checklist.
 *
 * A run result carries the backend's own `label`, derived from the target
 * alone ("Code", "chrome", "50-minute timer"). This is the display layer's
 * version of the same idea: it reads the way section 29's checklist does —
 * "VS Code", "Chrome", "Start 50-minute timer" rather than the raw path each
 * action points at — and it works on an action that has not been saved yet,
 * which is every row in the builder.
 *
 * Takes only `type` and `target`, so a stored `RoutineAction`, an
 * `ActionResult` from a run and a half-typed draft all go through it.
 *
 * Falls back to the target whenever the friendly form would be empty, so an
 * action is never rendered as a blank line.
 */
export function actionLabel(action: Pick<RoutineAction, "type" | "target">): string {
  const target = action.target.trim();
  if (!target) return ROUTINE_ACTION_TYPE_LABELS[action.type];

  switch (action.type) {
    case "timer": {
      const minutes = timerMinutes(target);
      return minutes ? `Start ${minutes}-minute timer` : "Start timer";
    }
    case "url":
      return hostLabel(target);
    case "application":
      return applicationLabel(target);
    case "folder":
    case "file":
      return lastPathSegment(target) || target;
    case "command":
      return target;
  }
}

/** `https://github.com/user` becomes `github.com`. */
function hostLabel(target: string): string {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(target) ? target : `https://${target}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return target;
  }
}

/**
 * Executable names that nobody calls by their executable name.
 *
 * Section 29's checklist reads "VS Code", "Chrome", "Terminal" — not
 * "Code.exe", "chrome.exe", "wt.exe" — and the schema has nowhere to store a
 * display name (section 60 is type, target, arguments), so the common ones
 * are recognised here. Anything unlisted falls back to its file name, which
 * is what the user typed and therefore still recognisable.
 */
const KNOWN_APPLICATIONS: Record<string, string> = {
  code: "VS Code",
  chrome: "Chrome",
  msedge: "Edge",
  firefox: "Firefox",
  wt: "Terminal",
  windowsterminal: "Terminal",
  powershell: "PowerShell",
  cmd: "Command Prompt",
  explorer: "File Explorer",
  notepad: "Notepad",
  obsidian: "Obsidian",
  spotify: "Spotify",
  slack: "Slack",
  discord: "Discord",
  figma: "Figma",
};

/** `C:\Program Files\VS Code\Code.exe` becomes `VS Code`. */
function applicationLabel(target: string): string {
  const file = lastPathSegment(target) || target;
  const stem = file.replace(/\.(exe|lnk|bat|cmd|app)$/i, "");
  return KNOWN_APPLICATIONS[stem.toLowerCase()] ?? capitalise(stem);
}

const capitalise = (value: string) =>
  value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);

function lastPathSegment(target: string): string {
  const segments = target.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}

/**
 * The focus length a routine carries: the first enabled `timer` action's
 * minutes, or null when it has none.
 *
 * A routine may hold several timers; the first is the one a launch reports
 * (`RoutineRunResult.timer_minutes` picks the same one), so this is the
 * length the routine can be said to be "for".
 */
export function routineTimerMinutes(actions: RoutineAction[]): number | null {
  const timer = actions.find((action) => action.enabled && action.type === "timer");
  return timer ? timerMinutes(timer.target) : null;
}

/**
 * The one-line summary under a routine's name: how many actions it runs, and
 * how long its timer is if it has one.
 */
export function actionSummary(actions: RoutineAction[]): string {
  const enabled = actions.filter((action) => action.enabled);
  if (enabled.length === 0) return "No actions yet";

  const count = `${enabled.length} action${enabled.length === 1 ? "" : "s"}`;
  const minutes = routineTimerMinutes(actions);

  return minutes ? `${count} · ${minutes} min focus` : count;
}

/* -------------------------------------------------------------------------- */
/* Statistics formatting (development-plan.md section 33)                     */
/* -------------------------------------------------------------------------- */

/** `130800` becomes `"36h 20m"`; under an hour it stays in minutes. */
export function formatFocusTime(seconds: number): string {
  if (seconds <= 0) return "0m";

  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** A single session's length, e.g. `"51m"` or `"1h 5m"`. */
export function formatSessionLength(seconds: number): string {
  return seconds <= 0 ? "—" : formatFocusTime(seconds);
}

/**
 * `"Today"`, `"Yesterday"`, `"3 days ago"`, then a date. Section 33's last
 * line, and the one on the routine card.
 */
export function formatLastUsed(timestamp: string | null): string {
  const date = parseTimestamp(timestamp);
  if (!date) return "Never";

  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* -------------------------------------------------------------------------- */
/* Ordering and validation (the builder, section 31)                          */
/* -------------------------------------------------------------------------- */

/**
 * Move one item of a list to another index, returning a new array. Used by
 * the builder's move-up / move-down controls; an out-of-range target index is
 * a no-op so the buttons at the ends need no special casing.
 */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  if (to < 0 || to >= items.length) return items;

  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Why an action cannot be saved yet, or null when it is fine.
 *
 * Kept here rather than in the row component so the Save button and the row
 * agree on what "incomplete" means without one asking the other.
 */
export function actionError(action: NewRoutineAction): string | null {
  const target = action.target.trim();
  if (!target) return `${ROUTINE_ACTION_TARGET_LABELS[action.type]} is required`;
  if (action.type === "timer") {
    const minutes = timerMinutes(target);
    if (minutes === null) return "Timer needs a whole number of minutes";
    // The backend rejects anything longer, so the form does too rather than
    // letting Save be the thing that finds out.
    if (minutes > MAX_TIMER_MINUTES) return `Timer cannot be longer than ${MAX_TIMER_MINUTES / 60} hours`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Run counts (development-plan.md sections 32 and 87)                        */
/* -------------------------------------------------------------------------- */

export interface RunCounts {
  /** Actions that succeeded. */
  completed: number;
  /** Actions that were attempted — skipped ones are not part of the score. */
  attempted: number;
  failed: number;
}

/** The `"3 / 4 actions completed"` line from section 32. */
export function runCounts(actions: RoutineRunAction[]): RunCounts {
  const attempted = actions.filter((entry) => entry.status !== "skipped");
  return {
    completed: attempted.filter((entry) => entry.status === "success").length,
    attempted: attempted.length,
    failed: attempted.filter((entry) => entry.status === "failure").length,
  };
}

/** True once a run has started a timer, for section 32's "Focus timer started". */
export function hasStartedTimer(actions: RoutineRunAction[]): boolean {
  return actions.some(
    (entry) => entry.action.type === "timer" && entry.status === "success",
  );
}
