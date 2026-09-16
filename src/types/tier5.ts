/**
 * Wire types for development-plan.md section 92's Tier 5 features: application
 * usage, calendar integration, the sync folder, the phone companion and shared
 * routine files.
 *
 * Each mirrors its Rust payload in `src-tauri/src/services/` (`app_usage.rs`,
 * `calendar.rs`, `sync.rs`, `companion.rs`, `routine_share.rs`) field for
 * field. All are camelCase on the wire.
 */

import type { RoutineActionType } from "@/types/routine";

/* -------------------------------------------------------------------------- */
/* Application usage (section 37)                                             */
/* -------------------------------------------------------------------------- */

export interface AppUsageTotal {
  /** The executable's file name, e.g. `Code.exe`. */
  appName: string;
  exePath: string | null;
  seconds: number;
  daysUsed: number;
}

export interface AppUsageDay {
  /** Local `YYYY-MM-DD`. */
  date: string;
  seconds: number;
}

export interface AppUsageSummary {
  trackingEnabled: boolean;
  from: string;
  to: string;
  totalSeconds: number;
  /** Most used first. */
  apps: AppUsageTotal[];
  /** Every day of the range, oldest first. */
  days: AppUsageDay[];
}

/* -------------------------------------------------------------------------- */
/* Calendar (sections 53, 92)                                                 */
/* -------------------------------------------------------------------------- */

export interface CalendarEvent {
  id: number;
  source: "file" | "feed";
  title: string;
  location: string | null;
  date: string;
  /** `HH:MM`, null for an all-day event. */
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
}

export interface CalendarStatus {
  feedUrl: string | null;
  /** UTC `YYYY-MM-DD HH:MM:SS`. */
  feedRefreshedAt: string | null;
  feedError: string | null;
  feedEvents: number;
  fileName: string | null;
  fileImportedAt: string | null;
  fileEvents: number;
}

/* -------------------------------------------------------------------------- */
/* Sync folder (section 92)                                                   */
/* -------------------------------------------------------------------------- */

export type SyncState =
  | "not_configured"
  | "unavailable"
  | "empty"
  | "up_to_date"
  | "local_changes"
  | "remote_changes"
  | "conflict"
  | "first_sync"
  | "remote_too_new";

export interface SyncRemote {
  deviceId: string;
  deviceName: string;
  /** UTC `YYYY-MM-DD HH:MM:SS`. */
  writtenAt: string;
  appVersion: string;
  isThisDevice: boolean;
}

export interface SyncStatus {
  state: SyncState;
  folder: string | null;
  deviceName: string;
  autoSync: boolean;
  lastSyncedAt: string | null;
  remote: SyncRemote | null;
  message: string | null;
}

/* -------------------------------------------------------------------------- */
/* Phone companion (section 92)                                               */
/* -------------------------------------------------------------------------- */

export interface CompanionStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** Pairing links, token included. Empty while off. */
  links: string[];
  /** The first link as an SVG QR code. */
  qrSvg: string | null;
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Shared routine files (section 92)                                          */
/* -------------------------------------------------------------------------- */

export interface RoutinePreviewAction {
  type: RoutineActionType;
  target: string;
  arguments: string | null;
  enabled: boolean;
  /** Something to know before importing, or null. */
  note: string | null;
}

export interface RoutinePreview {
  path: string;
  /** The name it will be created with, after any de-duplication. */
  name: string;
  description: string | null;
  icon: string | null;
  appVersion: string;
  actions: RoutinePreviewAction[];
  commandsDisabled: number;
  missingPaths: number;
}
