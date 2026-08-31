/**
 * Desktop Cleanup store (development-plan.md sections 38, 66, 67, 81).
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
 * - `runScan` reads both desktops. It is the only thing that happens without
 *   being asked for, and it changes nothing on disk.
 * - `openReview` moves from the summary to the item list. Selection starts
 *   empty every time — a review never opens with items already ticked,
 *   because a pre-ticked box is the app deciding, not the user.
 * - `toggleItem` / `selectAllShown` / `clearSelection` are the only ways a
 *   path ever enters the set an action reads, and each of them refuses
 *   anything the scan marked unactionable.
 * - `requestAction` opens the confirmation. It performs nothing; it only
 *   records which of the two the user is being asked about.
 * - `confirmMove` / `confirmDelete` are the only functions here that change
 *   anything, they are reachable only from that confirmation, and they send
 *   exactly the paths the user ticked.
 *
 * There is deliberately no action that scans and then acts, and no caller
 * outside the review flow — a quest, a routine, a schedule — that can reach
 * the last two. Rust refuses an empty selection as well, so the rule holds
 * even if a component gets it wrong.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONLY THIS STORE HAS TO WORRY ABOUT
 *
 * A desktop holds things that cannot be acted on: every folder, and everything
 * on the public desktop. They are in the scan because leaving them out would
 * mean a panel that disagrees with what is on screen, and they are kept out of
 * `selected` at every entry point, so the count in the confirmation is always
 * a count of things that can really be moved or deleted.
 */

import { create } from "zustand";

import {
  chooseDestinationFolder,
  deleteDesktopItems,
  moveDesktopItems,
  scanDesktop,
} from "@/services/desktopService";
import { NO_FILTER, type DesktopFilter } from "@/lib/desktop-utils";
import type {
  ActionReport,
  AgeBucketId,
  DesktopAction,
  DesktopItem,
  DesktopKindId,
  DesktopScan,
} from "@/types/desktop";

/** Which of the two views the user is on. */
export type DesktopStage = "summary" | "review";

interface DesktopState {
  /* --- Scan ------------------------------------------------------------- */

  /** The last scan, or null before the first one has come back. */
  scan: DesktopScan | null;
  isScanning: boolean;
  /** Why the scan could not be read. Shown instead of the summary. */
  error: string | null;

  /* --- Where the user is ------------------------------------------------ */

  stage: DesktopStage;
  /** The kind and age filters in the review list. Nulls show everything. */
  filter: DesktopFilter;

  /* --- Selection -------------------------------------------------------- */

  /**
   * The paths the user has ticked. A `Set` rather than an array because every
   * row asks whether it is in here on every render.
   */
  selected: Set<string>;

  /* --- Confirm and act -------------------------------------------------- */

  /** The action the confirmation is currently asking about, or null. */
  pendingAction: DesktopAction | null;
  isActing: boolean;
  /** The result of the last confirmed action, kept until dismissed. */
  report: ActionReport | null;
  /** A whole-action refusal (no destination, empty selection, desktop gone). */
  actionError: string | null;

  /* --- The chain, one function per step --------------------------------- */

  runScan: () => Promise<void>;
  openReview: () => void;
  closeReview: () => void;
  setKind: (kind: DesktopKindId | null) => void;
  setAge: (age: AgeBucketId | null) => void;
  clearFilter: () => void;

  toggleItem: (item: DesktopItem) => void;
  selectAllShown: (items: DesktopItem[]) => void;
  clearSelection: () => void;

  requestAction: (action: DesktopAction) => void;
  cancelAction: () => void;
  confirmMove: () => Promise<void>;
  confirmDelete: () => Promise<void>;
  dismissReport: () => void;
}

export const useDesktopStore = create<DesktopState>((set, get) => ({
  scan: null,
  isScanning: false,
  error: null,

  stage: "summary",
  filter: NO_FILTER,

  selected: new Set<string>(),

  pendingAction: null,
  isActing: false,
  report: null,
  actionError: null,

  /**
   * Step one. Reads both desktops and shows what is on them — nothing else.
   *
   * The selection is pruned against the result rather than cleared: something
   * the user ticked that is still there stays ticked across a Rescan, and one
   * that has since been moved or deleted elsewhere quietly stops being part of
   * the next action. Keeping a path that no longer exists would only mean a
   * confirmation counting items that cannot be touched.
   */
  runScan: async () => {
    set({ isScanning: true, error: null });

    try {
      const scan = await scanDesktop();
      // Only the actionable paths survive the prune, so an item that became a
      // folder's neighbour on the public desktop between scans cannot stay in
      // a selection it should never have been in.
      const present = new Set(
        scan.items.filter((item) => item.actionable).map((item) => item.path),
      );
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
   * Step two -> three: the summary's "Review Desktop" button.
   *
   * Opens with nothing selected and no filter, every time. A review that
   * remembered the last selection would be a list where the tick marks came
   * from something the user has since forgotten doing.
   */
  openReview: () =>
    set({
      stage: "review",
      filter: NO_FILTER,
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

  setKind: (kind) => set((state) => ({ filter: { ...state.filter, kind } })),
  setAge: (age) => set((state) => ({ filter: { ...state.filter, age } })),
  clearFilter: () => set({ filter: NO_FILTER }),

  /* --- Step three: the user selects ------------------------------------- */

  /**
   * Ticks or unticks one item.
   *
   * Takes the item rather than its path so it can check `actionable` here as
   * well as in the row: a folder and a public-desktop shortcut are drawn
   * without a checkbox, and this is what makes that a rule instead of a
   * rendering detail.
   */
  toggleItem: (item) =>
    set((state) => {
      if (!item.actionable) return state;
      const selected = new Set(state.selected);
      if (!selected.delete(item.path)) selected.add(item.path);
      return { selected, actionError: null };
    }),

  /**
   * Ticks everything the current filter is showing that can be acted on —
   * never everything on the desktop, and never a folder.
   *
   * "Select all" on a filtered list that quietly also picked up the items you
   * filtered out is exactly the kind of surprise section 67 is about.
   */
  selectAllShown: (items) =>
    set((state) => {
      const selected = new Set(state.selected);
      items.filter((item) => item.actionable).forEach((item) => selected.add(item.path));
      return { selected, actionError: null };
    }),

  clearSelection: () => set({ selected: new Set<string>(), actionError: null }),

  /* --- Step four: confirm ----------------------------------------------- */

  /**
   * Opens the confirmation for `action`. Performs nothing.
   *
   * Refuses to open on an empty selection, so the dialog is never asked to
   * describe an action with nothing in it.
   */
  requestAction: (action) => {
    if (get().selected.size === 0) {
      set({ actionError: "Select at least one item first." });
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
      set({ pendingAction: null, actionError: "Select at least one item first." });
      return;
    }

    set({ isActing: true, actionError: null });

    try {
      const destination = await chooseDestinationFolder();
      if (destination === null) {
        set({ isActing: false, pendingAction: null });
        return;
      }

      const report = await moveDesktopItems(paths, destination);
      set({ report, pendingAction: null, isActing: false });
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
   * so, with the list the user ticked; Rust checks every path is still a plain
   * file on the user's own desktop before removing it.
   */
  confirmDelete: async () => {
    const paths = [...get().selected];
    if (paths.length === 0) {
      set({ pendingAction: null, actionError: "Select at least one item first." });
      return;
    }

    set({ isActing: true, actionError: null });

    try {
      const report = await deleteDesktopItems(paths);
      set({ report, pendingAction: null, isActing: false });
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
