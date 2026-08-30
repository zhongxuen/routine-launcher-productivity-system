/**
 * First-run walkthrough state (development-plan.md section 84).
 *
 * A store rather than component state for two reasons. The tour is raised by
 * the app shell but replayed from Settings, so two places that never meet in
 * the tree both open it; and its two working steps hand their results
 * forward — the task made on step 2 is what step 3's routine gets attached
 * to — so what has been created has to outlive the step that created it.
 *
 * It owns none of that creating. `createTask` and `createRoutine` stay in
 * their own stores and are called from the dialog, so a task made here is the
 * same task, through the same command, as one made from + Add Task. All this
 * holds is which step is on screen and what the tour has to show for itself.
 */

import { create } from "zustand";

import { ONBOARDING_STEP_COUNT } from "@/lib/onboarding";
import { getOnboardingSeen, setOnboardingSeen } from "@/services/onboardingService";

/** What the tour created on a doing step, for the steps after it to refer to. */
interface CreatedTask {
  id: number;
  title: string;
}

interface CreatedRoutine {
  id: number;
  name: string;
}

interface OnboardingState {
  /** Whether the walkthrough is on screen. */
  isOpen: boolean;
  /** Index into `ONBOARDING_STEPS`. */
  stepIndex: number;
  /**
   * Whether the first-launch flag has been read this session.
   *
   * Guards {@link OnboardingState.checkFirstRun} so a re-mounted shell — and
   * React's development double-mount — cannot re-open a tour the user has
   * just skipped, before the write of the flag has even landed.
   */
  hasChecked: boolean;

  /** The task made on the "task" step, if the user made one. */
  createdTask: CreatedTask | null;
  /** The routine made on the "routine" step, if the user made one. */
  createdRoutine: CreatedRoutine | null;

  /**
   * Reads the flag and opens the tour if this is a first launch.
   *
   * Safe to call from an effect: it runs once per session and never throws.
   * A failed read is treated as "already seen" — the cost of that is a user
   * who does not get a tour, against the cost of the other choice, which is
   * a tour in front of somebody every single launch.
   */
  checkFirstRun: () => Promise<void>;

  /** Opens the tour at step one, from Settings. Ignores the flag. */
  restart: () => void;

  next: () => void;
  back: () => void;

  recordTask: (task: CreatedTask) => void;
  recordRoutine: (routine: CreatedRoutine) => void;

  /**
   * Closes the tour and records that it has been seen.
   *
   * One function for both ways out, because the flag does not distinguish
   * them: finishing and skipping are equally "has seen it" (see
   * `src-tauri/src/services/onboarding.rs`). Closes first and writes after,
   * so the dialog goes away on the press rather than after a round trip to
   * SQLite. Rejects if the write failed — the tour is gone either way, but
   * the caller is the only thing that can say the flag did not stick.
   */
  finish: () => Promise<void>;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  isOpen: false,
  stepIndex: 0,
  hasChecked: false,
  createdTask: null,
  createdRoutine: null,

  async checkFirstRun() {
    if (get().hasChecked) return;
    set({ hasChecked: true });

    try {
      if (await getOnboardingSeen()) return;
      set({ isOpen: true, stepIndex: 0, createdTask: null, createdRoutine: null });
    } catch (cause) {
      // Not surfaced: nothing is broken from where the user is sitting, and
      // a toast about a tour they have never seen would be its own puzzle.
      console.error("could not read the onboarding flag", cause);
    }
  },

  restart() {
    set({ isOpen: true, stepIndex: 0, createdTask: null, createdRoutine: null });
  },

  next() {
    set((state) => ({ stepIndex: Math.min(state.stepIndex + 1, ONBOARDING_STEP_COUNT - 1) }));
  },

  back() {
    set((state) => ({ stepIndex: Math.max(state.stepIndex - 1, 0) }));
  },

  recordTask(task) {
    set({ createdTask: task });
  },

  recordRoutine(routine) {
    set({ createdRoutine: routine });
  },

  async finish() {
    set({ isOpen: false });
    await setOnboardingSeen(true);
  },
}));
