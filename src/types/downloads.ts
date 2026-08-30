/**
 * Downloads Cleanup types (development-plan.md sections 38-39).
 *
 * Every interface here mirrors a struct in
 * `src-tauri/src/services/downloads.rs` field for field, snake_case included,
 * so a value crossing `invoke` needs no reshaping in either direction — the
 * same contract `src/types/task.ts` and `src/types/focus.ts` keep.
 *
 * The category ids are the wire values: `FileCategory` in Rust serialises to
 * exactly these five strings, so a bucket is called the same thing in the
 * scan, across `invoke`, and in the summary panel.
 */

/** The five buckets of section 39's mockup. */
export const FILE_CATEGORY_IDS = [
  "images",
  "documents",
  "zip",
  "installers",
  "other",
] as const;

export type FileCategoryId = (typeof FILE_CATEGORY_IDS)[number];

/** One file at the top level of the Downloads folder. */
export interface ScannedFile {
  /**
   * Absolute path, and the handle an action sends back.
   *
   * Rust re-checks it before touching anything — see `resolve_file` — so this
   * is a reference the UI passes around rather than a permission it holds.
   */
  path: string;
  name: string;
  /** Lowercased, without the dot. Null for a file that has none. */
  extension: string | null;
  size_bytes: number;
  category: FileCategoryId;
  /** Seconds since the Unix epoch, or null on a filesystem that would not say. */
  modified_at: number | null;
}

export interface CategoryCount {
  category: FileCategoryId;
  /** Section 39's label ("Images", "ZIP", …), sent by Rust so it is written once. */
  label: string;
  count: number;
  size_bytes: number;
}

export interface DownloadsScan {
  /** The folder that was read, so the UI names it rather than assuming it. */
  folder: string;
  file_count: number;
  total_bytes: number;
  /** All five buckets in mockup order, empty ones included. */
  categories: CategoryCount[];
  /** The mockup's "Largest" line. Null for an empty folder. */
  largest: ScannedFile | null;
  /** Every file found, largest first. */
  files: ScannedFile[];
  /** Sub-folders seen and stepped over — the scan never descends into them. */
  folder_count: number;
  /** Entries that could not be read. Reported, never fatal. */
  unreadable_count: number;
}

/** What happened to one file in a move or a delete. */
export interface FileActionOutcome {
  path: string;
  name: string;
  ok: boolean;
  /** A sentence worth showing. Null when `ok`. */
  error: string | null;
  /** Where it ended up, for a move that worked. */
  moved_to: string | null;
}

/**
 * The result of one confirmed action.
 *
 * Every requested file gets an entry whether or not it worked: a locked file
 * half way down a selection should be named, not swallowed.
 */
export interface ActionReport {
  succeeded: number;
  failed: number;
  /** Bytes actually moved or freed — the successes only. */
  bytes: number;
  outcomes: FileActionOutcome[];
}

/**
 * The two things the review flow can do to a file.
 *
 * Kept as a type rather than a boolean because the confirmation dialog says
 * something different for each, and the difference — one is recoverable, one
 * is not — is the whole reason section 67 exists.
 */
export type DownloadsAction = "move" | "delete";
