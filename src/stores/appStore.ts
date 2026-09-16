import { create } from "zustand";

interface AppState {
  /**
   * Someone has asked for section 21's Start My Day dialog and the dashboard
   * has not opened it yet.
   *
   * A request rather than an "is open" flag, because three things ask — the
   * dashboard's button, the tray menu and the quick launcher — and the last
   * two arrive from outside the page (`useTrayActions`,
   * `useLauncherRequests`), navigating to the dashboard as they do. The
   * dashboard's dialog takes the request when it sees it and keeps its open
   * state to itself, so a dialog the user was navigated away from is gone
   * rather than waiting to reappear on the next visit.
   */
  startMyDayRequested: boolean;
  requestStartMyDay: () => void;
  /** Clears the request, answering whether there was one to take. */
  takeStartMyDayRequest: () => boolean;

  /**
   * The same, for section 22's end-of-day review (`EndOfDayDialog`), which
   * is asked for from the same three places.
   */
  reviewMyDayRequested: boolean;
  requestReviewMyDay: () => void;
  takeReviewMyDayRequest: () => boolean;
}

/**
 * App-wide signals that belong to no one feature's store.
 */
export const useAppStore = create<AppState>((set, get) => ({
  startMyDayRequested: false,
  requestStartMyDay: () => set({ startMyDayRequested: true }),
  takeStartMyDayRequest: () => {
    if (!get().startMyDayRequested) return false;
    set({ startMyDayRequested: false });
    return true;
  },

  reviewMyDayRequested: false,
  requestReviewMyDay: () => set({ reviewMyDayRequested: true }),
  takeReviewMyDayRequest: () => {
    if (!get().reviewMyDayRequested) return false;
    set({ reviewMyDayRequested: false });
    return true;
  },
}));
