/**
 * Starter routines for the Templates tab (development-plan.md section 64).
 *
 * A template is nothing more than a pre-filled {@link NewRoutine}: adding one
 * calls the same `create_routine` command the builder does, and what comes
 * back is an ordinary routine with no memory of where it came from. There is
 * deliberately no "template" concept in the database — a starting point the
 * user cannot then edit freely would be a worse version of the builder.
 *
 * The targets are the names the programs are known by on `PATH` (`code`,
 * `wt`, `slack`), not absolute paths, because an absolute path guessed here
 * would be wrong on most machines. `resolve_executable` in
 * `src-tauri/src/services/routine_exec.rs` searches `PATH` and `PATHEXT`, so
 * a bare name resolves when the program is installed normally — and when it
 * is not, the launch panel says so per action and the routine can be edited
 * to point at the real thing. That is why the Templates view tells the user
 * to check the targets rather than pretending the guesses are certain.
 *
 * Every action type used here is one the backend already runs: `application`,
 * `url` and `timer`. `command` is left out on purpose — it is off until the
 * user turns it on (section 66), and a starter routine whose steps are
 * skipped by default would be a puzzle rather than a starting point.
 */

import type { NewRoutine } from "@/types/routine";

export interface RoutineTemplate {
  /** Stable identity for the list; never stored. */
  id: string;
  /** One line on the card, above the action list. */
  summary: string;
  /** Exactly what `createRoutine` will be handed. */
  routine: NewRoutine;
}

/**
 * Section 21's routine, and the template Start My Day offers when no
 * start-of-day routine is set.
 *
 * Section 21's "Open task dashboard" has no action: Start My Day is pressed
 * on the dashboard, so the dashboard is already open. Its "work applications"
 * differ too much between people to guess at — the builder is where they are
 * added. The timer is the planning session's ten minutes, so the routine says
 * so when launched from its own card as well.
 */
export const START_MY_DAY_TEMPLATE: RoutineTemplate = {
  id: "start-my-day",
  summary: "Calendar and email, then 10 minutes to plan the day.",
  routine: {
    name: "Start My Day",
    description: "Calendar and email open; the dashboard is already up.",
    icon: "☀️",
    actions: [
      { type: "url", target: "https://calendar.google.com" },
      { type: "url", target: "https://mail.google.com" },
      { type: "timer", target: "10" },
    ],
  },
};

/**
 * Section 52's "🌙 End My Day", and the template the end-of-day review
 * (section 22) offers when no end-of-day routine is set.
 *
 * The calendar is for tomorrow, which is what the review's "Review tomorrow"
 * is about too; the ten minutes are for wrapping up — closing what is open
 * and noting where to pick up. Like Start My Day's, the targets are guesses
 * and the builder opens so they can be checked.
 */
export const END_MY_DAY_TEMPLATE: RoutineTemplate = {
  id: "end-my-day",
  summary: "Tomorrow's calendar, then 10 minutes to wrap up.",
  routine: {
    name: "End My Day",
    description: "Look at tomorrow, note where you stopped, close the day.",
    icon: "🌙",
    actions: [
      { type: "url", target: "https://calendar.google.com" },
      { type: "timer", target: "10" },
    ],
  },
};

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "coding-mode",
    summary: "Editor, terminal and repo, then a 50-minute block.",
    routine: {
      name: "Coding Mode",
      description: "Everything needed to start on the current project.",
      icon: "💻",
      actions: [
        { type: "application", target: "code" },
        { type: "application", target: "wt" },
        { type: "url", target: "https://github.com" },
        { type: "timer", target: "50" },
      ],
    },
  },
  {
    id: "study-mode",
    summary: "Notes and references, then a 25-minute pomodoro.",
    routine: {
      name: "Study Mode",
      description: "Sit down, open the notes, start the clock.",
      icon: "📚",
      actions: [
        { type: "url", target: "https://www.notion.so" },
        { type: "url", target: "https://scholar.google.com" },
        { type: "timer", target: "25" },
      ],
    },
  },
  {
    id: "work-mode",
    summary: "Mail, calendar and chat, then a 45-minute block.",
    routine: {
      name: "Work Mode",
      description: "The morning open-everything, in one press.",
      icon: "💼",
      actions: [
        { type: "url", target: "https://mail.google.com" },
        { type: "url", target: "https://calendar.google.com" },
        { type: "application", target: "slack" },
        { type: "timer", target: "45" },
      ],
    },
  },
  START_MY_DAY_TEMPLATE,
  END_MY_DAY_TEMPLATE,
];
