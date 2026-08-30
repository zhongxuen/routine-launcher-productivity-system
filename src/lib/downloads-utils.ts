/**
 * Formatting and selection helpers for Downloads Cleanup
 * (development-plan.md sections 38-39).
 *
 * Pure functions only — nothing here reads or writes a file, and nothing here
 * decides that an action should happen. The store owns the selection; this
 * module only turns numbers into the words section 39's mockup prints.
 */

import type { CategoryCount, FileCategoryId, ScannedFile } from "@/types/downloads";

/**
 * Bytes as the mockup writes them: "2.4 GB", "812 KB", "0 KB".
 *
 * Decimal units rather than binary, because that is what a browser's download
 * list and Explorer's size column say, and this panel is describing the same
 * files those do. One decimal place from MB up, none below — "1.4 KB" is
 * noise, "2.4 GB" is the number somebody is actually deciding on.
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

  const decimals = unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/**
 * How long ago a file was downloaded, in the roughest terms that are still
 * useful — "Today", "3 days ago", "8 months ago".
 *
 * Age is most of how somebody decides whether a download is still wanted, and
 * an exact timestamp is not: nobody keeps a ZIP because it arrived at 14:07.
 */
export function formatAge(modifiedAt: number | null): string {
  if (modifiedAt === null) return "Unknown date";

  const days = Math.floor((Date.now() - modifiedAt * 1_000) / 86_400_000);
  if (days < 0) return "Today";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;

  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

/** "147 files", "1 file", "No files" — the mockup's count line. */
export function formatFileCount(count: number): string {
  if (count === 0) return "No files";
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * The folder a moved file ended up in, named rather than printed in full.
 *
 * Takes the file's *new* path and answers with the containing folder's name,
 * so "moved into Archive" reads as a place instead of as a second copy of the
 * filename the user just saw.
 */
export function parentFolderName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  // The last part is the file itself; the one before it is where it landed.
  return parts[parts.length - 2] ?? filePath;
}

/**
 * The label for a category id, taken from the counts Rust sent rather than
 * from a second copy of the same five words.
 *
 * Falls back to the id so a category added on the Rust side shows up as
 * something rather than as blank.
 */
export function categoryLabel(categories: CategoryCount[], id: FileCategoryId): string {
  return categories.find((entry) => entry.category === id)?.label ?? id;
}

/**
 * The files a filter is currently showing, largest first.
 *
 * `null` means "all of them". The scan already arrives sorted, so this only
 * ever narrows — which is what keeps the review list in the same order the
 * summary's "Largest" line refers to.
 */
export function filesInCategory(
  files: ScannedFile[],
  category: FileCategoryId | null,
): ScannedFile[] {
  if (category === null) return files;
  return files.filter((file) => file.category === category);
}

/** Total size of the given files, for the "you selected 4 files · 1.2 GB" line. */
export function totalBytes(files: ScannedFile[]): number {
  return files.reduce((total, file) => total + file.size_bytes, 0);
}
