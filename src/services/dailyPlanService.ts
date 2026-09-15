/**
 * PLAN TODAY's top priorities, on this side of the `invoke` boundary. See
 * `src-tauri/src/services/daily_plans.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

import type { DailyPlan } from "@/types/daily-plan";

/** The priorities picked for `date` (`YYYY-MM-DD`), rank 1 first. */
export async function getDailyPlan(date: string): Promise<DailyPlan> {
  return invoke<DailyPlan>("get_daily_plan", { date });
}

/**
 * Replaces `date`'s priorities with `priorities` (task ids, rank 1 first),
 * answering with what was stored. An empty list clears the day.
 *
 * Rejects with the backend's sentence for a fourth priority, a task listed
 * twice or a task that no longer exists, and then writes nothing.
 */
export async function setDailyPlan(date: string, priorities: number[]): Promise<DailyPlan> {
  return invoke<DailyPlan>("set_daily_plan", { date, priorities });
}
