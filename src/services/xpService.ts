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
 * {@link completeQuest} is the one exception, because a quest is finished by
 * the user ticking it off rather than by anything the backend can observe. It
 * is still guarded — once per quest per day, only on the day in question, and
 * for what section 43 says the quest's band is worth rather than for whatever
 * was asked.
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
 * The quest is passed rather than looked up because the day's quests are
 * generated from the date (`src/lib/quests.ts`) instead of stored — the row
 * behind a completion is created here, at the moment it is first needed,
 * keyed by the quest's own id and the day.
 *
 * Idempotent per quest per day: a second call, from a later load or from
 * another window that reached the same conclusion at the same moment, answers
 * with the completion the first one recorded and grants nothing more. So the
 * safe pattern is to check {@link listQuestCompletions} to avoid the toast,
 * not to avoid the call.
 *
 * `xpAwarded` is what was actually granted, which is not necessarily the
 * quest's current `xpReward`: a completion recorded under an older balance
 * answers with the figure it was paid. Rejects a quest dated to any day but
 * today — yesterday's unfinished objectives are not a pile of XP waiting to
 * be collected.
 *
 * Whether the quest's requirements were *met* is the caller's judgement: they
 * are a client-side rule over counts the frontend already has, so the
 * checklist that knows "Complete 3 tasks" means three tasks is the thing that
 * decides when to call this.
 */
export async function completeQuest(
  quest: Quest,
  dateKey: string,
): Promise<QuestCompletion> {
  return invoke<QuestCompletion>("complete_quest", {
    // Only the three fields the backend needs to identify and price the
    // quest. The requirements are a frontend rule and there is nothing
    // useful the database could do with them.
    quest: { id: quest.id, type: quest.type, title: quest.title },
    dateKey,
  });
}
