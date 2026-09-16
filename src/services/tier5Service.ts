/**
 * Development-plan.md section 92's Tier 5 features, on this side of the
 * `invoke` boundary (section 86): application usage, calendar integration,
 * the sync folder, the phone companion and shared routine files.
 *
 * As with `backupService.ts`, file and folder pickers are the frontend's
 * (the OS dialog is the honest way to ask), and only the chosen path crosses
 * the bridge; reading and writing are Rust's.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import type { RoutineWithActions } from "@/types/routine";
import type {
  AppUsageSummary,
  CalendarEvent,
  CalendarStatus,
  CompanionStatus,
  RoutinePreview,
  SyncStatus,
} from "@/types/tier5";

/** The dialog plugin answers `string | string[] | null`; one path is wanted. */
function single(chosen: string | string[] | null): string | null {
  return Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
}

/* -------------------------------------------------------------------------- */
/* Application usage (section 37)                                             */
/* -------------------------------------------------------------------------- */

export async function getAppUsage(days: number): Promise<AppUsageSummary> {
  return invoke<AppUsageSummary>("get_app_usage", { days });
}

export async function getUsageTrackingEnabled(): Promise<boolean> {
  return invoke<boolean>("get_usage_tracking_enabled");
}

/** Answers what was stored. */
export async function setUsageTrackingEnabled(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_usage_tracking_enabled", { enabled });
}

export async function clearAppUsage(): Promise<void> {
  return invoke<void>("clear_app_usage");
}

/* -------------------------------------------------------------------------- */
/* Calendar (sections 53, 92)                                                 */
/* -------------------------------------------------------------------------- */

export async function getCalendarStatus(): Promise<CalendarStatus> {
  return invoke<CalendarStatus>("get_calendar_status");
}

export async function listCalendarEvents(date: string): Promise<CalendarEvent[]> {
  return invoke<CalendarEvent[]>("list_calendar_events", { date });
}

export async function pickCalendarFile(): Promise<string | null> {
  return single(
    await openDialog({
      title: "Import a calendar",
      multiple: false,
      directory: false,
      filters: [{ name: "iCalendar", extensions: ["ics", "ical", "ifb", "icalendar"] }],
    }),
  );
}

export async function importCalendarFile(path: string): Promise<CalendarStatus> {
  return invoke<CalendarStatus>("import_calendar_file", { path });
}

export async function clearCalendarFile(): Promise<CalendarStatus> {
  return invoke<CalendarStatus>("clear_calendar_file");
}

/** Saves the address and reads it once. A failed read is on the status. */
export async function setCalendarFeed(url: string): Promise<CalendarStatus> {
  return invoke<CalendarStatus>("set_calendar_feed", { url });
}

export async function refreshCalendarFeed(): Promise<CalendarStatus> {
  return invoke<CalendarStatus>("refresh_calendar_feed");
}

export async function clearCalendarFeed(): Promise<CalendarStatus> {
  return invoke<CalendarStatus>("clear_calendar_feed");
}

/** Asks where to save the tasks calendar; null if cancelled. */
export async function pickTasksCalendarDestination(): Promise<string | null> {
  return saveDialog({
    title: "Export tasks to a calendar file",
    defaultPath: await invoke<string>("default_calendar_export_name"),
    filters: [{ name: "iCalendar", extensions: ["ics"] }],
  });
}

/** Answers how many tasks went in. */
export async function exportTasksCalendar(path: string): Promise<number> {
  return invoke<number>("export_tasks_calendar", { path });
}

/* -------------------------------------------------------------------------- */
/* Sync folder (section 92)                                                   */
/* -------------------------------------------------------------------------- */

/** Emitted by automatic sync when the user has something to decide. */
export const SYNC_ATTENTION_EVENT = "sync://attention";

export async function getSyncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("get_sync_status");
}

export async function pickSyncFolder(): Promise<string | null> {
  return single(
    await openDialog({
      title: "Choose a sync folder (for example, inside OneDrive)",
      multiple: false,
      directory: true,
    }),
  );
}

export async function configureSync(
  folder: string | null,
  deviceName: string | null,
  autoSync: boolean,
): Promise<SyncStatus> {
  return invoke<SyncStatus>("configure_sync", { folder, deviceName, autoSync });
}

export async function syncPush(overwrite = false): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_push", { overwrite });
}

/** Replaces this computer's data. Follow with `reloadAfterRestore`. */
export async function syncPull(overwrite = false): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_pull", { overwrite });
}

/* -------------------------------------------------------------------------- */
/* Phone companion (section 92)                                               */
/* -------------------------------------------------------------------------- */

export async function getCompanionStatus(): Promise<CompanionStatus> {
  return invoke<CompanionStatus>("get_companion_status");
}

export async function setCompanionEnabled(enabled: boolean): Promise<CompanionStatus> {
  return invoke<CompanionStatus>("set_companion_enabled", { enabled });
}

export async function setCompanionPort(port: number): Promise<CompanionStatus> {
  return invoke<CompanionStatus>("set_companion_port", { port });
}

export async function rotateCompanionToken(): Promise<CompanionStatus> {
  return invoke<CompanionStatus>("rotate_companion_token");
}

/* -------------------------------------------------------------------------- */
/* Shared routine files (section 92)                                          */
/* -------------------------------------------------------------------------- */

const ROUTINE_FILTER = [{ name: "Shared routine", extensions: ["json"] }];

export async function pickRoutineDestination(routineId: number): Promise<string | null> {
  return saveDialog({
    title: "Share routine",
    defaultPath: await invoke<string>("suggest_routine_file_name", { id: routineId }),
    filters: ROUTINE_FILTER,
  });
}

export async function exportRoutine(id: number, path: string): Promise<void> {
  return invoke<void>("export_routine", { id, path });
}

export async function pickRoutineFile(): Promise<string | null> {
  return single(
    await openDialog({
      title: "Import a shared routine",
      multiple: false,
      directory: false,
      filters: ROUTINE_FILTER,
    }),
  );
}

/** Reads and checks the file. Creates nothing. */
export async function inspectRoutineFile(path: string): Promise<RoutinePreview> {
  return invoke<RoutinePreview>("inspect_routine_file", { path });
}

/** Creates the routine, with any command switched off. */
export async function importRoutineFile(path: string): Promise<RoutineWithActions> {
  return invoke<RoutineWithActions>("import_routine_file", { path });
}
