/**
 * Screenshot Organizer store (development-plan.md sections 38, 42, 67).
 *
 * ---------------------------------------------------------------------------
 * THIS STORE *IS* SECTION 67'S ORDER
 *
 * ```text
 * Scan -> Show results -> User selects files -> Confirm -> Perform action
 * ```
 *
 * Each arrow is a separate action here, and none of them calls the next one:
 *
 * - `runScan` reads the folders. It is the only thing that happens without
 *   being asked for, and it changes nothing on disk.
 * - `openReview` moves from section 42's panel to the file list. Selection
 *   starts empty every time — a review never opens with files already ticked,
 *   because a pre-ticked box is the app deciding, not the user.
 * - `toggle` / `selectAllShown` / `clearSelection` are the only ways a path
 *   ever enters the set the move reads.
 * - `chooseDestination` opens the OS folder picker. It moves nothing; it only
 *   records where a move *would* go, and the Organize button stays disabled
 *   until it has.
 * - `requestOrganize` opens the confirmation. It performs nothing.
 * - `confirmOrganize` is the only function in this feature that changes a
 *   file, it is reachable only from that confirmation, and it sends exactly
 *   the paths the user ticked.
 *
 * There is deliberately no action that scans and then files, and no caller
 * outside this flow — a quest, a routine, a schedule — that can reach the
 * last one. Rust refuses an empty selection and re-tests every path as well,
 * so the rule holds even if a component gets it wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY A STORE AND NOT COMPONENT STATE
 *
 * The summary and the review are two views of one scan, and re-walking
 * several folders every time the user goes back and forth would be both slow
 * and confusing — the list would reshuffle underneath a half-made selection.
 * Keeping the scan here means the walk happens when the user asks for it: on
 * arrival, after an organise, or on Rescan.
 */

import { create } from "zustand";

import {
  chooseDestinationFolder,
  organizeScreenshots,
  scanScreenshots,
} from "@/services/screenshotService";
import { screenshotsInBucket } from "@/lib/screenshot-utils";
import type {
  Grouping,
  OrganizeResult,
  Screenshot,
  ScreenshotBucket,
  ScreenshotScan,
} from "@/types/screenshot";

/** Which of the two views the user is on. */
export type ScreenshotStage = "summary" | "review";

interface ScreenshotState {
  /* --- Scan ------------------------------------------------------------- */

  /** The last scan, or null before the first one has come back. */
  scan: ScreenshotScan | null;
  isScanning: boolean;
  /** Why the folders could not be read. Shown instead of the panel. */
  error: string | null;

  /* --- Where the user is ------------------------------------------------ */

  stage: ScreenshotStage;
  /** The bucket filter in the review list. Null shows everything. */
  bucket: ScreenshotBucket | null;

  /* --- Selection and destination ---------------------------------------- */

  /**
   * The paths the user has ticked. A `Set` rather than an array because every
   * row asks whether it is in here on every render.
   */
  selected: Set<string>;
  /** The folder the user picked, or null while they have not picked one. */
  destination: string | null;
  grouping: Grouping;

  /* --- Confirm and act -------------------------------------------------- */

  /** True while the confirmation dialog is open. */
  isConfirming: boolean;
  isOrganizing: boolean;
  /**
   * Why the organise, or the folder picker, could not run at all.
   *
   * Kept apart from `error` because the rescan that follows every organise
   * clears that one, and a rescan is exactly what happens next when an
   * organise fails — so a shared field would wipe the reason a moment after
   * showing it. Per-file failures are not here; those are in `report`.
   */
  actionError: string | null;
  /** The last organise, kept on screen until dismissed. */
  report: OrganizeResult | null;

  runScan: () => Promise<void>;
  openReview: (bucket?: ScreenshotBucket | null) => void;
  backToSummary: () => void;
  setBucket: (bucket: ScreenshotBucket | null) => void;
  toggle: (path: string) => void;
  selectAllShown: () => void;
  clearSelection: () => void;
  setGrouping: (grouping: Grouping) => void;
  chooseDestination: () => Promise<void>;
  requestOrganize: () => void;
  cancelOrganize: () => void;
  confirmOrganize: () => Promise<void>;
  dismissReport: () => void;
}

