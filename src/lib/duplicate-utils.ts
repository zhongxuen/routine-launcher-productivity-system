/**
 * Formatting and selection helpers for the Duplicate Finder
 * (development-plan.md sections 38, 40, 67).
 *
 * Pure functions only. Nothing here reads or writes a file, and nothing here
 * decides that an action should happen — the store owns the selection and the
 * service owns the disk. What this module does own is the arithmetic the
 * confirmation step depends on: {@link fullySelectedGroups} is what lets the
 * dialog say "every copy of photo.png is selected" out loud instead of letting
 * the user discover it afterwards.
 */

import type {
  DuplicateAction,
  DuplicateActionReport,
  DuplicateFile,
  DuplicateGroup,
  FileActionResult,
} from "@/types/duplicates";

/**
 * Bytes as section 40's mockup writes them: "4.2 MB", "812 KB", "0 KB".
 *
 * Decimal units, matching what Explorer's size column and a browser's download
 * list say about the same files. One decimal place from MB up, none below —
 * "1.4 KB" is noise, "4.2 MB" is the number somebody decides on.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1_000) return "1 KB";

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1_000;
  let unit = 0;

  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * How long ago a copy was written — "Today", "3 days ago", "2 years ago".
 *
 * Age is most of how somebody tells an original from a copy of it, and an
 * exact timestamp is not: nobody keeps a photo because it was saved at 14:07.
 */
export function formatAge(modifiedMs: number | null): string {
  if (modifiedMs === null) return "Unknown date";

  const days = Math.floor((Date.now() - modifiedMs) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;

  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

/** "12 groups", "1 group", "No duplicates" — the summary line's subject. */
export function formatGroupCount(count: number): string {
  if (count === 0) return "No duplicates";
  return `${count} ${count === 1 ? "group" : "groups"}`;
}

/** "4 files", "1 file", "No files". */
export function formatFileCount(count: number): string {
  if (count === 0) return "No files";
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** How long the scan took, in the roughest useful terms. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return "under a second";
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** The folder's own name, for a path that is too long to print in a row. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Every file in every group, flattened — the pool a selection draws from. */
export function allFiles(groups: DuplicateGroup[]): DuplicateFile[] {
  return groups.flatMap((group) => group.files);
}

/** The files whose paths are in `selected`, in scan order. */
export function selectedFiles(
  groups: DuplicateGroup[],
  selected: ReadonlySet<string>,
): DuplicateFile[] {
  return allFiles(groups).filter((file) => selected.has(file.path));
}

/** Total size of the given files, for "4 files selected · 1.2 GB". */
export function totalBytes(files: DuplicateFile[]): number {
  return files.reduce((total, file) => total + file.sizeBytes, 0);
}

/**
 * The copies in a group — everything except the one Rust suggests keeping.
 *
 * What the per-group "Select the copies" button ticks. It is a shortcut
 * through a selection the user could make by hand, not a different rule: the
 * suggestion is visible on the row it belongs to, and unticking it is one
 * click.
 */
export function copiesIn(group: DuplicateGroup): DuplicateFile[] {
  return group.files.filter((file) => !file.suggestedKeep);
}

/**
 * The groups where every single copy is currently selected.
 *
 * The one thing the confirmation has to say out loud. Selecting every file in
 * a group is allowed — sometimes a duplicate set is simply unwanted, and
 * refusing would be the app overruling the user — but it is also the one
 * selection that leaves nothing behind, and it is easy to arrive at by
 * clicking a header checkbox without meaning to.
 */
export function fullySelectedGroups(
  groups: DuplicateGroup[],
  selected: ReadonlySet<string>,
): DuplicateGroup[] {
  return groups.filter(
    (group) =>
      group.files.length > 0 && group.files.every((file) => selected.has(file.path)),
  );
}

/**
 * Turns per-path outcomes into the report the view shows afterwards.
 *
 * Sizes come from the scan rather than from Rust's answer, because the file
 * being described is gone by the time the answer arrives — the bytes freed are
 * only knowable from what was there before.
 */
export function buildActionReport(
  action: DuplicateAction,
  destination: string | null,
  outcomes: FileActionResult[],
  files: DuplicateFile[],
): DuplicateActionReport {
  const sizes = new Map(files.map((file) => [file.path, file.sizeBytes]));
  const succeeded = outcomes.filter((outcome) => outcome.ok);

  return {
    action,
    destination,
    succeeded: succeeded.length,
    failed: outcomes.length - succeeded.length,
    bytes: succeeded.reduce((total, outcome) => total + (sizes.get(outcome.path) ?? 0), 0),
    outcomes,
  };
}
