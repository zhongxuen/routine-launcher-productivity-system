/**
 * The read side of the cleanup record (development-plan.md sections 44, 67).
 *
 * The cleanup utilities' move, delete, archive and organize commands each
 * write a row to `cleanup_actions` in Rust, after the files have been
 * handled and only when at least one of them was. There is nothing here that
 * writes one: the only way to put cleanup on the record is to do it, through
 * the review flow a utility already has.
 */

import { invoke } from "@tauri-apps/api/core";

import type { CleanupDay } from "@/types/quest";

/**
 * How many cleanup actions each utility recorded on a local date,
 * `YYYY-MM-DD`. What the cleanup quests are measured against.
 */
export async function getCleanupDay(dateKey: string): Promise<CleanupDay> {
  return invoke<CleanupDay>("get_cleanup_day", { dateKey });
}
