import { create } from "zustand";

interface AppState {
  /** Placeholder piece of state used only to prove the zustand wiring works. */
  bootCount: number;
  incrementBootCount: () => void;
}

/**
 * Placeholder global store. Feature-specific stores (taskStore, routineStore,
 * focusStore, progressStore, settingsStore, ...) will be added alongside
 * their features in later prompts.
 */
export const useAppStore = create<AppState>((set) => ({
  bootCount: 0,
  incrementBootCount: () => set((state) => ({ bootCount: state.bootCount + 1 })),
}));
