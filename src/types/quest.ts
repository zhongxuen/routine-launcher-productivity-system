/**
 * Daily quest types — development-plan.md section 44's "TODAY'S OBJECTIVES",
 * and the `quests` / `quest_completions` rows of section 62 as the UI needs
 * them.
 *
 * A quest here is **not** a stored row. Section 62's schema can hold one, but
 * writing three rows a day forever to describe a list that is a pure function
 * of the date would be storing a derivation: `src-tauri/src/services/quests.rs`
 * generates the day's quests from a fixed pool by calendar day, so any window,
 * on any run, on any machine, shows the same three for the same date without
 * a table having to agree. What is worth storing is the other half —
 * {@link QuestCompletion}, the fact that one was finished and XP was granted
 * for it — because that is a thing that happened rather than a thing that can
 * be recomputed.
 *
 * Rust owns the definitions and the counting (section 88): {@link Quest}
 * arrives from `get_daily_quests` with the day's counts already in it, and
 * `complete_quest` re-counts them before it pays. Nothing here decides
 * whether a quest is done; `lib/quests.ts` only turns the counts into a tick
 * and a progress line.
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
 * The things about a day that a quest can be measured against — the
 * `DailyMetric` enum in `services/quests.rs`, which says exactly what each
 * one counts.
 *
 * Every one of these is countable from work the user has already done —
 * completed tasks, finished focus sessions, launched routines, and cleanup
 * actions confirmed in one of the cleanup utilities — so a tick on the
 * checklist always means the work is really done. Launches are *distinct*
 * routines, so pressing START ten times on one routine is one (section 88).
 */
export type DailyMetric =
  | "tasksCompleted"
  | "focusSessionsCompleted"
  | "focusMinutes"
  | "routinesLaunched"
  | "downloadsCleanups"
  | "desktopCleanups"
  | "screenshotCleanups";

/**
 * How many cleanup actions each utility recorded on one local day — the
 * `get_cleanup_day` payload.
 *
 * Actions, not files: organizing forty screenshots at once is one. Storage
 * has no entry because it has no file actions.
 */
export interface CleanupDay {
  downloads: number;
  desktop: number;
  duplicates: number;
  largeFiles: number;
  screenshots: number;
}

/**
 * One condition a quest needs met, with the day's count against it. A quest's
 * conditions combine with AND.
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
  /** The day's count as Rust read it from the database. Not capped. */
  current: number;
}

/** One of the day's objectives, as `get_daily_quests` sends it. */
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
  /** What finishing it pays: section 43's band, 50 daily or 25 maintenance. */
  xpReward: number;
  /** Everything that has to be true. Never empty. */
  requirements: QuestRequirement[];
  /**
   * The in-app route where the work is done, drawn as a link on the quest's
   * title. The cleanup quests set it to their utility's `/cleanup` page.
   *
   * A link and nothing more: following it opens the page, and whatever
   * happens to a file after that is the user's own scan, selection and
   * confirmation (section 67).
   */
  href?: string;
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
