/**
 * Large File Finder types — development-plan.md sections 38, 41 and 67.
 *
 * These mirror the payloads `src-tauri/src/services/large_files.rs` returns,
 * field for field. That service is camelCase on the wire, like `xp` and
 * unlike the row-mirroring services beside it, because nothing here came out
 * of a table: a scan is computed from the filesystem at the moment it runs
 * and stored nowhere.
 *
 * The values behind these types come from `src/services/largeFileService.ts`,
 * which is the only place that talks to the commands.
 *
 * The formatting helpers at the bottom live here rather than in a component
 * so the list, the confirmation dialogs and the toasts all describe the same
 * file the same way — "2.4 GB" has to read identically in the row the user
 * clicked and in the dialog asking them to confirm it, or the dialog looks
 * like it is talking about something else.
 */

// ---------------------------------------------------------------------------
// A scan
// ---------------------------------------------------------------------------

/** One file over the threshold — a row of section 41's list. */
export interface LargeFile {
  /** Absolute path. The identity every action takes, and unique in a scan. */
  path: string;
  /** File name with extension. */
  name: string;
  /** Absolute path of the containing folder. */
  parent: string;
  /**
   * Where the file sits inside the scanned root (`videos/old`), or `""` when
   * it is directly in it. Shown instead of `parent` because the root is
   * already on screen above the list.
   */
  relativeParent: string;
  sizeBytes: number;
  /** Lower-case extension without the dot, or `null`. */
  extension: string | null;
  /** Last modified, as milliseconds since the Unix epoch. */
  modifiedMs: number | null;
  /**
   * True for a file the backend refuses to move, archive or delete — Windows
   * itself, an installed program, the page file. Open and Ignore still work.
   * The UI disables the other three rather than letting the user find out by
   * confirming one; the backend refuses regardless.
   */
  protected: boolean;
}

/** Why a walk stopped before it had seen the whole tree. */
export type ScanStop = "entry_limit" | "time_limit";

/** Everything the Large Files view draws itself from. */
export interface LargeFileScan {
  root: string;
  thresholdBytes: number;
  /** Largest first. Capped by the backend; see {@link LargeFileScan.truncated}. */
  files: LargeFile[];
  /** How many files were over the threshold in total, ignored ones included. */
  matched: number;
  /** Bytes held by the files in `files` — always the total of what is shown. */
  shownBytes: number;
  filesSeen: number;
  foldersSeen: number;
  /** Matches hidden by the ignore list, so a hidden result is never silent. */
  ignoredMatches: number;
  /** The first few folders that could not be opened, usually for permission. */
  skippedFolders: string[];
  skippedFoldersTotal: number;
  /** True when more files matched than the list can hold. */
  truncated: boolean;
  /** Set when the walk gave up early, so the view can say the answer is partial. */
  stopped: ScanStop | null;
  durationMs: number;
}

/** What the view opens with, before any scan has been run. */
export interface LargeFilePreferences {
  /** The folder the last scan ran over, or `null` on a first run. */
  root: string | null;
  thresholdMb: number;
  /** Ignored paths, as the user's own strings. */
  ignored: string[];
  /** Where Archive puts files. Always set; the backend supplies the default. */
  archiveRoot: string;
  /** True when `archiveRoot` is the app's default rather than a chosen folder. */
  archiveRootIsDefault: boolean;
}

/** What a Move, an Archive or a Delete did. */
export interface FileActionResult {
  from: string;
  /** Where the file is now. `null` for a delete — it is in the Recycle Bin. */
  to: string | null;
  /** The name it ended up with. */
  name: string;
  /** True when the destination already held that name and this one was suffixed. */
  renamed: boolean;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// The five actions of section 41
// ---------------------------------------------------------------------------

/**
 * The actions a row offers. `open` and `ignore` change nothing on disk and go
 * straight through; the other three are the ones {@link isDestructive} names,
 * and none of them happens without a confirmation the user accepted.
 */
export type LargeFileAction = "open" | "move" | "archive" | "delete" | "ignore";

/**
 * The three that change where a file is, and the exact set the confirmation
 * dialog knows how to word.
 *
 * Split out as its own type rather than left as a runtime check so the
 * compiler enforces it: `LargeFileConfirmDialog` takes a
 * `DestructiveAction`, so an action added to {@link LargeFileAction} later
 * cannot reach the dialog without wording being written for it, and cannot
 * be performed without passing through the dialog at all.
 */
export type DestructiveAction = "move" | "archive" | "delete";

/** Whether an action needs the confirmation step of section 67. */
export function isDestructive(action: LargeFileAction): action is DestructiveAction {
  return action === "move" || action === "archive" || action === "delete";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * A file size the way Explorer writes it: binary units, one decimal below
 * 100, none above.
 *
 * Binary rather than decimal because the number has to agree with the one
 * Windows shows for the same file — a finder that called a 2.4 GB video
 * "2.6 GB" would look wrong regardless of which convention is defensible.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** `1500` -> `"1.5 GB"`, for the threshold labels. */
export function formatThreshold(thresholdMb: number): string {
  return formatBytes(thresholdMb * 1024 * 1024);
}

/** How long the scan took, in the units a person would say it in. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** `12` -> `"12 files"`, `1` -> `"1 file"`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * The last couple of segments of a path, for a label that must not wrap.
 *
 * The full path is always available on hover and in every confirmation
 * dialog; this is only ever the short form in a heading or a button.
 */
export function shortenPath(path: string, segments = 2): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= segments) return path;
  return `…${path.slice(0, 1) === "/" ? "/" : "\\"}${parts.slice(-segments).join("\\")}`;
}

/**
 * The exact folder Archive will put a file in — the archive root plus the
 * `YYYY-MM` bucket for the month the file was last changed.
 *
 * Computed here so the confirmation dialog can name the destination *before*
 * anything happens, which is the difference between a confirmation and a
 * formality. It has to agree with `month_folder` in
 * `src-tauri/src/services/large_files.rs`, so like that function it works in
 * UTC: a file must land in the same folder whatever timezone the machine is
 * in when it is archived.
 */
export function archiveDestinationFor(
  archiveRoot: string,
  modifiedMs: number | null,
): string {
  const separator = archiveRoot.includes("\\") ? "\\" : "/";

  if (modifiedMs === null || !Number.isFinite(modifiedMs)) {
    return `${archiveRoot}${separator}undated`;
  }

  const at = new Date(modifiedMs);
  const month = `${at.getUTCMonth() + 1}`.padStart(2, "0");
  return `${archiveRoot}${separator}${at.getUTCFullYear()}-${month}`;
}

/**
 * Why a scan stopped early, as a sentence the view can show under the
 * results.
 *
 * Worth saying rather than hiding: a partial answer that looks complete would
 * have the user conclude there is nothing else big in the tree.
 */
export function describeScanStop(stop: ScanStop): string {
  return stop === "entry_limit"
    ? "The folder was too large to search all of it, so this is the biggest of what was reached. Search a subfolder for a complete answer."
    : "The search ran out of time before it reached the end of the folder, so this is the biggest of what it saw. Search a subfolder for a complete answer.";
}
