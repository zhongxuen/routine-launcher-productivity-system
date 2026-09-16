/**
 * Settings store — section 52's Daily Settings, as this window last read them
 * (the name section 65 gives it).
 *
 * A store rather than a read per component because the settings are consumed
 * a long way from where they are edited: the Custom preset's length in the
 * focus timer, the priority the quick-add opens on, the reminder the edit
 * dialog suggests, the number of quests on the dashboard. Each of those reads
 * one field from here, and all of them move when the Daily card saves.
 *
 * `daily` is never empty. Until the first read lands it holds the backend's
 * defaults, and a read that fails leaves it there — the same values Rust
 * would have answered with for a fresh install — so no consumer has to handle
 * "settings not loaded" as a state of its own.
 *
 * Other windows hear about a save through `announceDataChanged("settings")`
 * and re-read (`useWindowSync`); nothing but that announcement travels.
 */

import { create } from "zustand";

import { announceDataChanged } from "@/lib/window-sync";
import { getDailySettings, setDailySettings } from "@/services/settingsService";
import { DEFAULT_DAILY_SETTINGS, type DailySettings } from "@/types/settings";

interface SettingsState {
  /** The Daily Settings as last read or saved; the defaults until then. */
  daily: DailySettings;
  /** Whether `daily` has come from the backend at least once. */
  hasLoaded: boolean;
  /** The last read that failed, in user-presentable form. */
  loadError: string | null;

  /**
   * Reads the settings again. Never rejects: a failure is kept in
   * `loadError` and `daily` stays what it was. Resolves to `daily` either
   * way, so a caller that needs a value can await it.
   *
   * Concurrent calls share one read.
   */
  loadDaily: () => Promise<DailySettings>;

  /** `loadDaily`, unless this window has already read them. */
  ensureDaily: () => Promise<DailySettings>;

  /**
   * Saves all ten, and tells the other windows. Rejects with the backend's
   * sentence when a field is refused, leaving `daily` as it was.
   */
  saveDaily: (next: DailySettings) => Promise<DailySettings>;
}

/** The read in flight, shared by everyone who asks while it is. */
let pendingRead: Promise<DailySettings> | null = null;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  daily: DEFAULT_DAILY_SETTINGS,
  hasLoaded: false,
  loadError: null,

  loadDaily() {
    if (pendingRead) return pendingRead;

    pendingRead = getDailySettings()
      .then((daily) => {
        set({ daily, hasLoaded: true, loadError: null });
        return daily;
      })
      .catch((cause: unknown) => {
        console.error("Could not read the daily settings:", cause);
        set({ loadError: String(cause) });
        return get().daily;
      })
      .finally(() => {
        pendingRead = null;
      });

    return pendingRead;
  },

  ensureDaily() {
    return get().hasLoaded ? Promise.resolve(get().daily) : get().loadDaily();
  },

  async saveDaily(next) {
    const daily = await setDailySettings(next);
    set({ daily, hasLoaded: true, loadError: null });
    announceDataChanged("settings");
    return daily;
  },
}));
