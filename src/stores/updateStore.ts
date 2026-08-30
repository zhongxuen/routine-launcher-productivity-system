/**
 * What this run knows about the next release (development-plan.md section
 * 85).
 *
 * A store rather than component state because two places that never meet in
 * the tree ask the same question. The app shell runs the once-per-launch
 * check (`useUpdateCheck`), and Settings &rsaquo; Updates draws the answer —
 * and the user may open Settings long after the check finished, or never. A
 * card that re-checked on mount would put a second request on the wire for
 * something this run has already found out.
 *
 * It holds nothing across runs. A release found an hour ago is a claim about
 * a server, and the only honest way to refresh it is to ask again, which is
 * what {@link UpdateState.check} is for.
 */

import { create } from "zustand";

import {
  checkForUpdate,
  installUpdate,
  type AvailableUpdate,
  type DownloadProgress,
} from "@/services/updateService";

/**
 * Where this run has got to.
 *
 * `current` and `available` are both *successful* checks and are kept apart
 * because they say opposite things to the user. `error` is the third answer —
 * we could not find out — and is deliberately not one of them: an app that
 * showed "up to date" when it had failed to reach the endpoint would be
 * lying in the one direction that matters.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "error";

interface UpdateState {
  status: UpdateStatus;
  /** The release found, when `status` is `available` or `downloading`. */
  update: AvailableUpdate | null;
  /** How far the download has got, when `status` is `downloading`. */
  progress: DownloadProgress | null;
  /** Why the last check or install failed, when `status` is `error`. */
  error: string | null;
  /**
   * Whether the once-per-launch check has already been made.
   *
   * Guards `useUpdateCheck` against React's development double-mount and
   * against a shell that re-mounts, either of which would otherwise put a
   * second request on the wire for an answer this run already has.
   */
  hasCheckedThisRun: boolean;

  /**
   * Asks the endpoint what the newest release is.
   *
   * Resolves to whether an update was found, so the caller can decide what to
   * say about it — the launch check raises a toast, the Settings button does
   * not need one because the card it sits in is already showing the answer.
   * Never throws: a failure becomes `status: "error"`.
   */
  check: () => Promise<boolean>;

  /**
   * Downloads and installs the release found.
   *
   * On success this does not return — the installer takes the machine and the
   * process ends. Anything after the await is therefore a failure path, which
   * is why there is no "installed" status for it to reach.
   */
  install: () => Promise<void>;

  /** Records download progress from the backend's event. */
  setProgress: (progress: DownloadProgress) => void;

  /** Clears a failure so the card can be tried again from a clean state. */
  dismissError: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: "idle",
  update: null,
  progress: null,
  error: null,
  hasCheckedThisRun: false,

  async check() {
    set({ status: "checking", error: null });

    try {
      const found = await checkForUpdate();
      set({
        status: found ? "available" : "current",
        update: found,
        hasCheckedThisRun: true,
      });
      return found !== null;
    } catch (cause) {
      set({ status: "error", error: String(cause), hasCheckedThisRun: true });
      return false;
    }
  },

  async install() {
    if (!get().update) return;
    set({ status: "downloading", progress: null, error: null });

    try {
      await installUpdate();
      // Reached only when the installer did not take over. There is no
      // success case here to fall through to — see the doc comment.
      set({
        status: "error",
        error: "The installer did not start. The update has not been applied.",
      });
    } catch (cause) {
      set({ status: "error", error: String(cause) });
    }
  },

  setProgress(progress) {
    // Ignored unless a download is what is on screen: the event can outlive
    // the state it describes if an install failed mid-stream.
    if (get().status !== "downloading") return;
    set({ progress });
  },

  dismissError() {
    // Back to `idle` rather than to whatever preceded the failure: the last
    // thing this run knew about the server is exactly what the failure calls
    // into question.
    set({ status: "idle", error: null, progress: null });
  },
}));
