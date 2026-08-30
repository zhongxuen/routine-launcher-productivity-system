/**
 * The day's objectives — development-plan.md section 44.
 *
 * ```text
 * TODAY'S OBJECTIVES
 *
 * □ Complete a 25-minute focus session
 *   +25 XP
 *
 * □ Complete 3 tasks
 *   +50 XP
 * ```
 *
 * Section 44 gives two rules and this file is mostly the second one: *only
 * 2-3 quests should appear per day*, and *do not overwhelm the user*. So the
 * day's list is generated, not rolled. {@link dailyQuests} is a pure function
 * of the date, which buys three things at once:
 *
 * - the same three quests appear in the dashboard and in the popup, in every
 *   window, across a reload, without any of them having to agree with a table;
 * - the list cannot change under the user mid-morning, which a random pick
 *   re-run on every mount would do;
 * - the pool rotates on a fixed cycle, so tomorrow is different from today
 *   without ever being a surprise.
 *
 * The pool is arranged as three **tracks** — tasks, focus, routines — and the
 * day takes exactly one from each. That is what stops a day of three task
 * quests, or three quests the user cannot get to because they are all focus.
 * It also caps the list at three by construction rather than by a `slice`,
 * which is the difference between a rule and a truncation.
 *
 * Every quest is measurable against {@link DailyActivity} — things Stages 1,
 * 2 and 4 already record — so the checklist is honest today, with the XP
 * backend still to come.
 */

import type {
  DailyActivity,
  Quest,
  QuestRequirement,
  QuestStatus,
} from "@/types/quest";

/* -------------------------------------------------------------------------- */
/* The pool                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Section 43's reward bands. A daily objective is worth 50 and a lighter one
 * 25 — the two amounts section 44's own example prints beside its lines.
 *
 * These are what the *label* says. The grant itself is the backend's (Stage
 * 9, prompt 9.1: "daily objective/quest complete +50, maintenance/cleanup
 * quest +25"), and `quests.xp_reward` is per-quest precisely so a quest can
 * be worth less than the band's top without the rule changing.
 */
const XP_FULL = 50;
const XP_LIGHT = 25;

/**
 * The three tracks, each holding the alternatives for one slot in the day.
 *
 * Two per track is deliberate: it is enough that today and tomorrow differ,
 * and few enough that the user has seen all six within a week and knows what
 * the app asks of them. A pool nobody can hold in their head is a pool that
 * reads as random.
 *
 * The pairs are also easy/harder rather than two of the same weight, so a
 * quiet day and a heavy one both have a version of the list that is winnable
 * — section 46's "keep the requirement achievable", applied to quests.
 */
const QUEST_TRACKS: Quest[][] = [
  // Tasks — the productivity system's own unit of work.
  [
    {
      id: "tasks-3",
      type: "objective",
      title: "Complete 3 tasks",
      xpReward: XP_FULL,
      requirements: [{ metric: "tasksCompleted", target: 3, noun: "task" }],
    },
    {
      id: "tasks-1",
      type: "maintenance",
      title: "Complete a task",
      xpReward: XP_LIGHT,
      requirements: [{ metric: "tasksCompleted", target: 1, noun: "task" }],
    },
  ],

  // Focus — section 44's own worked example is the first of these.
  [
    {
      id: "focus-session",
      type: "maintenance",
      title: "Complete a 25-minute focus session",
      xpReward: XP_LIGHT,
      requirements: [
        { metric: "focusSessionsCompleted", target: 1, noun: "session" },
      ],
    },
    {
      id: "focus-50-minutes",
      type: "objective",
      title: "Focus for 50 minutes",
      xpReward: XP_FULL,
      requirements: [{ metric: "focusMinutes", target: 50, noun: "minute" }],
    },
  ],

  // Routines — and the reason this track's harder half is a *pair* of
  // conditions rather than "launch 2 routines" is section 88: a quest that
  // counts launches is a quest that pays for pressing START twice. Section 88
  // names this exact combination as the fix — "routine launch + completed
  // focus session" — so the second condition is what makes the first mean
  // something.
  [
    {
      id: "routine-launch",
      type: "maintenance",
      title: "Launch a routine",
      xpReward: XP_LIGHT,
      requirements: [{ metric: "routinesLaunched", target: 1, noun: "routine" }],
    },
    {
      id: "routine-then-focus",
      type: "objective",
      title: "Launch a routine, then finish a focus session",
      xpReward: XP_FULL,
      requirements: [
        { metric: "routinesLaunched", target: 1, noun: "routine" },
        { metric: "focusSessionsCompleted", target: 1, noun: "session" },
      ],
    },
  ],
];

