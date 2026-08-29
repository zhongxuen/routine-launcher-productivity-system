/**
 * Progression types — the level curve of development-plan.md section 45 and
 * the streak of section 46, as the UI needs them.
 *
 * Nothing here is stored. {@link LevelProgress} is the answer Stage 9's level
 * command is specified to give — `{level, xpIntoLevel, xpForNextLevel}` — and
 * {@link StreakProgress} is the `streaks` row (section 63's neighbour in
 * `0001_init.sql`) with its columns renamed to the camelCase the rest of the
 * UI is written in.
 *
 * The renaming is the one place this file departs from the convention
 * `task.ts` and `focus.ts` keep, where a type mirrors its row field-for-field
 * so nothing needs reshaping across `invoke`. It departs deliberately: the
 * level half of a `Progress` is *computed* by the backend rather than read
 * from a table, so there is no row for the whole of it to mirror, and half a
 * type in snake_case would be worse than none of it.
 *
 * Until Stage 9 lands, the values behind these types are the mock ones in
 * `src/stores/progressStore.ts`.
 */

/**
 * Where the user is inside their current level.
 *
 * `xpIntoLevel` and `xpForNextLevel` are both measured from the start of the
 * level rather than from zero, so the bar is `xpIntoLevel / xpForNextLevel`
 * without needing to know the curve behind it — which is the point, since the
 * curve is the backend's business (Stage 9, prompt 9.1).
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
