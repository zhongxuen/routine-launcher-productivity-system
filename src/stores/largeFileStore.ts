/**
 * Large File Finder store — development-plan.md sections 38, 41 and 67.
 *
 * Holds one scan and the settings around it. It lives in a store rather than
 * in the view for one reason worth stating: a scan can take the better part
 * of a minute, and the Large Files view is one tab of the Cleanup sub-nav. A
 * user who glances at Duplicates and comes back should not have to run it
 * again.
 *
 * # What this store will not do
 *
 * Section 67's order is scan -> show results -> user selects -> confirm ->
 * perform action, and the store is written so no path through it can skip a
 * step:
 *
 * * The action methods each take a single {@link LargeFile}. There is no
 *   "act on the selection", no "clean up everything over 1 GB", and nothing
 *   that loops. Ten files means ten confirmations.
 * * Nothing is called from an effect, a timer or a subscription. Every method
 *   below is reached from a button the user pressed, and the three
 *   destructive ones are reached only from the confirmation dialog's own
 *   button.
 * * {@link LargeFileState.runScan} is the only bulk operation and it is
 *   read-only.
 *
 * # After an action, the row goes and the totals follow
 *
 * A file that was moved, archived or deleted is dropped from `scan` and the
 * summary figures are adjusted with it, rather than the scan being re-run.
 * Re-running would be another minute's wait to learn something already known,
 * and — worse — would silently re-order the list under a user who was working
 * down it.
 */

import { toast } from "sonner";
import { create } from "zustand";

import { emitProgressChanged } from "@/lib/progress-events";
import {
  archiveLargeFile,
  clearIgnoredLargeFiles,
  deleteLargeFile,
  getLargeFilePreferences,
  ignoreLargeFile,
  moveLargeFile,
  openLargeFile,
  pickFolder,
  resetLargeFileArchiveRoot,
  scanLargeFiles,
  setLargeFileArchiveRoot,
  unignoreLargeFile,
} from "@/services/largeFileService";
import {
  formatBytes,
  type LargeFile,
  type LargeFilePreferences,
  type LargeFileScan,
} from "@/types/large-files";

/** The threshold a first load shows before preferences have arrived. */
const FALLBACK_THRESHOLD_MB = 100;

interface LargeFileState {
  /** What the backend remembers. `null` until the first read lands. */
  preferences: LargeFilePreferences | null;

  /**
   * The folder the *next* scan would use. Starts as the last scanned folder
   * and changes the moment the user picks another — which is why it is held
   * apart from `scan.root`, the folder the results on screen came from. The
   * two differing is what lets the view say "these results are from
   * somewhere else".
   */
  root: string | null;
  /** The threshold the next scan would use, likewise. */
  thresholdMb: number;

  /** The scan on screen, or `null` before the first one. */
  scan: LargeFileScan | null;

  /** True while the first preferences read is in flight. */
  isLoading: boolean;
  /** True while a scan is walking the disk. */
  isScanning: boolean;
  /**
   * The path of the file an action is running on, so its row can show a
   * spinner and stop accepting clicks. One at a time by design: the actions
   * are per file and confirmed per file.
   */
  busyPath: string | null;
  /** A failed scan, already in user-presentable form. */
  error: string | null;

  loadPreferences: () => Promise<void>;
  setThresholdMb: (thresholdMb: number) => void;
  /** Opens the folder picker and remembers what was chosen. */
  chooseRoot: () => Promise<void>;
  /**
   * Points the next scan at `folder`, without opening the picker.
   *
   * The Storage Overview's "Find large files here" link, and the only
   * caller: a user who has just seen that `Downloads` holds 24 GB should
   * arrive here with `Downloads` already chosen rather than have to find
   * it again. It sets exactly what {@link chooseRoot} sets and stops
   * there — no scan is started, because walking someone's folder is still
   * theirs to ask for.
   */
  focusFolder: (folder: string) => void;
  /** Walks the chosen folder. Read-only; changes nothing on disk. */
  runScan: () => Promise<void>;
  /** Forgets the results without touching a file. */
  clearScan: () => void;

  openFile: (file: LargeFile) => Promise<void>;
  /** Confirm before calling. `destination` came from the folder picker. */
  moveFile: (file: LargeFile, destination: string) => Promise<void>;
  /** Confirm before calling. */
  archiveFile: (file: LargeFile) => Promise<void>;
  /** Confirm before calling. Goes to the Recycle Bin. */
  deleteFile: (file: LargeFile) => Promise<void>;
  /** No confirmation: nothing on disk changes and one click undoes it. */
  ignoreFile: (file: LargeFile) => Promise<void>;

