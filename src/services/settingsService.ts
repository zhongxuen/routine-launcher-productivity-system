/**
 * Section 52's Daily Settings, on this side of the `invoke` boundary.
 *
 * The other settings in the app each belong to one feature and sit in that
 * feature's service (`trayService`, `updateService`, `widgetService`, ...).
 * These nine belong to no single feature — the focus timer, the task forms,
 * the quests and the statistics all read them — so they have a service of
 * their own. See `src-tauri/src/services/settings.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

import type { DailySettings } from "@/types/settings";

/** All nine Daily Settings, each unset one as its default. */
export async function getDailySettings(): Promise<DailySettings> {
  return invoke<DailySettings>("get_daily_settings");
}

/**
 * Stores all nine, answering with what was stored.
 *
 * Rejects with the backend's sentence when any of them is refused — a day
 * that ends before it starts, a routine that has been deleted — and then
 * nothing is written, not even the fields that were fine.
 */
export async function setDailySettings(settings: DailySettings): Promise<DailySettings> {
  return invoke<DailySettings>("set_daily_settings", { settings });
}
