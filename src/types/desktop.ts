/**
 * Desktop Cleanup types (development-plan.md sections 38, 66, 67, 81).
 *
 * Every interface here mirrors a struct in
 * `src-tauri/src/services/desktop.rs` field for field, snake_case included, so
 * a value crossing `invoke` needs no reshaping in either direction — the same
 * contract `src/types/downloads.ts` keeps.
 *
 * The kind and age ids are the wire values: `DesktopKind` and `AgeBucket` in
 * Rust serialise to exactly these strings, so a bucket is called the same
 * thing in the scan, across `invoke`, and in the summary panel.
 */

/**
 * What one thing on the desktop is.
 *
 * The five buckets Downloads has, plus the two a desktop has and a downloads
 * folder does not: a shortcut is a `.lnk` or `.url` reported at its own size,
 * and a folder is counted rather than opened.
 */
export const DESKTOP_KIND_IDS = [
  "shortcut",
  "folder",
  "image",
  "document",
  "archive",
  "installer",
  "other",
] as const;

export type DesktopKindId = (typeof DESKTOP_KIND_IDS)[number];

/**
 * The four rolling windows an item's last-modified time falls in — the same
 * ones the screenshot organizer uses, measured against the same clock.
 *
 * Each item lands in the *narrowest* window that contains it, so the four
 * counts add up to the item count rather than nesting the way section 42's
 * mockup does.
 */
export const AGE_BUCKET_IDS = ["today", "this_week", "this_month", "older"] as const;

export type AgeBucketId = (typeof AGE_BUCKET_IDS)[number];

/**
 * Which of the two desktops something is on.
 *
 * `public` is the All Users desktop Windows composites into the same screen.
 * It is read and labelled and never written to: that needs elevation this app
 * does not ask for.
 */
export type DesktopRootKind = "user" | "public";

/** One thing at the top level of a desktop folder. */
export interface DesktopItem {
  /**
   * Absolute path, and the handle an action sends back.
   *
   * Rust re-checks it before touching anything — see `resolve_item` — so this
   * is a reference the UI passes around rather than a permission it holds.
   */
  path: string;
  name: string;
  /** Lowercased, without the dot. Null for a folder or a file that has none. */
  extension: string | null;
  kind: DesktopKindId;
  /**
   * The item's own size. For a shortcut that is the size of the `.lnk` itself,
   * never of what it points at; for a folder it is 0, because measuring a
   * folder would mean walking it and this scan does not walk folders.
   */
  size_bytes: number;
  /**
   * How many things are directly inside, for a folder. Null for everything
   * that is not one, and for a folder that could not be read.
   */
  item_count: number | null;
  /** Seconds since the Unix epoch, or null on a filesystem that would not say. */
  modified_at: number | null;
  age: AgeBucketId;
  /** The label of the desktop it was found on: "Desktop", "Public Desktop". */
  source: string;
  /**
   * Whether Move and Delete may be offered for it at all.
   *
   * False for every folder and for everything on the public desktop. The row
   * draws without a checkbox when this is false; Rust refuses those paths
   * again regardless, because a disabled checkbox is a decision made in a
   * component and the one that counts is made in the service.
   */
  actionable: boolean;
}

export interface KindCount {
  kind: DesktopKindId;
  /** The summary's label, sent by Rust so it is written once. */
  label: string;
  count: number;
  /** Always 0 for folders, which are never measured. */
  size_bytes: number;
}

export interface AgeCount {
  age: AgeBucketId;
  label: string;
  count: number;
  size_bytes: number;
}

/** One desktop folder's contribution, reported whether or not it had anything. */
export interface DesktopSource {
  label: string;
  path: string;
  kind: DesktopRootKind;
  /** False when the folder is simply not there — normal off Windows. */
  exists: boolean;
  /** Whether anything found here can be moved or deleted. */
  actionable: boolean;
  item_count: number;
  /** Why the folder could not be read. Null when it read fine or is absent. */
  error: string | null;
}

export interface DesktopScan {
  /** Every folder that was looked in, in the order they were read. */
  sources: DesktopSource[];
  item_count: number;
  /** Ordinary files: not shortcuts, not folders. */
  file_count: number;
  shortcut_count: number;
  folder_count: number;
  /** Bytes across everything that has a size. Folders contribute nothing. */
  total_bytes: number;
  /** All seven kinds in summary order, empty ones included. */
  kinds: KindCount[];
  /** All four age windows, newest first, empty ones included. */
  ages: AgeCount[];
  /** The largest item that has a size. Null for a desktop of only folders. */
  largest: DesktopItem | null;
  /** Everything found, largest first. */
  items: DesktopItem[];
  /**
   * Entries that could not be read, plus symlinks, junctions and other reparse
   * points. Reported, never listed, never fatal.
   */
  unreadable_count: number;
}

/** What happened to one item in a move or a delete. */
export interface ItemActionOutcome {
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
 * Every requested item gets an entry whether or not it worked: a locked file
 * half way down a selection should be named, not swallowed.
 */
export interface ActionReport {
  succeeded: number;
  failed: number;
  /** Bytes actually moved or freed — the successes only. */
  bytes: number;
  outcomes: ItemActionOutcome[];
}

/**
 * The two things the review flow can do to an item.
 *
 * Kept as a type rather than a boolean because the confirmation dialog says
 * something different for each, and the difference — one is recoverable, one
 * is not — is the whole reason section 67 exists.
 */
export type DesktopAction = "move" | "delete";
