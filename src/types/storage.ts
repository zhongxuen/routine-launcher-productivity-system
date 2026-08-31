/**
 * Storage Overview payloads — development-plan.md sections 38, 66, 67.
 *
 * The wire shapes of `src-tauri/src/services/storage.rs`, and nothing else.
 * Notably there is no action type in this file and no result type for one:
 * this is the one Cleanup utility that only reports, so every type here
 * describes something read rather than something done.
 *
 * Sizes are `number`, which is what `invoke` hands back for Rust's `u64`. A
 * drive would have to hold nine petabytes before that lost precision, so the
 * conversion is safe for every figure this page shows.
 */

/** Why a folder's walk stopped before it had seen everything. */
export type ScanStop = "entry_limit" | "time_limit" | "cancelled";

/** One fixed drive. Mirrors `services::storage::Drive`. */
export interface Drive {
  /** The drive root as a path — `C:\`. */
  root: string;
  /** The letter alone. */
  letter: string;
  /** The volume label, or `""` when the volume has none. */
  label: string;
  /** `NTFS`, `exFAT`, … or `""` when it could not be read. */
  fileSystem: string;
  totalBytes: number;
  /** Free space as the user may use it — the figure Explorer prints. */
  freeBytes: number;
  usedBytes: number;
  /** True for the drive the user's profile is on. */
  holdsProfile: boolean;
}

/** One top-level folder of the profile, before it has been sized. */
export interface ProfileFolder {
  path: string;
  name: string;
  /** True for a folder Windows hides — `AppData`, most of the time. */
  hidden: boolean;
}

/** What one folder came to. Mirrors `services::storage::FolderSize`. */
export interface FolderSize {
  path: string;
  name: string;
  sizeBytes: number;
  fileCount: number;
  folderCount: number;
  /** How many folders could not be opened. Normal, and never an error. */
  skippedFolders: number;
  /** Set when the walk gave up early, so `sizeBytes` is a floor. */
  stopped: ScanStop | null;
  durationMs: number;
}

/** Everything the page can draw before any sizing has happened. */
export interface StorageOverview {
  drives: Drive[];
  /** The profile directory — `C:\Users\Ada`. */
  profile: string;
  /** Its top-level folders, alphabetically: the order they are sized in. */
  folders: ProfileFolder[];
  /** The token every sizing call for this overview carries. */
  token: number;
}

/**
 * A folder as the list draws it: what the overview said, plus the size once
 * it has arrived.
 *
 * Frontend-only — the two halves come from two different calls, and this is
 * where they are joined. `size` being `null` is the whole of "not measured
 * yet", which is what lets a row be drawn before there is anything to put in
 * it.
 */
export interface SizedFolder extends ProfileFolder {
  size: FolderSize | null;
}
