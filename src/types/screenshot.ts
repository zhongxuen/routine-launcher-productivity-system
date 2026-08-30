/**
 * Screenshot Organizer types (development-plan.md sections 38, 42, 67).
 *
 * Every interface here mirrors a struct in
 * `src-tauri/src/services/screenshots.rs` field for field. Those structs
 * serialise as camelCase — the convention `progress.ts` and `quest.ts` keep,
 * rather than the row-mirroring snake_case of `task.ts` — because none of
 * this is a database row. A screenshot is a file on disk that the scan
 * described a moment ago; nothing about it is stored.
 *
 * The string unions are the wire values, so a bucket is called the same thing
 * in Rust, across `invoke`, and in the panel that prints it.
 */

/**
 * Which of section 42's lines a screenshot falls on — the narrowest one that
 * contains it. The cumulative figures the panel prints are the counts on
 * {@link ScreenshotScan}, not a tally of these.
 */
export const SCREENSHOT_BUCKETS = ["today", "thisWeek", "thisMonth", "older"] as const;

export type ScreenshotBucket = (typeof SCREENSHOT_BUCKETS)[number];

/**
 * Why a file is in the results.
 *
 * Shown on every row, because the two rules have very different confidence:
 * a file called `Screenshot 2026-08-29.png` is a screenshot wherever it is,
 * while a file that matched by `location` is one because of the folder it
 * sits in. The user reviewing the list is entitled to know which claim is
 * being made.
 */
export type MatchReason = "name" | "location";

/** How a folder was read. See `RootKind` in Rust for what each one means. */
export type RootKind = "screenshotFolder" | "general";

/** How the chosen files are laid out inside the chosen folder. */
export type Grouping = "single" | "byMonth";

/** One matched file. */
export interface Screenshot {
  /**
   * Absolute path, and the handle {@link organizeScreenshots} sends back.
   *
   * Rust re-tests it against the same folders the scan used before touching
   * anything, so this is a reference the UI passes around rather than a
   * permission it holds.
   */
  path: string;
  name: string;
  /** The folder it sits in, for the second line of a row. */
  folder: string;
  /** The label of the scanned folder it was found under. */
  source: string;
  bytes: number;
  /** Last modified, in seconds since the Unix epoch — its capture time. */
  modifiedEpoch: number;
  bucket: ScreenshotBucket;
  matchedBy: MatchReason;
}

/**
 * One folder the scan looked in, reported whether or not it found anything.
 *
 * A tool that says "0 screenshots" without saying where it looked is
 * impossible to trust, so the panel lists these — including the folders that
 * are simply not there on this machine.
 */
export interface ScreenshotSource {
  label: string;
  path: string;
  kind: RootKind;
  exists: boolean;
  matched: number;
  /** Why the folder could not be read. Null when it was read, or is absent. */
  error: string | null;
}

/** Where the three buckets begin, in seconds since the Unix epoch. */
export interface DateWindows {
  todayStart: number;
  weekStart: number;
  monthStart: number;
}

/** Section 42's panel, and the list behind its Review button. */
export interface ScreenshotScan {
  /** "147 screenshots found". */
  total: number;
  today: number;
  /** The last 7 days, today included — never smaller than `today`. */
  thisWeek: number;
  /** The last 30 days, `thisWeek` included. */
  thisMonth: number;
  /** `total - thisMonth`. */
  older: number;
  totalBytes: number;
  sources: ScreenshotSource[];
  /** The newest matches, newest first. Capped — see {@link truncated}. */
  screenshots: Screenshot[];
  /**
   * True when `screenshots` is shorter than `total`. The review list says so
   * rather than quietly showing a subset of what the counts describe.
   */
  truncated: boolean;
  /** When the scan ran, in seconds since the Unix epoch. */
  scannedAt: number;
  windows: DateWindows;
}

/** What happened to one file in a confirmed organise. */
export type MoveStatus = "moved" | "skipped" | "failed";

export interface MoveOutcome {
  path: string;
  name: string;
  status: MoveStatus;
  /**
   * Where it ended up, for a file that moved. Worth showing: a name already
   * taken in the destination means it may not be the name it went in with.
   */
  newPath: string | null;
  /** Why it was skipped, or why it failed. Null when it moved. */
  message: string | null;
}

/**
 * The result of one confirmed organise.
 *
 * Every requested file gets an entry whether or not it worked — a locked file
 * half way down a selection should be named, not swallowed.
 */
export interface OrganizeResult {
  destination: string;
  moved: number;
  skipped: number;
  failed: number;
  outcomes: MoveOutcome[];
  /** A sentence for the panel: "12 screenshots moved". */
  summary: string;
}
