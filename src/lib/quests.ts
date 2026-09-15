/**
 * The day's objectives, drawn — development-plan.md section 44.
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
 * Which quests a day offers, what each one asks for, and how far the user has
 * got are all decided in Rust (`src-tauri/src/services/quests.rs`) and arrive
 * through `getDailyQuests` with the day's counts already in them. That is
 * section 88: `complete_quest` re-counts the same requirement from the
 * database before it pays, so the checklist and the payout are one decision
 * rather than two copies of a rule that have to agree.
 *
 * What is left here is presentation: turning those counts into a tick, a
 * fraction and a progress line. Nothing in this file can make a quest count
 * as done that Rust would not pay for.
 */

import type { Quest, QuestRequirement, QuestStatus } from "@/types/quest";

/**
 * The most quests a day can hold — one per track. Section 44's "2-3" is the
 * range the daily quest count setting chooses from; this is its top. Mirrors
 * `MAX_QUEST_COUNT` in `services/settings.rs`.
 */
export const MAX_QUESTS_PER_DAY = 3;

/** The fewest a day holds, whatever the setting says. */
export const MIN_QUESTS_PER_DAY = 2;

/**
 * `count` held inside section 44's 2-3, so a stray value can neither empty
 * the day nor ask for a fourth track that does not exist. Used to size the
 * loading skeleton before the day's quests arrive.
 */
export function clampQuestCount(count: number): number {
  if (!Number.isFinite(count)) return MAX_QUESTS_PER_DAY;
  return Math.min(MAX_QUESTS_PER_DAY, Math.max(MIN_QUESTS_PER_DAY, Math.round(count)));
}

/** `"minute"` and 2 becomes `"minutes"`. English, and only where it is easy. */
const plural = (noun: string, count: number): string =>
  count === 1 ? noun : `${noun}s`;

/** How far one condition has got, capped at its target. */
function requirementProgress(requirement: QuestRequirement): {
  current: number;
  fraction: number;
  isMet: boolean;
} {
  const current = Math.max(0, requirement.current);
  const target = Math.max(1, requirement.target);

  return {
    current: Math.min(current, target),
    fraction: Math.min(1, current / target),
    isMet: current >= target,
  };
}

/**
 * Puts a quest's counts into the shape the checklist draws.
 *
 * `isComplete` is the same rule Rust applies — every count at or past its
 * target — over the same counts, so a tick here is a quest Rust will pay for.
 *
 * The progress line is left off single-step quests — "0 of 1 routines" says
 * nothing the unticked box beside it has not already said — and off finished
 * ones, where the tick is the whole message. What is left is the case it
 * exists for: a quest partway done, where the distance is the point.
 */
export function evaluateQuest(quest: Quest): QuestStatus {
  const measured = quest.requirements.map((requirement) => ({
    requirement,
    ...requirementProgress(requirement),
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
