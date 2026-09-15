/**
 * Typed wrappers around the progression Tauri commands — XP, levels, streaks,
 * achievements and quest rewards (development-plan.md sections 43-47, 63, 88).
 *
 * This is the "Service" layer of React UI -> Service -> Tauri Command ->
 * Rust -> SQLite (section 86): components and stores import from here and
 * never call `invoke` themselves.
 *
 * # There is no `awardXp`, and that is the design
 *
 * XP is earned from the completions built in the earlier stages, and every
 * grant is hooked inside the service that owns the completion rather than
 * exposed as a command:
 *
 * | Event | Earned by calling | Worth |
 * |---|---|---|
 * | A task is completed | `taskService.updateTask({ status: "completed" })` | +10, once per task |
 * | A focus session finishes | `focusService.endFocusSession({ completed: true })` | +25, once per session |
 * | A routine is launched | `routineService.launchRoutine` | +10, **first launch of the day only** |
 *
 * So the only way to earn XP from the frontend is to do the productive thing,
 * which is section 88's whole point — and it is why there is nothing here a
 * bug, or a devtools console, could call to mint some. After any of those
 * three, re-read {@link getProgress} to pick up what changed;
 * {@link listXpTransactions} says what the last grant was actually for.
 *
 * {@link completeQuest} is the one exception: the checklist asks for a quest to
 * be paid when it sees one finished. It only names the quest. Rust checks that
 * the quest is one of today's, re-counts its requirement from the database,
 * and pays once per quest per day for what section 43 says the band is worth
 * — so calling it for a quest that is not done earns nothing.
 *
 * Every command rejects with a plain, user-presentable string on failure, so
 * callers can surface `String(error)` straight to a toast.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  Achievement,
  LevelProgress,
  Progress,
  StreakProgress,
  XpTransaction,
} from "@/types/progress";
import type { Quest, QuestCompletion } from "@/types/quest";

/**
 * How many ledger rows {@link listXpTransactions} reads back by default. The
 * backend caps any request at 500 regardless.
 */
export const XP_HISTORY_LIMIT = 100;

// ---------------------------------------------------------------------------
// Reading where the user stands
// ---------------------------------------------------------------------------

/**
 * Level, streak and lifetime XP in one call — what the dashboard's Progress
 * widget and the Progress page both open with.
 *
 * Cheap and idempotent, so calling it from an effect on every mount is the
 * intended use: re-reading is how the UI picks up XP earned since the last
 * time it looked. It also recomputes the streak on the way through, so
 * opening the app the morning after a productive day shows that day already
 * counted rather than waiting for the first completion of the new one.
 */
export async function getProgress(): Promise<Progress> {
  return invoke<Progress>("get_progress");
}

/**
 * Section 45's `{level, xpIntoLevel, xpForNextLevel}` on its own, for a caller
 * that wants the bar without the streak.
 *
 * Pair it with `xpFraction` from `@/types/progress` to fill the bar.
 */
export async function getLevelProgress(): Promise<LevelProgress> {
  return invoke<LevelProgress>("get_level_progress");
}

/**
 * Section 46's streak, recomputed from the days that actually counted.
 *
 * A day counts if the user completed at least one task, completed a focus
 * session, or launched a routine. A run that ends yesterday is still current
 * — today is not over — so the flame does not go out at midnight and come
 * back with the first task of the morning.
 */
export async function getStreak(): Promise<StreakProgress> {
  return invoke<StreakProgress>("get_streak");
}

/**
 * The XP ledger, newest first — section 63's audit trail, and the reason the
 * backend stores transactions rather than a running total.
 *
 * This is also how a "+10 XP" line finds out what just happened: after a
 * completion the first row is the grant it earned, or is not, if one of the
 * anti-farming rules declined it — which is itself the thing worth knowing.
 */
export async function listXpTransactions(
  limit: number = XP_HISTORY_LIMIT,
): Promise<XpTransaction[]> {
  return invoke<XpTransaction[]>("list_xp_transactions", { limit });
}

/**
 * All six of section 47's achievements, in seed order, locked ones included —
 * the grid shows what is still to earn as well as what is earned.
 *
 * Unlocking happens in the backend as the qualifying event lands, so this is
 * always a read of a decision already made: nothing here can unlock anything.
 * Use `isUnlocked` and `achievementFraction` from `@/types/progress` rather
 * than testing `unlockedAt` and dividing by hand.
 */
export async function listAchievements(): Promise<Achievement[]> {
  return invoke<Achievement[]>("list_achievements");
}

// ---------------------------------------------------------------------------
// Daily quests (sections 44, 62)
// ---------------------------------------------------------------------------

/**
 * The day's quests (`YYYY-MM-DD`), each with the day's counts against its
 * requirements — two or three, at the daily quest count Settings holds.
 *
 * The pool, the day's pick and the counting all live in Rust
 * (`services/quests.rs`), which is also what {@link completeQuest} checks
 * against. Put each one through `evaluateQuest` from `@/lib/quests` to draw
 * it; there is nothing to decide on this side.
 */
export async function getDailyQuests(dateKey: string): Promise<Quest[]> {
  return invoke<Quest[]>("get_daily_quests", { dateKey });
}

/**
 * The quests already paid for on a local date (`YYYY-MM-DD`).
 *
 * The checklist finds out a quest is finished by re-counting the day, so it
 * keeps concluding that a finished objective is finished, in every window, for
 * the rest of the day. This is how it tells that from one that has not been
 * paid for yet — and the reason the answer comes from the database rather
 * than from anything a single window remembers.
 */
export async function listQuestCompletions(dateKey: string): Promise<QuestCompletion[]> {
  return invoke<QuestCompletion[]>("list_quest_completions", { dateKey });
}

/**
 * Records a finished quest and pays for it, answering with what was granted.
 *
 * Only the id is sent. The title, the reward and the requirement come from
 * Rust's own definition of the quest, and the row behind a completion is
 * created there, at the moment it is first needed, keyed by the quest's id
 * and the day.
 *
 * Idempotent per quest per day: a second call, from a later load or from
 * another window that reached the same conclusion at the same moment, answers
 * with the completion the first one recorded and grants nothing more. So the
 * safe pattern is to check {@link listQuestCompletions} to avoid the toast,
 * not to avoid the call.
 *
 * `xpAwarded` is what was actually granted, which is not necessarily the
 * quest's current `xpReward`: a completion recorded under an older balance
 * answers with the figure it was paid.
 *
 * Rejects, with a sentence fit for the user, a quest dated to any day but
 * today, one today does not offer, and one whose requirement the database
 * says is not met yet ("…is not finished yet: 2 of 3 tasks so far today.").
 * The checklist only calls this for quests Rust's own counts show as done, so
 * a rejection means the day changed between the read and the call.
 */
export async function completeQuest(
  questId: string,
  dateKey: string,
): Promise<QuestCompletion> {
  return invoke<QuestCompletion>("complete_quest", { questId, dateKey });
}
