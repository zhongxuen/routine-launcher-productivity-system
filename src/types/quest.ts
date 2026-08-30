/**
 * Daily quest types — development-plan.md section 44's "TODAY'S OBJECTIVES",
 * and the `quests` / `quest_completions` rows of section 62 as the UI needs
 * them.
 *
 * A quest here is **not** a stored row. Section 62's schema can hold one, but
 * writing three rows a day forever to describe a list that is a pure function
 * of the date would be storing a derivation: `src/lib/quests.ts` generates the
 * day's quests from a fixed pool by calendar day, so any window, on any run,
 * on any machine, shows the same three for the same date without a table
 * having to agree. What is worth storing is the other half —
 * {@link QuestCompletion}, the fact that one was finished and XP was granted
 * for it — because that is a thing that happened rather than a thing that can
 * be recomputed.
 *
 * The camelCase here therefore isn't the row-mirroring convention `task.ts`
 * and `focus.ts` keep; there is no row to mirror. It follows `progress.ts`
 * instead, its nearest neighbour.
 */

/**
 * Which of section 43's two reward bands a quest sits in: an ordinary daily
 * objective, or a maintenance/cleanup chore. Stored as `quests.type`, and it
 * is what the backend's award rule keys off — so it stays on the quest even
 * though {@link Quest.xpReward} is what the UI actually prints.
 */
export type QuestType = "objective" | "maintenance";

/**
 * The four things about today that a quest can be measured against.
 *
 * Every one of these is countable from work the user has already done in
 * Stages 1, 2 and 4 — completed tasks, finished focus sessions, launched
 * routines — which is the whole reason the quest list can be honest before
 * the XP backend exists. Nothing here needs Stage 9's tables.
 *
 * There is deliberately no "files cleaned up" metric yet: the cleanup tools
 * are Stage 10, and a quest that cannot be finished is worse than a quest
 * that isn't offered. Section 44's `Organize Downloads` example joins the
 * pool when there is something to organise with.
 */
export type DailyMetric =
  | "tasksCompleted"
  | "focusSessionsCompleted"
  | "focusMinutes"
  | "routinesLaunched";

/** What the user has actually done today, counted once and measured against. */
export interface DailyActivity {
  /** Tasks whose `completed_at` falls on today. */
  tasksCompleted: number;
  /** Focus sessions that ran to their target today (not the abandoned ones). */
  focusSessionsCompleted: number;
  /** Focused minutes today, excluding time sessions spent paused. */
  focusMinutes: number;
  /**
   * *Distinct* routines launched today, not launches. Section 88's
   * anti-farming rule in the smallest possible form: launching the same
   * routine ten times is one, so a quest cannot be ground out by pressing
   * START repeatedly.
   */
  routinesLaunched: number;
}

/** A day nothing has happened on yet — and the value used while reads fail. */
export const EMPTY_ACTIVITY: DailyActivity = {
  tasksCompleted: 0,
  focusSessionsCompleted: 0,
  focusMinutes: 0,
  routinesLaunched: 0,
};

/**
 * One condition a quest needs met. A quest's conditions combine with AND.
 *
 * `noun` is the singular word for one unit of `metric` as *this* quest counts
 * it ("task", "minute"), so the progress line can read "2 of 3 tasks" without
 * the component knowing what a metric is.
 */
export interface QuestRequirement {
  metric: DailyMetric;
  /** How many are needed. Always at least 1. */
  target: number;
  noun: string;
}

/** One of the day's objectives. */
export interface Quest {
  /**
   * Stable across days — the same quest offered again next week keeps its id,
   * so a completion is keyed by `(id, date)` rather than by position in a
   * list that changes.
   */
  id: string;
  type: QuestType;
  /** The checklist line, written the way section 44 writes it. */
  title: string;
  /** Section 62's `xp_reward`. Section 43's bands: 50 daily, 25 maintenance. */
  xpReward: number;
  /** Everything that has to be true. Never empty. */
  requirements: QuestRequirement[];
}

/** A quest with today's numbers put through it. */
export interface QuestStatus {
  quest: Quest;
  /** Every requirement met. */
  isComplete: boolean;
  /** How far along, 0 to 1 — the mean of the requirements' own fractions. */
  fraction: number;
  /**
   * "2 of 3 tasks", or null when there is nothing useful to say — a quest
   * needing one of something is either done or not, and "0 of 1 routines"
   * only repeats the empty checkbox beside it.
   */
  progressLabel: string | null;
}

/**
 * A finished quest, as `quest_completions` records it (section 62).
 *
 * Keyed by quest *and* day: the pool repeats, and finishing "Complete 3
 * tasks" on Monday must not stop Thursday's copy from paying out — nor let
 * today's pay out twice.
 */
export interface QuestCompletion {
  questId: string;
  /** The local day it was completed on, `YYYY-MM-DD`. */
  dateKey: string;
  /** What was actually granted, which may not be today's `xpReward` forever. */
  xpAwarded: number;
}