  unignore: (path: string) => Promise<void>;
  clearIgnored: () => Promise<void>;
  chooseArchiveRoot: () => Promise<void>;
  resetArchiveRoot: () => Promise<void>;
}

export const useLargeFileStore = create<LargeFileState>((set, get) => ({
  preferences: null,
  root: null,
  thresholdMb: FALLBACK_THRESHOLD_MB,
  scan: null,
  isLoading: false,
  isScanning: false,
  busyPath: null,
  error: null,

  async loadPreferences() {
    set({ isLoading: get().preferences === null });

    try {
      const preferences = await getLargeFilePreferences();
      set((state) => ({
        preferences,
        isLoading: false,
        // Only seeds the form on the first read. A later reload — after the
        // archive folder changed, say — must not pull the folder the user has
        // just picked back to the one the last scan used.
        root: state.root ?? preferences.root,
        thresholdMb: state.preferences === null ? preferences.thresholdMb : state.thresholdMb,
      }));
    } catch (cause) {
      // Not fatal and not shown as a page error: without preferences the view
      // still works, it just opens on no folder and the default threshold.
      set({ isLoading: false });
      toast.error("Could not read your Large Files settings", {
        description: String(cause),
      });
    }
  },

  setThresholdMb(thresholdMb) {
    set({ thresholdMb });
  },

  async chooseRoot() {
    try {
      const chosen = await pickFolder("Choose a folder to search", get().root);
      if (chosen === null) return;
      set({ root: chosen, error: null });
    } catch (cause) {
      toast.error("Could not open the folder picker", { description: String(cause) });
    }
  },

  focusFolder(folder) {
    // The old results go with it: they describe somewhere else, and leaving
    // them on screen under a new folder name would be the view lying about
    // where they came from.
    set({ root: folder, scan: null, error: null });
  },

  async runScan() {
    const { root, thresholdMb, isScanning } = get();
    if (root === null || isScanning) return;

    set({ isScanning: true, error: null });

    try {
      const scan = await scanLargeFiles(root, thresholdMb);
      set({ scan, isScanning: false });

      // The scan is what the user asked for, so it is not announced. The one
      // outcome worth a word is finding nothing, which otherwise looks like a
      // scan that did not run.
      if (scan.files.length === 0 && scan.ignoredMatches === 0) {
        toast.success("Nothing over that size", {
          description: `Searched ${scan.filesSeen.toLocaleString()} files in ${scan.root}.`,
        });
      }
    } catch (cause) {
      // The previous results, if any, stay on screen: a failed re-scan is not
      // a reason to throw away an answer the user was working through.
      set({ isScanning: false, error: String(cause) });
    }
  },

  clearScan() {
    set({ scan: null, error: null });
  },

  async openFile(file) {
    try {
      await openLargeFile(file.path);
    } catch (cause) {
      toast.error(`Could not open ${file.name}`, { description: String(cause) });
      // A file that has gone is one the list should stop offering. Any other
      // failure leaves the row alone — the file is still there.
      if (String(cause).includes("no longer there")) dropFile(set, file.path);
    }
  },

  async moveFile(file, destination) {
    await perform(set, get, file, () => moveLargeFile(file.path, destination), (result) => ({
      title: `Moved ${result.name}`,
      description: result.renamed
        ? `${destination} already held ${file.name}, so it was saved as ${result.name}.`
        : `${formatBytes(result.sizeBytes)} moved to ${destination}.`,
    }));
  },

  async archiveFile(file) {
    await perform(
      set,
      get,
      file,
      () => archiveLargeFile(file.path, file.modifiedMs),
      (result) => ({
        title: `Archived ${result.name}`,
        description: result.renamed
          ? `The archive already held ${file.name}, so it was saved as ${result.name} in ${result.to}.`
          : `${formatBytes(result.sizeBytes)} moved to ${result.to}.`,
      }),
    );
  },

  async deleteFile(file) {
    await perform(set, get, file, () => deleteLargeFile(file.path), (result) => ({
      title: `${result.name} sent to the Recycle Bin`,
      // Said every time. The promise the confirmation dialog made is worth
      // repeating at the moment it comes true, because that is when the user
      // is deciding whether to trust the next one.
      description: `${formatBytes(result.sizeBytes)} freed. Restore it from the Recycle Bin if you change your mind.`,
    }));
  },

  async ignoreFile(file) {
    set({ busyPath: file.path });

    try {
      const ignored = await ignoreLargeFile(file.path);
      set((state) => ({
        busyPath: null,
        preferences: state.preferences && { ...state.preferences, ignored },
        // The file is still on disk and still over the threshold, so it moves
        // from the list into the ignored count rather than out of the scan
        // altogether. `shownBytes` follows it; `matched` does not.
        scan: state.scan && {
          ...state.scan,
          files: state.scan.files.filter((held) => held.path !== file.path),
          shownBytes: state.scan.shownBytes - file.sizeBytes,
          ignoredMatches: state.scan.ignoredMatches + 1,
        },
      }));

      toast.success(`Ignoring ${file.name}`, {
        description: "It will be left out of future searches. Undo this from the Ignored list.",
      });
    } catch (cause) {
      set({ busyPath: null });
      toast.error(`Could not ignore ${file.name}`, { description: String(cause) });
    }
  },

  async unignore(path) {
    try {
      const ignored = await unignoreLargeFile(path);
      set((state) => ({
        preferences: state.preferences && { ...state.preferences, ignored },
      }));
      toast.success("Back in future searches", { description: path });
    } catch (cause) {
      toast.error("Could not stop ignoring that file", { description: String(cause) });
    }
  },

  async clearIgnored() {
    try {
      const ignored = await clearIgnoredLargeFiles();
      set((state) => ({
        preferences: state.preferences && { ...state.preferences, ignored },
      }));
      toast.success("Ignore list cleared");
    } catch (cause) {
      toast.error("Could not clear the ignore list", { description: String(cause) });
    }
  },

  async chooseArchiveRoot() {
    try {
      const chosen = await pickFolder(
        "Choose where to archive files",
        get().preferences?.archiveRoot,
      );
      if (chosen === null) return;

      set({ preferences: await setLargeFileArchiveRoot(chosen) });
      toast.success("Archive folder changed", { description: chosen });
    } catch (cause) {
      toast.error("Could not change the archive folder", { description: String(cause) });
    }
  },

  async resetArchiveRoot() {
    try {
      const preferences = await resetLargeFileArchiveRoot();
      set({ preferences });
      toast.success("Archive folder reset", { description: preferences.archiveRoot });
    } catch (cause) {
      toast.error("Could not reset the archive folder", { description: String(cause) });
    }
  },
}));

