/**
 * Backup types (development-plan.md section 69).
 *
 * These mirror the structs in `src-tauri/src/services/backup.rs`, which are
 * `#[serde(rename_all = "camelCase")]` — so unlike `src/types/downloads.ts`
 * and its snake_case neighbours, these read as ordinary TypeScript. The
 * difference is deliberate on the Rust side: this payload is also what gets
 * written into the backup *file*, and a file the user is invited to open and
 * read should not be in two naming conventions at once.
 *
 * Note what is *not* here: the backup's contents. The frontend never holds a
 * backup — it chooses a path and the backend reads or writes it (see
 * `src/services/backupService.ts`). What crosses `invoke` is only ever this
 * description of one.
 */

/** How many rows one table contributed to a backup. */
export interface TableCount {
  /** The SQLite table name, as it appears in the file. */
  table: string;
  rows: number;
}

/**
 * What a backup file contains, without the contents.
 *
 * The same shape comes back from all three of export, inspect and import,
 * because all three are answering "what is in this file" from a different
 * side — after writing it, before restoring it, and after.
 */
export interface BackupInfo {
  /** The file this describes, as the OS spells it. */
  path: string;
  /** The envelope's version. 1 for every file written so far. */
  formatVersion: number;
  /** The database migration the rows in it were written against. */
  schemaVersion: number;
  /** The build that wrote it. */
  appVersion: string;
  /** UTC, `YYYY-MM-DD HH:MM:SS`, like every other timestamp in the app. */
  exportedAt: string;
  /**
   * Per table, parents first. Tables the file does not carry are absent
   * rather than zero — an older backup says nothing about a table that did
   * not exist yet, and import leaves those alone rather than emptying them.
   */
  counts: TableCount[];
  totalRows: number;
  /**
   * Whether restoring this file would switch section 66's command actions on.
   *
   * Surfaced in the import confirmation because it is the one setting in a
   * backup that widens what the app is allowed to do, and a file is a route
   * to it that the Settings switch's own confirmation does not cover.
   */
  enablesCommandActions: boolean;
}

/**
 * Table name -> what to call it in front of a user.
 *
 * The counts come back keyed by the SQLite table, because that is what the
 * file is keyed by and inventing a second vocabulary in Rust would mean two
 * places to change when a table is added. Naming them is presentation, so it
 * happens here. A table with no entry falls back to its own name, which is
 * the right failure: a new table shows up in the list looking raw rather than
 * silently not showing up at all.
 */
export const BACKUP_TABLE_LABELS: Record<string, string> = {
  settings: "Settings",
  task_categories: "Task categories",
  task_recurrence: "Recurrence rules",
  routines: "Routines",
  routine_actions: "Routine actions",
  tasks: "Tasks",
  daily_plans: "Top priorities",
  focus_sessions: "Focus sessions",
  quests: "Quests",
  quest_completions: "Quest completions",
  xp_transactions: "XP history",
  achievements: "Achievements",
  user_achievements: "Unlocked achievements",
  streaks: "Streak",
  routine_launches: "Routine launches",
  cleanup_actions: "Cleanup history",
};

/** The user-facing name of a backed-up table. */
export function backupTableLabel(table: string): string {
  return BACKUP_TABLE_LABELS[table] ?? table;
}

/**
 * The tables worth naming in a one-line summary of a backup.
 *
 * Section 69's own list, minus `settings` — "12 settings" tells a user
 * nothing about whether this is the right file, and "812 tasks, 6 routines"
 * tells them immediately.
 */
export const BACKUP_HEADLINE_TABLES = [
  "tasks",
  "routines",
  "focus_sessions",
  "xp_transactions",
] as const;
