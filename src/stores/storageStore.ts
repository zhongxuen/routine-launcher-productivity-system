/**
 * Storage Overview store — development-plan.md sections 38, 66, 67.
 *
 * Holds one report: the fixed drives, and the profile's top-level folders
 * with their sizes as they arrive.
 *
 * # There is nothing in here that can change a file
 *
 * The four Cleanup stores beside this one exist to carry a selection from a
 * scan to a confirmation to an action. This one has no selection, no pending
 * action and no action methods, because the utility has none — where it would
 * act it links into Large Files or Duplicates instead, and those keep their
 * own confirmations. So the only rule this store has to honour is that a
 * read is a read.
 *
 * # Why the sizing is a loop here rather than one call to Rust
 *
 * Sizing a profile takes tens of seconds and the answer is wanted before
 * then, so `sizeProfileFolder` measures exactly one folder and this store
 * calls it once per folder, writing each figure in as it lands. Three things
 * follow from that, all of them requirements rather than conveniences:
 *
 * * The list is useful immediately — the biggest folder found *so far* is on
 *   top from the first result onwards.
 * * Stop works. It cancels the token, so the walk already running stops where
 *   it is, and the loop sees the token change and stops asking for more.
 * * One folder that cannot be read cannot fail the report. It is dropped or
 *   counted as skipped, and the other eleven are unaffected.
 *
 * # It keeps its results between visits
 *
 * Cleanup is a sub-nav, and a user who glances at Duplicates and comes back
 * should not restart a minute of walking. {@link StorageState.load} is
 * therefore a no-op once a report exists; {@link StorageState.refresh} is the
 * one that re-reads, and it is reached from a button.
 */

import { toast } from "sonner";
import { create } from "zustand";

import {
  cancelStorageScan,
  getStorageOverview,
  sizeProfileFolder,
} from "@/services/storageService";
import type { Drive, SizedFolder } from "@/types/storage";

interface StorageState {
  /** The fixed drives. Empty until the first read lands. */
  drives: Drive[];
  /** The profile directory — `C:\Users\Ada` — or `null` before the read. */
  profile: string | null;
  /** Its top-level folders, sized as the answers come in. */
  folders: SizedFolder[];
  /** The current scan's token, and `null` when no report has been read. */
  token: number | null;

  /** True while the (fast) drives-and-folders read is in flight. */
  isLoading: boolean;
  /** True while folders are still being measured. */
  isSizing: boolean;
  /** The folder being measured right now, for the line above the list. */
  sizingPath: string | null;
  /** A failed read, already in user-presentable form. */
  error: string | null;

  /** Reads the report if there is not one already. Called on mount. */
  load: () => Promise<void>;
  /** Reads it again from scratch. Called from the Refresh button. */
  refresh: () => Promise<void>;
  /** Stops the measuring where it is, keeping what has been measured. */
  stop: () => Promise<void>;
}

export const useStorageStore = create<StorageState>((set, get) => ({
  drives: [],
  profile: null,
  folders: [],
  token: null,
  isLoading: false,
  isSizing: false,
  sizingPath: null,
  error: null,

  async load() {
    // A report already read — or one being read — is left alone. Re-reading
    // here would abandon a walk that is halfway through every time the user
    // came back to the tab. `profile` rather than `token` is the test,
    // because a stopped scan has no token and its results are still on
    // screen: coming back to them must not throw them away and start over.
    if (get().profile !== null || get().isLoading) return;
    await read(set, get);
  },

  async refresh() {
    if (get().isLoading) return;
    await read(set, get);
  },

  async stop() {
    if (!get().isSizing) return;

    // The flag goes down first so the button stops offering something that
    // has already happened; the loop notices the token change and stops
    // asking for the folders it has not reached.
    set({ isSizing: false, sizingPath: null, token: null });

    try {
      await cancelStorageScan();
    } catch (cause) {
      // The walk stops when the token is bumped, and the token was bumped by
      // the call that failed — so this is worth saying and not worth
      // pretending about: the measuring in flight may run to its own limit.
      toast.error("Could not stop the measurement", { description: String(cause) });
    }
  },
}));

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

type Setter = (
  partial: Partial<StorageState> | ((state: StorageState) => Partial<StorageState>),
) => void;

/**
 * Reads the drives and the folder list, then starts measuring.
 *
 * The two halves are deliberately not awaited together: the first is
 * instantaneous and puts the whole page on screen, and the second is the
 * minute-long part the user watches fill in.
 */
async function read(set: Setter, get: () => StorageState): Promise<void> {
  set({ isLoading: true, error: null, sizingPath: null });

  try {
    const overview = await getStorageOverview();

    set({
      drives: overview.drives,
      profile: overview.profile,
      // Every folder is on screen from this moment, each with no size yet.
      // Drawing the list now rather than as results arrive is what stops the
      // page looking like it found three folders and then eleven.
      folders: overview.folders.map((folder) => ({ ...folder, size: null })),
      token: overview.token,
      isLoading: false,
      isSizing: overview.folders.length > 0,
    });

    void measure(set, get, overview.token);
  } catch (cause) {
    // The drives could not be read, which means there is no report at all —
    // unlike a folder failing, which costs one row.
    set({ isLoading: false, isSizing: false, error: String(cause) });
  }
}

/**
 * Measures each folder in turn, writing every answer in as it arrives.
 *
 * Sequential on purpose. These walks are bound by the disk rather than by the
 * CPU, so a dozen at once would finish no sooner and would make the "measuring
 * AppData…" line meaningless — and the point of the whole arrangement is that
 * the user can watch it happen and stop it.
 *
 * `token` is checked before and after every call: before, so a cancelled scan
 * asks for nothing more; after, so a result that arrived from an abandoned
 * scan is discarded rather than written into a report it does not belong to.
 */
async function measure(set: Setter, get: () => StorageState, token: number): Promise<void> {
  for (const folder of get().folders) {
    if (get().token !== token) return;

    set({ sizingPath: folder.path });

    try {
      const size = await sizeProfileFolder(folder.path, token);
      if (get().token !== token) return;

      // The walk was stopped mid-way. Whatever it had is a floor rather than
      // a total, and the user asked for it to stop, so nothing is written and
      // nothing is said.
      if (size.stopped === "cancelled") {
        set({ isSizing: false, sizingPath: null });
        return;
      }

      set((state) => ({
        folders: state.folders.map((held) =>
          held.path === folder.path ? { ...held, size } : held,
        ),
      }));
    } catch {
      // A folder that has gone between being listed and being measured — the
      // only failure `size_profile_folder` has, since a folder it cannot open
      // is counted rather than raised. It leaves the list, because it is no
      // longer in the profile the list describes. The measuring carries on:
      // one missing folder is not a failed report.
      set((state) => ({
        folders: state.folders.filter((held) => held.path !== folder.path),
      }));
    }
  }

  if (get().token === token) set({ isSizing: false, sizingPath: null });
}