/* -------------------------------------------------------------------------- */
/* Shared mechanics                                                           */
/* -------------------------------------------------------------------------- */

type Setter = (
  partial: Partial<LargeFileState> | ((state: LargeFileState) => Partial<LargeFileState>),
) => void;

/**
 * Takes a file out of the scan on screen and corrects the totals with it.
 *
 * `matched` comes down too, unlike in `ignoreFile`: the file is genuinely no
 * longer in the folder, so the "12 files over 100 MB" line would be wrong if
 * it still counted this one.
 */
function dropFile(set: Setter, path: string): void {
  set((state) => {
    if (!state.scan) return {};

    const going = state.scan.files.find((file) => file.path === path);
    if (!going) return {};

    return {
      scan: {
        ...state.scan,
        files: state.scan.files.filter((file) => file.path !== path),
        shownBytes: state.scan.shownBytes - going.sizeBytes,
        matched: Math.max(0, state.scan.matched - 1),
      },
    };
  });
}

/**
 * The body every destructive action shares: mark the row busy, do the one
 * thing, drop the row and say what happened.
 *
 * Shared so all three report success and failure identically — and so there
 * is exactly one place where a file leaves the list, which is the invariant
 * worth being able to point at in a feature whose whole subject is not losing
 * track of what happened to a file.
 */
async function perform(
  set: Setter,
  get: () => LargeFileState,
  file: LargeFile,
  action: () => Promise<import("@/types/large-files").FileActionResult>,
  describe: (
    result: import("@/types/large-files").FileActionResult,
  ) => { title: string; description: string },
): Promise<void> {
  if (get().busyPath !== null) return;
  set({ busyPath: file.path });

  try {
    const result = await action();
    dropFile(set, file.path);
    set({ busyPath: null });
    // Move, Archive and Delete are recorded as cleanup actions, which can
    // unlock Organized. See `src/lib/progress-events.ts`.
    emitProgressChanged();

    const { title, description } = describe(result);
    toast.success(title, { description });
  } catch (cause) {
    set({ busyPath: null });
    const message = String(cause);

    toast.error(`Could not do that to ${file.name}`, { description: message });

    // The one failure that should still change the list: the file was gone
    // before we got to it. Anything else — a permission, a lock, a full disk
    // — leaves the file where it is, so the row stays.
    if (message.includes("no longer there")) dropFile(set, file.path);
  }
}