export const useScreenshotStore = create<ScreenshotState>((set, get) => ({
  scan: null,
  isScanning: false,
  error: null,
  stage: "summary",
  bucket: null,
  selected: new Set<string>(),
  destination: null,
  grouping: "single",
  isConfirming: false,
  isOrganizing: false,
  actionError: null,
  report: null,

  /**
   * Reads the folders again.
   *
   * The selection is dropped, always. The paths in it describe files that
   * were there a moment ago, and after a move — or after the user tidied up
   * in Explorer — some of them are not; keeping ticks whose files may have
   * gone would be keeping the one thing in this flow that has to be exactly
   * right. The destination and the grouping survive, because those are a
   * decision about where things go rather than a claim about what exists.
   */
  runScan: async () => {
    set({ isScanning: true, error: null });
    try {
      const scan = await scanScreenshots();
      set({ scan, isScanning: false, selected: new Set<string>() });
    } catch (error) {
      set({ error: String(error), isScanning: false });
    }
  },

  /**
   * Section 42's `[ Review ]`. Optionally lands on one bucket, so clicking
   * "Today: 12" opens the list already narrowed to those twelve.
   */
  openReview: (bucket = null) =>
    set({
      stage: "review",
      bucket,
      selected: new Set<string>(),
      actionError: null,
      report: null,
    }),

  backToSummary: () => set({ stage: "summary", selected: new Set<string>() }),

  /**
   * Narrows the list. The selection is left alone: a file ticked under
   * "Today" is still ticked when the filter widens, which is what lets
   * somebody build a selection across buckets.
   */
  setBucket: (bucket) => set({ bucket }),

  toggle: (path) =>
    set((state) => {
      const selected = new Set(state.selected);
      if (!selected.delete(path)) selected.add(path);
      return { selected };
    }),

  /** Ticks everything the current filter is showing — not everything found. */
  selectAllShown: () =>
    set((state) => {
      const shown = screenshotsInBucket(state.scan?.screenshots ?? [], state.bucket);
      const selected = new Set(state.selected);
      shown.forEach((screenshot) => selected.add(screenshot.path));
      return { selected };
    }),

  clearSelection: () => set({ selected: new Set<string>() }),

  setGrouping: (grouping) => set({ grouping }),

  /**
   * Opens the OS folder picker. A cancelled picker leaves the previous
   * destination in place rather than clearing it — cancelling is "not that
   * one", not "nowhere".
   */
  chooseDestination: async () => {
    try {
      const chosen = await chooseDestinationFolder();
      if (chosen) set({ destination: chosen, actionError: null });
    } catch (error) {
      set({ actionError: String(error) });
    }
  },

  /**
   * Asks for confirmation. Refuses to even ask without both halves of the
   * decision — which files, and which folder — so the dialog never has to
   * describe an action it cannot state precisely.
   */
  requestOrganize: () => {
    const { selected, destination } = get();
    if (selected.size === 0 || !destination) return;
    set({ isConfirming: true });
  },

  cancelOrganize: () => set({ isConfirming: false }),

  /**
   * The only thing here that touches a file, and it is reachable only from
   * the confirmation dialog.
   *
   * It re-reads the folders afterwards, always — including after a failure,
   * because a partial organise is the case where what is on screen is least
   * likely to match what is on disk.
   */
  confirmOrganize: async () => {
    const { selected, destination, grouping, scan } = get();
    if (selected.size === 0 || !destination) return;

    // Sent in the order the list showed them, so the report reads down the
    // same way the review did.
    const paths = (scan?.screenshots ?? [])
      .map((screenshot) => screenshot.path)
      .filter((path) => selected.has(path));

    set({ isOrganizing: true, isConfirming: false, actionError: null });
    try {
      const report = await organizeScreenshots(paths, destination, grouping);
      set({ report, isOrganizing: false, stage: "summary" });
    } catch (error) {
      set({ actionError: String(error), isOrganizing: false });
    }
    await get().runScan();
  },

  dismissReport: () => set({ report: null }),
}));

/** The screenshots the review list is currently showing. */
export function shownScreenshots(state: {
  scan: ScreenshotScan | null;
  bucket: ScreenshotBucket | null;
}): Screenshot[] {
  return screenshotsInBucket(state.scan?.screenshots ?? [], state.bucket);
}
