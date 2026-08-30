/**
 * Formatting and filtering helpers for the Screenshot Organizer
 * (development-plan.md sections 38, 42).
 *
 * Pure functions only — nothing here reads or writes a file, and nothing here
 * decides that an action should happen. The store owns the selection; this
 * module only turns numbers into the words section 42's mockup prints.
 */

import { format, isToday, isYesterday } from "date-fns";

import type { Grouping, Screenshot, ScreenshotBucket } from "@/types/screenshot";

/**
 * Bytes as a person reads them: "2.4 GB", "812 KB".
 *
 * Decimal units rather than binary, because that is what Explorer's size
 * column and macOS's Finder say, and this panel is describing the same files
 * those do. Deliberately a local copy rather than an import from another
 * cleanup tool's helpers: the four utilities in section 38 are independent of
 * each other, and a shared `cleanup-utils` is worth extracting once they have
 * all landed rather than now.
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

/** "147 screenshots", "1 screenshot", "No screenshots". */
export function formatScreenshotCount(count: number): string {
  if (count === 0) return "No screenshots";
  return `${count} ${count === 1 ? "screenshot" : "screenshots"}`;
}

/**
 * When a screenshot was taken: "Today, 14:30", "Yesterday, 09:12",
 * "12 Jul, 16:04", "4 Mar 2024".
 *
 * The time is kept for anything inside the last two days and dropped beyond
 * them, because that is where it stops helping: two screenshots from this
 * afternoon are told apart by the clock, and two from last spring are not.
 */
export function formatCapturedAt(modifiedEpoch: number): string {
  if (!modifiedEpoch) return "Date unknown";

  const at = new Date(modifiedEpoch * 1_000);
  if (Number.isNaN(at.getTime())) return "Date unknown";

  if (isToday(at)) return `Today, ${format(at, "HH:mm")}`;
  if (isYesterday(at)) return `Yesterday, ${format(at, "HH:mm")}`;

  const thisYear = at.getFullYear() === new Date().getFullYear();
  return thisYear ? format(at, "d MMM, HH:mm") : format(at, "d MMM yyyy");
}

/**
 * The heading each bucket gets, in section 42's own words.
 *
 * Section 42 prints three; `older` is the fourth this app needs and the
 * mockup does not name, because the mockup shows a total on top of the three
 * and the review list has to put the remainder somewhere.
 */
export const BUCKET_LABELS: Record<ScreenshotBucket, string> = {
  today: "Today",
  thisWeek: "This week",
  thisMonth: "This month",
  older: "Older",
};

/**
 * What each bucket actually means, said out loud.
 *
 * The windows roll from today's midnight rather than following calendar weeks
 * and months, so that each line contains the one above it — which is what
 * makes the panel's three descending numbers readable. That is a definition
 * worth printing rather than leaving the user to infer from figures that
 * would otherwise look inconsistent on the 1st of a month.
 */
export const BUCKET_HINTS: Record<ScreenshotBucket, string> = {
  today: "since midnight",
  thisWeek: "last 7 days",
  thisMonth: "last 30 days",
  older: "more than 30 days ago",
};

/** The screenshots a bucket filter is showing. `null` means all of them. */
export function screenshotsInBucket(
  screenshots: Screenshot[],
  bucket: ScreenshotBucket | null,
): Screenshot[] {
  if (bucket === null) return screenshots;
  return screenshots.filter((screenshot) => screenshot.bucket === bucket);
}

/**
 * How many screenshots are in each bucket *exclusively* — Today's are not
 * counted again under This week.
 *
 * This is the opposite of the cumulative figures section 42's panel prints,
 * and both are right for their own job: the panel is describing how much has
 * piled up recently, while a filter chip has to say how many rows pressing it
 * will show. A chip reading 38 that then showed 26 rows would be lying about
 * itself.
 */
export function bucketCounts(screenshots: Screenshot[]): Record<ScreenshotBucket, number> {
  const counts: Record<ScreenshotBucket, number> = {
    today: 0,
    thisWeek: 0,
    thisMonth: 0,
    older: 0,
  };
  screenshots.forEach((screenshot) => {
    counts[screenshot.bucket] += 1;
  });
  return counts;
}

/** Total size of the given screenshots, for the "4 selected · 12.1 MB" line. */
export function totalBytes(screenshots: Screenshot[]): number {
  return screenshots.reduce((total, screenshot) => total + screenshot.bytes, 0);
}

/**
 * The `YYYY-MM` folder a screenshot would land in under
 * {@link Grouping} `byMonth`.
 *
 * Only ever used to *preview* the layout in the confirmation dialog. Rust
 * works the real folder name out again from the file's own timestamp, so a
 * clock skew between the two windows cannot put a file somewhere the user was
 * not shown — the preview can be wrong, the move cannot.
 */
export function monthFolder(modifiedEpoch: number): string {
  const at = new Date(modifiedEpoch * 1_000);
  return Number.isNaN(at.getTime()) ? "unknown" : format(at, "yyyy-MM");
}

/**
 * How many distinct month folders a selection would create — the number the
 * confirmation dialog needs to say "into 6 folders" rather than "into
 * folders".
 */
export function monthFolderCount(screenshots: Screenshot[]): number {
  return new Set(screenshots.map((screenshot) => monthFolder(screenshot.modifiedEpoch))).size;
}

/** How the confirmation dialog describes where the files are going. */
export function groupingSummary(grouping: Grouping, screenshots: Screenshot[]): string {
  if (grouping === "single") return "All of them straight into that folder.";

  const folders = monthFolderCount(screenshots);
  return `Into ${folders} dated ${folders === 1 ? "subfolder" : "subfolders"} (${
    monthFolder(screenshots[0]?.modifiedEpoch ?? 0)
  }, …), created if they are not there.`;
}