/** How many quests a day holds — one per track. Section 44's "2-3". */
export const QUESTS_PER_DAY = QUEST_TRACKS.length;

/** Every quest that can ever be offered, for tests and for the record. */
export const QUEST_POOL: Quest[] = QUEST_TRACKS.flat();

/* -------------------------------------------------------------------------- */
/* Picking the day's three                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A `YYYY-MM-DD` key as a count of days, for rotating the pool.
 *
 * Built from the digits rather than from a `Date` on purpose: `new Date(key)`
 * would parse as UTC midnight and then be read in local time, so for anyone
 * west of Greenwich the day number — and therefore the whole quest list —
 * would flip a few hours early or late. `Date.UTC` on the three numbers has
 * no timezone in it at all, which is what a calendar day should not have.
 *
 * Returns null for anything that is not a date key, so a caller with a bad
 * one gets an empty list rather than quests generated from `NaN`.
 */
function dayNumber(dateKey: string): number | null {
  const parts = dateKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;

  const [year, month, day] = parts;
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * The quests for one local day, as `YYYY-MM-DD`.
 *
 * One from each track, chosen by the day's number offset by the track's
 * index, so the tracks do not all flip on the same night — a list where every
 * line changes at once reads as a different app each morning, and one where
 * nothing changes reads as broken.
 */
export function dailyQuests(dateKey: string): Quest[] {
  const day = dayNumber(dateKey);
  if (day === null) return [];

  return QUEST_TRACKS.map((track, index) => track[(day + index) % track.length]);
}

/* -------------------------------------------------------------------------- */
/* Measuring them                                                             */
/* -------------------------------------------------------------------------- */

/** `"minute"` and 2 becomes `"minutes"`. English, and only where it is easy. */
const plural = (noun: string, count: number): string =>
  count === 1 ? noun : `${noun}s`;

/** How far one condition has got, capped at its target. */
function requirementProgress(
  requirement: QuestRequirement,
  activity: DailyActivity,
): { current: number; fraction: number; isMet: boolean } {
  const current = Math.max(0, activity[requirement.metric]);
  const target = Math.max(1, requirement.target);

  return {
    current: Math.min(current, target),
    fraction: Math.min(1, current / target),
    isMet: current >= target,
  };
}

/**
 * Puts today's numbers through a quest.
 *
 * The progress line is left off single-step quests — "0 of 1 routines" says
 * nothing the unticked box beside it has not already said — and off finished
 * ones, where the tick is the whole message. What is left is the case it
 * exists for: a quest partway done, where the distance is the point.
 */
export function evaluateQuest(quest: Quest, activity: DailyActivity): QuestStatus {
  const measured = quest.requirements.map((requirement) => ({
    requirement,
    ...requirementProgress(requirement, activity),
  }));

  const isComplete = measured.every((step) => step.isMet);
  const fraction = isComplete
    ? 1
    : measured.reduce((total, step) => total + step.fraction, 0) / (measured.length || 1);

  // A multi-condition quest states the condition that is still outstanding
  // rather than both, so the line stays a line: the user needs to know what
  // is left, not to be shown their own receipt.
  const outstanding = measured.filter((step) => !step.isMet);
  const shown = outstanding.find((step) => step.requirement.target > 1) ?? outstanding[0];

  const progressLabel =
    isComplete || !shown || shown.requirement.target <= 1
      ? null
      : `${shown.current} of ${shown.requirement.target} ${plural(shown.requirement.noun, shown.requirement.target)}`;

  return { quest, isComplete, fraction, progressLabel };
}

/** The whole day: its quests, each with today's numbers put through it. */
export function dailyQuestStatuses(
  dateKey: string,
  activity: DailyActivity,
): QuestStatus[] {
  return dailyQuests(dateKey).map((quest) => evaluateQuest(quest, activity));
}
