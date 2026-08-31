/**
 * Duplicate Finder store (development-plan.md sections 38, 40, 67).
 *
 * ---------------------------------------------------------------------------
 * THIS STORE *IS* SECTION 67'S ORDER
 *
 * ```text
 * Scan -> Show results -> User selects files -> Confirm -> Perform action
 * ```
 *
 * Every arrow is a separate action, and none of them calls the next:
 *
 * - `runScan` reads the chosen folders and changes nothing on disk. It is the
 *   only thing here that happens without the user naming files.
 * - `toggleFile`, `selectCopiesIn`, `selectAllIn`, `clearGroup` and
 *   `clearSelection` are the only ways a path ever enters {@link
 *   DuplicateState.selected}. Nothing is ticked by a scan: `suggestedKeep`
 *   marks a row, it does not select the others.
 * - `requestAction` opens the confirmation and performs nothing.
 * - `confirmDelete` / `confirmMove` are the only functions in this feature
 *   that change a file, they are reachable only from that confirmation, and
 *   they send exactly the paths in `selected` — not a group, not a scan.
 *
 * There is deliberately no "clean up duplicates" action, and no caller outside
 * this flow — a quest, a routine, a schedule — that can reach the last two.
 * Rust refuses an empty path list as well, so the rule survives a component
 * bug.
 *
 * ---------------------------------------------------------------------------
 * WHY A STORE AND NOT COMPONENT STATE
 *
 * A scan is expensive — it hashes files — and the selection it feeds is built
 * up slowly across a long list. Re-running the scan because a dialog mounted,
 * or losing half a made selection because a group collapsed, would make the
 * flow unusable. Keeping both here means the disk is read when the user asks:
 * on first arrival, on Rescan, and after an action has changed what is there.
 */

import { create } from "zustand";

import { buildActionReport, copiesIn, selectedFiles } from "@/lib/duplicate-utils";
import {
  chooseDestinationFolder,
  chooseScanFolders,
  defaultDuplicateFolders,
  deleteDuplicateFiles,
  moveDuplicateFiles,
  scanDuplicates,
} from "@/services/duplicateService";
import type {
  DuplicateAction,
  DuplicateActionReport,
  DuplicateScan,
} from "@/types/duplicates";

interface DuplicateState {
  /* --- Scan ------------------------------------------------------------- */

  /** The last scan, or null before the first one has come back. */
  scan: DuplicateScan | null;
  isScanning: boolean;
  /** Why the last request failed. Shown instead of, or above, the results. */
  error: string | null;

  /* --- What to scan ----------------------------------------------------- */

  /**
   * The folders the next scan will read. Empty until the defaults have been
   * asked for, which is the first thing the view does on mount.
   */
  folders: string[];
  includeSubfolders: boolean;
  /** True once the defaults have been fetched, so the view can wait for them. */
  isReady: boolean;

  /* --- Selection -------------------------------------------------------- */

  /**
   * The paths the user has ticked. A `Set` because every row asks whether it
   * is in here on every render.
   */
  selected: Set<string>;

  /* --- Confirming and acting -------------------------------------------- */

  /** Which action is being confirmed, or null when no dialog is open. */
  pendingAction: DuplicateAction | null;
  isActing: boolean;
  /** What the last completed action did. Cleared when the next one starts. */
  report: DuplicateActionReport | null;

  /* --- Actions ---------------------------------------------------------- */

  loadDefaults: () => Promise<void>;
  chooseFolders: () => Promise<void>;
  /**
   * Points the next scan at one folder, without opening the picker.
   *
   * The Storage Overview's "Find duplicates here" link, and the only
   * caller: a user who has just seen that `Downloads` holds 24 GB should
   * arrive here with `Downloads` already in the box rather than have to
   * find it again. It fills the same field {@link chooseFolders} fills and
   * stops there — no scan is started, because reading someone's folder is
   * still theirs to ask for.
   */
  focusFolder: (folder: string) => void;
  resetFolders: () => Promise<void>;
  setIncludeSubfolders: (include: boolean) => void;
  runScan: () => Promise<void>;

  toggleFile: (path: string) => void;
  selectCopiesIn: (groupId: string) => void;
  selectAllIn: (groupId: string) => void;
  clearGroup: (groupId: string) => void;
  clearSelection: () => void;

  requestAction: (action: DuplicateAction) => void;
  cancelAction: () => void;
  confirmDelete: () => Promise<void>;
  confirmMove: () => Promise<void>;
  dismissReport: () => void;
}

type Set_ = (partial: Partial<DuplicateState>) => void;
type Get_ = () => DuplicateState;

/**
 * The scan itself, shared by the Scan button and by the refresh that follows
 * an action.
 *
 * `keepReport` is the only difference between the two. A user-initiated scan
 * starts clean; the one after a delete has to leave the "3 files deleted ·
 * 1.2 GB" line alone, because it is the only record of what just happened and
 * the user has not read it yet.
 *
 * The selection is cleared either way. Group ids survive a re-scan but the
 * files behind them may not — a path deleted a second ago would still be
 * ticked, and a confirmation listing files that are no longer there is worse
 * than one the user has to build again.
 */
async function performScan(set: Set_, get: Get_, keepReport: boolean): Promise<void> {
  set({
    isScanning: true,
    error: null,
    selected: new Set(),
    ...(keepReport ? {} : { report: null }),
  });

  try {
    const { folders, includeSubfolders } = get();
    const scan = await scanDuplicates({ folders, includeSubfolders });

    // Rust reports the folders it actually walked — overlapping and duplicate
    // entries are collapsed — so the view describes what was read rather than
    // what was asked for.
    set({
      scan,
      isScanning: false,
      folders: scan.roots.length > 0 ? scan.roots : folders,
    });
  } catch (error) {
    set({ error: String(error), isScanning: false, scan: null });
  }
}

