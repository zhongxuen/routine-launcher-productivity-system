/**
 * Typed wrappers around the analytics Tauri commands — the daily and weekly
 * statistics of development-plan.md sections 36 and 82, and the per-routine
 * statistics of section 33.
 *
 * This is the "Service" layer of React UI -> Service -> Tauri Command ->
 * Rust -> SQLite (section 86): components and stores import from here and
 * never call `invoke` themselves.
 *
 * # Everything here is a read, and nothing here is cached
 *
 * There is no `recordX`. Every figure these commands return is an aggregate
 * of work the other services already recorded — a completed task, a finished
 * focus session, a launched routine — so there is nothing the frontend could
 * call to make a week look better than it was, which is section 88's rule
 * applied to the statistics themselves.
 *
 * Nor does the backend keep a running total to go stale: each call re-reads
 * the underlying rows. That makes these safe (and intended) to call from an
 * effect after anything that could have changed them.
 *
 * Every command rejects with a plain, user-presentable string on failure, so
 * callers can surface `String(error)` straight to a toast.
 */

import { invoke } from "@tauri-apps/api/core";

import type { ProductivityStats, RoutineStatistics } from "@/types/analytics";

/**
 * Sections 36 and 82's Today and This Week panels, the week's routine usage,
 * its best day, and four weeks of streak history — in one call.
 *
 * One command rather than seven because the panels are read together and all
 * of them are measured against the same local "today": split across calls, a
 * load that straddled midnight could show a Today panel and a This Week panel
 * that disagreed about which day it was.
 *
 * Recomputes the streak on the way through, the same way `getProgress` in
 * `xpService.ts` does, so opening the app the morning after a productive day
 * shows that day already counted.
 */
export async function getProductivityStats(): Promise<ProductivityStats> {
  return invoke<ProductivityStats>("get_productivity_stats");
}

/**
 * Section 33's five figures for every routine, keyed by routine id.
 *
 * A list rather than a call per routine: the Routines page draws a card for
 * each, and asking once per card would be one round trip per routine on every
 * load. The whole answer is a single grouped join on the backend.
 */
export async function listRoutineStatistics(): Promise<RoutineStatistics[]> {
  return invoke<RoutineStatistics[]>("list_routine_statistics");
}

/**
 * The same figures for one routine, or null if it no longer exists — which is
 * the normal answer for a statistics panel left open while the routine behind
 * it was deleted, not an error.
 */
export async function getRoutineStatistics(
  routineId: number,
): Promise<RoutineStatistics | null> {
  return invoke<RoutineStatistics | null>("get_routine_statistics", { routineId });
}
