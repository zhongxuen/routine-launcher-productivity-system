/**
 * Downloads Cleanup store (development-plan.md sections 38-39, 67).
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
 * - `runScan` reads the folder. It is the only thing that happens without
 *   being asked for, and it changes nothing on disk.
 * - `openReview` moves from the summary to the file list. Selection starts
 *   empty every time — a review never opens with files already ticked,
 *   because a pre-ticked box is the app deciding, not the user.
 * - `toggleFile` / `selectAllShown` / `clearSelection` are the only ways a
 *   path ever enters the set an action reads.
 * - `requestAction` opens the confirmation. It performs nothing; it only
 *   records which of the two the user is being asked about.
 * - `confirmMove` / `confirmDelete` are the only functions in the app that
 *   change a file, they are reachable only from that confirmation, and they
 *   send exactly the paths the user ticked.
 *
 * There is deliberately no action that scans and then acts, and no caller
 * outside the review flow — a quest, a routine, a schedule — that can reach
 * the last two. Rust refuses an empty selection as well, so the rule holds
 * even if a component gets it wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY A STORE AND NOT COMPONENT STATE
 *
 * The summary and the review are two views of one scan, and re-reading a
 * folder of several hundred files every time the user goes back and forth
 * would be both slow and confusing — the list would reshuffle underneath a
 * half-made selection. Keeping the scan here means the round trip happens
 * when the user asks for it: on arrival, after an action, or on Rescan.
 */

import { create } from "zustand";

import { emitProgressChanged } from "@/lib/progress-events";
import {
  chooseDestinationFolder,
  deleteDownloadsFiles,
  moveDownloadsFiles,
  scanDownloads,
} from "@/services/downloadsService";
import type {
  ActionReport,
  DownloadsAction,
  DownloadsScan,
  FileCategoryId,
  ScannedFile,
} from "@/types/downloads";

/** Which of the two views the user is on. */
export type DownloadsStage = "summary" | "review";

interface DownloadsState {
  /* --- Scan ------------------------------------------------------------- */

  /** The last scan, or null before the first one has come back. */
  scan: DownloadsScan | null;
  isScanning: boolean;
  /** Why the scan could not be read. Shown instead of the summary. */
  error: string | null;

  /* --- Where the user is ------------------------------------------------ */

  stage: DownloadsStage;
  /** The category filter in the review list. Null shows everything. */
  category: FileCategoryId | null;

  /* --- Selection -------------------------------------------------------- */

  /**
   * The paths the user has ticked. A `Set` rather than an array because every
   * row asks whether it is in here on every render.
   */
  selected: Set<string>;

  /* --- Confirm and act -------------------------------------------------- */

  /** The action the confirmation is currently asking about, or null. */
  pendingAction: DownloadsAction | null;
  isActing: boolean;
  /** The result of the last confirmed action, kept until dismissed. */
  report: ActionReport | null;
  /** A whole-action refusal (no destination, empty selection, folder gone). */
  actionError: string | null;

  /* --- The chain, one function per step --------------------------------- */

  runScan: () => Promise<void>;
  openReview: () => void;
  closeReview: () => void;
  setCategory: (category: FileCategoryId | null) => void;

  toggleFile: (path: string) => void;
  selectAllShown: (files: ScannedFile[]) => void;
  clearSelection: () => void;

