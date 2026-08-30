/**
 * Progression types — the XP ledger of development-plan.md section 63, the
 * level curve of section 45, the streak of section 46 and the achievements of
 * section 47.
 *
 * These mirror the payloads `src-tauri/src/services/xp.rs` returns, field for
 * field. That service is camelCase on the wire, unlike the row-mirroring
 * services next to it, because half of what it returns is *computed* rather
 * than read from a table — the level curve is arithmetic, and an achievement's
 * progress is a count across four other tables — so there is no row for the
 * whole of it to mirror, and a progression surface that was snake_case in one
 * half and camelCase in the other would be worse than one that picks a side.
 *
 * The daily quests of section 44 are next door in `quest.ts`, because a quest
 * is generated from the date rather than read from here.
 *
 * The values behind these types come from `src/services/xpService.ts`, which
 * is the only place that talks to the commands.
 */

// ---------------------------------------------------------------------------
// XP
// ---------------------------------------------------------------------------

/**
 * What earned a grant — the `source` column of section 63's ledger.
 *
 * Every one is written by the backend from something the user actually did.
 * There is no command that mints XP from the frontend except recording a
 * finished quest, and that is guarded by the quest's own day and by the
 * ledger, so this list is also the complete list of ways to earn any.
 */
export type XpSource =
  | "task_completion"
  | "focus_session"
  | "routine_launch"
  | "daily_objective"
  | "maintenance_quest"
  | "achievement";

/**
 * One row of the ledger section 63 asks for instead of a running total.
 *
 * `sourceId` points into whichever table `source` names — the task, the focus
 * session, the routine, the quest or the achievement that earned it — which
 * is what makes the total on screen explainable rather than merely large.
 */
export interface XpTransaction {
  id: number;
  source: XpSource;
  sourceId: number | null;
  amount: number;
  /** UTC `YYYY-MM-DD HH:MM:SS`, as SQLite's `datetime('now')` writes it. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Levels and streaks
// ---------------------------------------------------------------------------

/**
 * Where the user is inside their current level.
 *
 * `xpIntoLevel` and `xpForNextLevel` are both measured from the start of the
 * level rather than from zero, so the bar is `xpIntoLevel / xpForNextLevel`
 * without needing to know the curve behind it — which is the point, since the
 * curve is the backend's business (`xp::level_for`). Level *n* costs 200n XP,
 * so level 4 costs 800, which is the `620 / 800` section 45 draws.
 */
export interface LevelProgress {
  level: number;
  /** XP earned since reaching `level`. */
  xpIntoLevel: number;
  /** XP the level costs in total. Zero at a hypothetical maximum level. */
  xpForNextLevel: number;
}

/** The `streaks` row: productive days in a row, and the best run so far. */
export interface StreakProgress {
  currentStreak: number;
  longestStreak: number;
  /** The last day that counted, as `YYYY-MM-DD`. Null before the first one. */
  lastActiveDate: string | null;
}

/** Everything the Progress widget shows, in one value. */
export interface Progress {
  level: LevelProgress;
  streak: StreakProgress;
  /** Lifetime XP — the sum of `xp_transactions.amount` (section 63). */
  totalXp: number;
}

/**
 * How full the XP bar is, as a fraction from 0 to 1.
 *
 * Guards the division because a level costing no XP is representable — it is
 * what a maximum level would look like — and a bar is better full than NaN.
 */
export function xpFraction({ xpIntoLevel, xpForNextLevel }: LevelProgress): number {
  if (xpForNextLevel <= 0) return 1;
  return Math.min(1, Math.max(0, xpIntoLevel / xpForNextLevel));
}

// ---------------------------------------------------------------------------
// Achievements (section 47)
// ---------------------------------------------------------------------------

/**
 * Section 47's six, in the order the migration seeds them and the grid draws
 * them.
 *
 * A `const` array rather than a bare union because the grid iterates it — to
 * lay out six skeletons before any data arrives, and to sort the tiles into a
 * fixed order so an unlock never reshuffles the five beside it.
 */
export const ACHIEVEMENT_KEYS = [
  "first_task",
  "first_routine",
  "focused",
  "consistent",
  "organized",
  "deep_work",
] as const;

/** One of {@link ACHIEVEMENT_KEYS}. */
export type AchievementKey = (typeof ACHIEVEMENT_KEYS)[number];

/**
 * How far along a locked achievement is, in whatever unit reads best for it:
 * sessions for Focused, days for Consistent, cleanup quests for Organized and
 * whole hours for Deep Work — because "7 / 10" is a sentence and
 * "25200 / 36000" is not.
 *
 * `current` never exceeds `target`, so a tile cannot read "12 / 10".
 */
export interface AchievementProgress {
  current: number;
  target: number;
}

/** One achievement, with the user's state on it. */
export interface Achievement {
  id: number;
  /**
   * The stable identifier — one of {@link AchievementKey} today.
   *
   * Typed as `string` rather than as the union on purpose: a later migration
   * may seed a seventh, and that should be a new tile in the grid rather than
   * a type error in the UI.
   */
  key: string;
  name: string;
  description: string | null;
  /** A lucide-react icon name, as task categories use. */
  icon: string | null;
  /** When it was unlocked, or null while it is still locked. */
  unlockedAt: string | null;
  /**
   * Progress towards it, or null for the achievements with nothing to count
   * — "Complete your first task" is done or it is not, and a bar reading
   * "0 / 1" beside it says nothing the empty tile did not.
   */
  progress: AchievementProgress | null;
}

/** Whether an achievement has been earned — the grid's locked/unlocked. */
export function isUnlocked(achievement: Achievement): boolean {
  return achievement.unlockedAt !== null;
}

/**
 * How full a locked achievement's bar is, from 0 to 1.
 *
 * Answers 1 for an unlocked achievement and for one with nothing to count, so
 * a caller that renders a bar unconditionally still gets a sensible one; the
 * grid uses `progress` itself to decide whether to draw one at all.
 */
export function achievementFraction(achievement: Achievement): number {
  if (isUnlocked(achievement)) return 1;

  const progress = achievement.progress;
  if (!progress || progress.target <= 0) return 1;

  return Math.min(1, Math.max(0, progress.current / progress.target));
}
