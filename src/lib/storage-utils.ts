/**
 * Formatting and ordering for the Storage Overview (development-plan.md
 * section 38).
 *
 * Pure functions over the payloads in `@/types/storage`: no `invoke`, no
 * state, nothing that reads a clock. Everything the page says about a number
 * is decided here so the drive rows, the folder rows and the caption under
 * them cannot round the same bytes two different ways.
 */

import type { Drive, ScanStop, SizedFolder } from "@/types/storage";

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * A size the way Explorer writes it: binary units, one decimal below 100,
 * none above.
 *
 * The same rule `@/types/large-files` uses, and deliberately so — this page
 * links into that one, and a folder called "24.1 GB" here that becomes
 * "25.9 GB" there would make the user distrust both.
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

/** `12` -> `"12 files"`, `1` -> `"1 file"`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * How full a drive is, 0–100.
 *
 * Rounded for display only; the bar and the percentage share it so they
 * cannot disagree. A drive whose total came back as zero — which the backend
 * already refuses to report — would be 0% rather than `NaN%`.
 */
export function percentUsed(drive: Drive): number {
  if (drive.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((drive.usedBytes / drive.totalBytes) * 100));
}

/**
 * True when a drive is full enough to be worth pointing at.
 *
 * 90% rather than a byte figure: 20 GB left is comfortable on a 2 TB disk and
 * nearly nothing on a 256 GB one, and the proportion is what actually
 * predicts running out. It changes the colour of one bar and says so in
 * words; it never changes what the page offers, because the page offers
 * nothing.
 */
export function isNearlyFull(drive: Drive): boolean {
  return percentUsed(drive) >= 90;
}

/** What a drive is called when it has no label of its own. */
export function driveTitle(drive: Drive): string {
  return drive.label.trim() === "" ? `${drive.letter}: drive` : `${drive.label} (${drive.letter}:)`;
}

/**
 * The list as it is shown: largest first, with folders not yet sized at the
 * bottom in the order they will be measured in.
 *
 * Sizes arrive one at a time, so this runs on every update and a row jumps up
 * the list at the moment its own figure lands. That movement is the point —
 * the page is answering "what is biggest" and it should answer it as soon as
 * it can rather than holding a wrong order until the last folder is done.
 * Unsized rows keeping their alphabetical order is what stops the bottom of
 * the list shuffling as well.
 */
export function byLargestFirst(folders: SizedFolder[]): SizedFolder[] {
  return [...folders].sort((a, b) => {
    if (a.size !== null && b.size !== null) return b.size.sizeBytes - a.size.sizeBytes;
    if (a.size !== null) return -1;
    if (b.size !== null) return 1;
    return 0;
  });
}

/** Everything measured so far, which is what the caption totals. */
export function measuredBytes(folders: SizedFolder[]): number {
  return folders.reduce((total, folder) => total + (folder.size?.sizeBytes ?? 0), 0);
}

/**
 * Why a folder's figure is a floor rather than a total, in words.
 *
 * `null` for a cancelled walk: the user pressed Stop, so nothing needs
 * explaining to them, and the row simply goes back to being unmeasured.
 */
export function describeScanStop(stopped: ScanStop): string | null {
  switch (stopped) {
    case "entry_limit":
      return "there are more files in it than one measurement covers";
    case "time_limit":
      return "measuring it was taking too long";
    case "cancelled":
      return null;
  }
}

/**
 * Whether a folder's size is complete, which decides whether the row prints
 * "24.1 GB" or "at least 24.1 GB".
 *
 * Skipped folders do not make it partial. A profile scan skips locked corners
 * of `AppData` on every Windows machine there is, and a figure hedged on
 * every machine would train the user to ignore the hedge — so the count is
 * reported in the row's own caption instead, where it is a fact rather than a
 * warning.
 */
export function isComplete(folder: SizedFolder): boolean {
  return folder.size !== null && folder.size.stopped === null;
}
