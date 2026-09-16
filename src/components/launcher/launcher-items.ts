/**
 * What the quick launcher lists, and what the search box does to it
 * (development-plan.md section 28).
 *
 * ```text
 * │ 🚀 Coding                    │
 * │ 📚 Study                     │
 * │ 💼 Work                      │
 * │ + Add Task                   │
 * │ ⏱ Start Focus                │
 * ```
 *
 * Section 28's list is routines and then two quick actions, and that order is
 * the ranking: routines are what the launcher is *for*, and the actions are
 * the two things worth doing without one. Both halves are filtered by the
 * query, because a search box that only searched half its own list would be a
 * search box the user has to remember the shape of.
 *
 * Kept out of the component because it is the part with rules in it — which
 * routines are offered, in what order, and what counts as a match — and the
 * component is a keyboard-driven list that would rather not also be arguing
 * about any of that.
 */

import { quickStartRoutines } from "@/components/dashboard/QuickStart";
import type { RoutineWithActions } from "@/types/routine";

/**
 * The two quick actions of section 28's mockup, section 21's Start My Day,
 * section 22's Review My Day, and every routine.
 */
export type LauncherItemKind =
  | "routine"
  | "add-task"
  | "start-focus"
  | "start-my-day"
  | "review-my-day";

export interface LauncherItem {
  /** Stable across renders and unique within a list — the DOM id is built from it. */
  key: string;
  kind: LauncherItemKind;
  /** What the row reads. A routine's own name, as the mockup draws it. */
  label: string;
  /** The routine's emoji, or null for the quick actions and for icon-less routines. */
  icon: string | null;
  /** A quieter second line — what this row will actually do. */
  hint: string;
  /** The routine behind a `routine` row. Null for the quick actions. */
  routine: RoutineWithActions | null;
  /** Extra words the query may match, beyond the label. */
  keywords: string;
}

/**
 * The full list, unfiltered: routines most-used first, then the quick
 * actions (section 28's two, and Start My Day).
 *
 * The ordering is `quickStartRoutines`, the same ranking the dashboard's
 * QUICK START row and the popup's launch button use — asked here for every
 * routine rather than the top few, because this list has a search box in
 * front of it. Two surfaces disagreeing about which routine is the obvious
 * one would be worse than either answer, and with an empty query this list's
 * first row is exactly the dashboard's first tile.
 *
 * Only routines that would actually do something are offered. A routine whose
 * every action is disabled reports success having opened nothing, which is
 * the same rule the routine card, the dashboard tile and the popup apply.
 */
export function launcherItems(routines: RoutineWithActions[]): LauncherItem[] {
  const launchable = routines.filter(hasEnabledActions);

  const routineItems: LauncherItem[] = quickStartRoutines(launchable, launchable.length).map(
    (routine) => ({
      key: `routine-${routine.id}`,
      kind: "routine",
      label: routine.name,
      icon: routine.icon,
      hint: routine.description?.trim() || actionCount(routine),
      routine,
      keywords: routine.description ?? "",
    }),
  );

  return [...routineItems, ...QUICK_ACTIONS];
}

/**
 * Section 28's `+ Add Task` and `⏱ Start Focus`, then section 21's Start My
 * Day and section 22's Review My Day — after the two the mockup draws, since
 * each is used once a day where they are used all day.
 *
 * Their keywords are the words someone would plausibly type looking for them
 * — "new" for adding, "timer" and "pomodoro" for focusing, "morning" for the
 * day — because the labels are the only other thing the query has to match
 * and none is the only name for what it does.
 */
const QUICK_ACTIONS: LauncherItem[] = [
  {
    key: "action-add-task",
    kind: "add-task",
    label: "Add Task",
    icon: null,
    hint: "Adds it to today",
    routine: null,
    keywords: "new todo create task",
  },
  {
    key: "action-start-focus",
    kind: "start-focus",
    label: "Start Focus",
    icon: null,
    hint: "Opens the timer in the app",
    routine: null,
    keywords: "timer pomodoro session concentrate",
  },
  {
    key: "action-start-my-day",
    kind: "start-my-day",
    label: "Start My Day",
    icon: null,
    hint: "Opens today's summary in the app",
    routine: null,
    keywords: "morning plan planning begin today routine",
  },
  {
    key: "action-review-my-day",
    kind: "review-my-day",
    label: "Review My Day",
    icon: null,
    hint: "Opens today's review in the app",
    routine: null,
    keywords: "end my day evening finish wrap up tomorrow summary routine",
  },
];

/**
 * The rows matching `query`.
 *
 * Substring rather than fuzzy, on the label and the keywords, case-folded. A
 * launcher over a list this size does not need to be clever, and a fuzzy
 * match that put "Study" above "Coding" for the query `cod` would be clever
 * at the user's expense. An empty query matches everything, which is the
 * mockup's resting state.
 */
export function filterLauncherItems(items: LauncherItem[], query: string): LauncherItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;

  return items.filter((item) =>
    `${item.label} ${item.keywords}`.toLowerCase().includes(needle),
  );
}

/** True when the routine has at least one action that would actually run. */
function hasEnabledActions(routine: RoutineWithActions): boolean {
  return routine.actions.some((action) => action.enabled);
}

/** The fallback hint for a routine with no description: what launching it opens. */
function actionCount(routine: RoutineWithActions): string {
  const count = routine.actions.filter((action) => action.enabled).length;
  return count === 1 ? "1 action" : `${count} actions`;
}
