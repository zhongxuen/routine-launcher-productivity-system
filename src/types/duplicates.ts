/**
 * Duplicate Finder types — development-plan.md sections 38, 40 and 67, as the
 * UI needs them.
 *
 * camelCase throughout, and the reason is the same one `progress.ts` gives:
 * there is no row to mirror. A duplicate group is not stored anywhere — it is
 * computed from the filesystem every time a scan runs — so there is no
 * snake_case schema for these names to agree with, and `services/duplicates.rs`
 * serialises them `camelCase` to match.
 *
 * The one distinction worth carrying into the type system is
 * {@link DuplicateGroupKind}. Section 40 asks for three comparisons — filename,
 * size, hash — and only two of them can prove anything. The kind is what keeps
 * "these files are the same" and "these files are named the same" from being
 * rendered as if they were the same claim, which matters because the second
 * one is the case where deleting the wrong copy loses work.
 */

/**
 * Which comparison put a group together.
 *
 * - `identical` — same size *and* same SHA-256. The bytes match; keeping one
 *   copy loses nothing, and this is the only kind that promises reclaimable
 *   space.
 * - `similar-name` — same name once copy markers (` (1)`, ` - Copy`) are
 *   stripped, but the contents differ. Worth showing, never safe to act on
 *   without looking, and worth nothing in reclaimed bytes.
 */
export type DuplicateGroupKind = "identical" | "similar-name";

/** One file inside a group. */
export interface DuplicateFile {
  /** Absolute path — the identity the action commands take back. */
  path: string;
  /** File name with extension, e.g. `photo (1).png`. */
  name: string;
  /** The containing folder, so a row can say where a copy lives. */
  folder: string;
  sizeBytes: number;
  /**
   * Last modified, in Unix epoch **milliseconds**, or null where the
   * filesystem would not say. Milliseconds because `new Date(ms)` renders it
   * in the user's own timezone, as every other date in the app is.
   */
  modifiedMs: number | null;
  /** Hex SHA-256. Present on `identical` groups only — it is their evidence. */
  hash: string | null;
  /**
   * The copy Rust would keep: the oldest, and so normally the original the
   * others were copied from.
   *
   * A hint, not a decision. Nothing is selected because of it; it is what the
   * per-group "Select the copies" button leaves behind, and the user can pick
   * a different one.
   */
  suggestedKeep: boolean;
}

/** A set of files section 40 would print under one heading. */
export interface DuplicateGroup {
  /** Stable across re-scans, so a selection can survive one. */
  id: string;
  kind: DuplicateGroupKind;
  /** The shortest name in the group — the one without ` (1)` on the end. */
  name: string;
  /** Shared size for `identical`; the largest member for `similar-name`. */
  sizeBytes: number;
  /** What keeping one copy would free. Always 0 for `similar-name`. */
  reclaimableBytes: number;
  /** At least two, oldest first. */
  files: DuplicateFile[];
}

/** A folder or file the scan could not read, and why. */
export interface SkippedPath {
  path: string;
  reason: string;
}

/** Everything one scan found. */
export interface DuplicateScan {
  /** The folders actually walked, after overlaps and missing ones were dropped. */
  roots: string[];
  includeSubfolders: boolean;
  minSizeBytes: number;
  scannedFiles: number;
  /** How many files had to be opened and hashed — why it took what it took. */
  hashedFiles: number;
  /** Redundant copies: every grouped file beyond the first in its group. */
  duplicateFiles: number;
  reclaimableBytes: number;
  /** Identical groups first, then same-name; each block largest saving first. */
  groups: DuplicateGroup[];
  skipped: SkippedPath[];
  /**
   * A limit stopped the walk. When this is true, "no duplicates" means "none
   * in what was looked at", and the UI has to say so.
   */
  truncated: boolean;
  elapsedMs: number;
}

/** What a scan is asked for. Every field optional; Rust fills the defaults. */
export interface DuplicateScanRequest {
  /** Absolute folder paths. Omitted or empty means Downloads + Desktop. */
  folders?: string[];
  includeSubfolders?: boolean;
  minSizeBytes?: number;
}

/** What happened to one path in a delete or a move. */
export interface FileActionResult {
  path: string;
  ok: boolean;
  /** Where it ended up, for a move that worked. */
  newPath: string | null;
  /** User-presentable reason, for anything that did not. */
  error: string | null;
}

/** Which of the two destructive actions the user is being asked to confirm. */
export type DuplicateAction = "move" | "delete";

/**
 * The outcome of one confirmed action, kept so the view can report it instead
 * of silently refreshing.
 *
 * A cleanup tool that just re-renders with fewer rows has not told the user
 * what it did, and the one thing they need to know is whether the file that
 * would not delete was the one they cared about.
 */
export interface DuplicateActionReport {
  action: DuplicateAction;
  /** Where the files went, for a move. */
  destination: string | null;
  succeeded: number;
  failed: number;
  /** Bytes freed (delete) or relocated (move), counted from what succeeded. */
  bytes: number;
  outcomes: FileActionResult[];
}