  requestAction: (action: DownloadsAction) => void;
  cancelAction: () => void;
  confirmMove: () => Promise<void>;
  confirmDelete: () => Promise<void>;
  dismissReport: () => void;
}

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  scan: null,
  isScanning: false,
  error: null,

  stage: "summary",
  category: null,

  selected: new Set<string>(),

  pendingAction: null,
  isActing: false,
  report: null,
  actionError: null,

  /**
   * Step one. Reads the folder and shows what is in it — nothing else.
   *
   * The selection is pruned against the result rather than cleared: a file
   * the user ticked that is still there stays ticked across a Rescan, and one
   * that has since been moved or deleted elsewhere quietly stops being part
   * of the next action. Keeping a path that no longer exists would only mean
   * a confirmation counting files that cannot be touched.
   */
  runScan: async () => {
    set({ isScanning: true, error: null });

    try {
      const scan = await scanDownloads();
      const present = new Set(scan.files.map((file) => file.path));
      const selected = new Set([...get().selected].filter((path) => present.has(path)));

      set({ scan, selected, isScanning: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        isScanning: false,
      });
    }
  },

  /**
   * Step two -> three: the summary's "Review Downloads" button.
   *
   * Opens with nothing selected and no filter, every time. A review that
   * remembered the last selection would be a list where the tick marks came
   * from something the user has since forgotten doing.
   */
  openReview: () =>
    set({
      stage: "review",
      category: null,
      selected: new Set<string>(),
      report: null,
      actionError: null,
    }),

  /** Back to the summary, dropping the half-made selection with it. */
  closeReview: () =>
    set({
      stage: "summary",
      selected: new Set<string>(),
      pendingAction: null,
      actionError: null,
    }),

  setCategory: (category) => set({ category }),

  /* --- Step three: the user selects ------------------------------------- */

  toggleFile: (path) =>
    set((state) => {
      const selected = new Set(state.selected);
      if (!selected.delete(path)) selected.add(path);
      return { selected, actionError: null };
    }),

  /**
   * Ticks everything the current filter is showing — never everything in the
   * folder. "Select all" on a filtered list that quietly also picked up the
   * files you filtered out is exactly the kind of surprise section 67 is
   * about.
   */
  selectAllShown: (files) =>
    set((state) => {
      const selected = new Set(state.selected);
      files.forEach((file) => selected.add(file.path));
      return { selected, actionError: null };
    }),

  clearSelection: () => set({ selected: new Set<string>(), actionError: null }),

  /* --- Step four: confirm ----------------------------------------------- */

  /**
   * Opens the confirmation for `action`. Performs nothing.
   *
   * Refuses to open on an empty selection, so the dialog is never asked to
   * describe an action with no files in it.
   */
  requestAction: (action) => {
    if (get().selected.size === 0) {
      set({ actionError: "Select at least one file first." });
      return;
    }
    set({ pendingAction: action, actionError: null });
  },

  cancelAction: () => set({ pendingAction: null }),

  /* --- Step five: perform ------------------------------------------------ */

  /**
   * The recoverable action. Asks for the destination folder at the moment of
   * confirming rather than earlier, so cancelling the picker cancels the move
   * and leaves the selection exactly where it was.
   */
  confirmMove: async () => {
    const paths = [...get().selected];
    if (paths.length === 0) {
      set({ pendingAction: null, actionError: "Select at least one file first." });
      return;
    }

    set({ isActing: true, actionError: null });

    try {
      const destination = await chooseDestinationFolder();
      if (destination === null) {
        set({ isActing: false, pendingAction: null });
        return;
      }

      const report = await moveDownloadsFiles(paths, destination);
      set({ report, pendingAction: null, isActing: false });
      // The move was recorded as a cleanup action, which can unlock
      // Organized. See `src/lib/progress-events.ts`.
      emitProgressChanged();
      await get().runScan();
    } catch (error) {
      set({
        actionError: error instanceof Error ? error.message : String(error),
        pendingAction: null,
        isActing: false,
      });
    }
  },

  /**
   * The one that cannot be undone. Reached only from a confirmation that says
   * so, with the list the user ticked; Rust checks every path is still a
   * plain file inside Downloads before removing it.
   */
  confirmDelete: async () => {
    const paths = [...get().selected];
    if (paths.length === 0) {
      set({ pendingAction: null, actionError: "Select at least one file first." });
      return;
    }

    set({ isActing: true, actionError: null });

    try {
      const report = await deleteDownloadsFiles(paths);
      set({ report, pendingAction: null, isActing: false });
      emitProgressChanged();
      await get().runScan();
    } catch (error) {
      set({
        actionError: error instanceof Error ? error.message : String(error),
        pendingAction: null,
        isActing: false,
      });
    }
  },

  dismissReport: () => set({ report: null }),
}));