export const useDuplicateStore = create<DuplicateState>((set, get) => ({
  scan: null,
  isScanning: false,
  error: null,

  folders: [],
  includeSubfolders: true,
  isReady: false,

  selected: new Set<string>(),

  pendingAction: null,
  isActing: false,
  report: null,

  /* ------------------------------------------------------------------ */
  /* What to scan                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Asks Rust for Downloads and Desktop. Called once on mount, before any
   * scanning, so the view can show what it is about to read.
   *
   * A failure is not fatal and not shown: the picker still works, and a scan
   * sent with no folders falls back to the same defaults on the Rust side.
   */
  async loadDefaults() {
    if (get().isReady) return;

    try {
      const folders = await defaultDuplicateFolders();
      set({ folders, isReady: true });
    } catch {
      set({ isReady: true });
    }
  },

  focusFolder(folder) {
    // `isReady` too: this store loads Downloads and Desktop on mount when it
    // has never been opened, and that load would otherwise overwrite the
    // folder that was just handed to it.
    set({
      folders: [folder],
      isReady: true,
      scan: null,
      selected: new Set(),
      report: null,
      error: null,
    });
  },

  /** Opens the native folder picker and replaces the scan list with the result. */
  async chooseFolders() {
    const chosen = await chooseScanFolders();
    if (chosen === null) return;

    // New folders make the old results — and any selection made against them
    // — describe somewhere else. Both go.
    set({ folders: chosen, scan: null, selected: new Set(), report: null, error: null });
  },

  /** Back to Downloads + Desktop. */
  async resetFolders() {
    try {
      const folders = await defaultDuplicateFolders();
      set({ folders, scan: null, selected: new Set(), report: null, error: null });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  setIncludeSubfolders(include) {
    set({ includeSubfolders: include, scan: null, selected: new Set(), report: null });
  },

  runScan() {
    return performScan(set, get, false);
  },

  /* ------------------------------------------------------------------ */
  /* Selection — the only way a path reaches an action                   */
  /* ------------------------------------------------------------------ */

  toggleFile(path) {
    set((state) => {
      const selected = new Set(state.selected);
      if (!selected.delete(path)) selected.add(path);
      return { selected };
    });
  },

  /** Ticks everything in the group except the suggested keep. */
  selectCopiesIn(groupId) {
    const group = get().scan?.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    set((state) => {
      const selected = new Set(state.selected);
      for (const file of copiesIn(group)) selected.add(file.path);
      return { selected };
    });
  },

  /**
   * Ticks every file in the group, the suggested keep included.
   *
   * Allowed, because "I want none of these" is a real answer and refusing it
   * would be the app overruling the user. It is also the one selection that
   * leaves nothing behind, which is why the confirmation names every group it
   * would empty.
   */
  selectAllIn(groupId) {
    const group = get().scan?.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    set((state) => {
      const selected = new Set(state.selected);
      for (const file of group.files) selected.add(file.path);
      return { selected };
    });
  },

  clearGroup(groupId) {
    const group = get().scan?.groups.find((entry) => entry.id === groupId);
    if (!group) return;

    set((state) => {
      const selected = new Set(state.selected);
      for (const file of group.files) selected.delete(file.path);
      return { selected };
    });
  },

  clearSelection() {
    set({ selected: new Set() });
  },

  /* ------------------------------------------------------------------ */
  /* Confirm                                                             */
  /* ------------------------------------------------------------------ */

  /** Opens the confirmation. Performs nothing — that is the whole point. */
  requestAction(action) {
    if (get().selected.size === 0) return;
    set({ pendingAction: action, report: null });
  },

  cancelAction() {
    set({ pendingAction: null });
  },

  /* ------------------------------------------------------------------ */
  /* Act — reachable only from the confirmation above                    */
  /* ------------------------------------------------------------------ */

  /**
   * Deletes exactly the ticked files, permanently, and reports what happened
   * to each.
   *
   * Re-scans afterwards rather than editing the results in place: the folder
   * has changed, and a group that has lost a copy may not be a duplicate group
   * any more. Reading it back is the only way the next decision is made
   * against what is actually there.
   */
  async confirmDelete() {
    const { scan, selected } = get();
    if (!scan || selected.size === 0) return;

    const files = selectedFiles(scan.groups, selected);
    set({ isActing: true, pendingAction: null, error: null });

    try {
      const outcomes = await deleteDuplicateFiles(files.map((file) => file.path));
      set({ report: buildActionReport("delete", null, outcomes, files), isActing: false });
      await performScan(set, get, true);
    } catch (error) {
      set({ error: String(error), isActing: false });
    }
  },

  /**
   * Moves exactly the ticked files into a folder the user picks next.
   *
   * The destination is asked for *after* the confirmation rather than before,
   * so cancelling the picker is a second way out of an action that has still
   * not happened.
   */
  async confirmMove() {
    const { scan, selected } = get();
    if (!scan || selected.size === 0) return;

    set({ pendingAction: null, error: null });

    const destination = await chooseDestinationFolder();
    if (destination === null) return;

    const files = selectedFiles(scan.groups, selected);
    set({ isActing: true });

    try {
      const outcomes = await moveDuplicateFiles(
        files.map((file) => file.path),
        destination,
      );
      set({
        report: buildActionReport("move", destination, outcomes, files),
        isActing: false,
      });
      await performScan(set, get, true);
    } catch (error) {
      set({ error: String(error), isActing: false });
    }
  },

  dismissReport() {
    set({ report: null });
  },
}));
