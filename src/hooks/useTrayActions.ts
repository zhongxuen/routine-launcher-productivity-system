/**
 * Turns a tray menu choice into the thing the app already does
 * (development-plan.md sections 27, 79).
 *
 * This is the other end of `src-tauri/src/services/tray.rs`. The menu is
 * drawn and its data read in Rust, but nothing it offers is *done* there:
 *
 * ```text
 * ☀️ Start My Day ─▶ appStore.requestStartMyDay (§21's dialog, on the dashboard)
 * 🌙 Review My Day ─▶ appStore.requestReviewMyDay (§22's dialog, on the dashboard)
 * 🚀 Coding      ─▶ routineStore.launchRoutine  (§32's checklist panel)
 * ⏱ Start Focus  ─▶ startFocusFor               (§19's clock, on the picked preset)
 * + Add Task     ─▶ taskStore.openQuickAdd      (§16's dialog)
 * Open Dashboard ─▶ navigate("/")
 * Settings       ─▶ navigate("/settings")
 * ```
 *
 * Every arrow lands on the same call the button for it in the app makes. A
 * routine launched from the tray is recorded, counted and reported exactly
 * like one launched from a card; a session started from the tray is one
 * session, in the one store, with the same rule against a second. The tray is
 * a shortcut to the app, not a second copy of it.
 *
 * Mounted from `AppLayout` beside the other things that outlive the page
 * being looked at, because a tray click can arrive on any page — or on none,
 * with the window hidden in the tray, which is the case it exists for. Rust
 * shows the window before it emits, so by the time this runs there is
 * something to look at.
 *
 * Each handler navigates *first*. The panel a launch draws is mounted by the
 * dashboard and the clock by the Focus page — so a menu item that acted
 * without moving the user would be a menu item that appeared to do nothing
 * from the wrong page. Quick-add is mounted by the shell and would open on any
 * page; Add Task still goes to Today so the task is seen to land.
 */

import { useEffect } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { FOCUS_TIMER_PATH, startFocusFor } from "@/hooks/useStartFocus";
import { onTrayAction, type TrayAction } from "@/services/trayService";
import { useAppStore } from "@/stores/appStore";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";

/** The list quick-add's default due date puts a new task in. */
const TASKS_TODAY_PATH = "/tasks/today";

const DASHBOARD_PATH = "/";
const SETTINGS_PATH = "/settings";

export function useTrayActions(): void {
  const navigate = useNavigate();

  useEffect(() => {
    // `listen` is async, so the window can be gone before the subscription
    // exists — in which case it is unsubscribed the moment it arrives.
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void onTrayAction((action) => {
      void runTrayAction(action, navigate);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => {
        // The menu still opens and still shows today's count; only its
        // actions stop landing. Worth the console, not worth a dialog over a
        // window the user may not even be looking at.
        console.error("Could not subscribe to the tray menu:", cause);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [navigate]);
}

/**
 * Does what the menu item asked for.
 *
 * Split out of the hook so the mapping is one readable list rather than
 * something buried in a subscription, and so an exhaustive `switch` is what
 * proves every action in {@link TrayAction} is handled.
 */
async function runTrayAction(
  action: TrayAction,
  navigate: NavigateFunction,
): Promise<void> {
  switch (action.kind) {
    case "launch-routine": {
      // The dashboard is where §32's launch panel is mounted, so that is
      // where a launch has to happen to be visible.
      navigate(DASHBOARD_PATH);

      // `launchRoutine` looks the routine up in the store and quietly does
      // nothing if it is not there — which is exactly the state a window that
      // has been sitting in the tray since before the routine was created is
      // in. The menu was built from the database a moment ago, so the id is
      // good; it is this window's copy of the list that is behind.
      const store = useRoutineStore.getState();
      if (!store.routines.some((routine) => routine.id === action.routine_id)) {
        await store.loadRoutines();
      }

      await useRoutineStore.getState().launchRoutine(action.routine_id);
      return;
    }

    case "start-my-day": {
      // The dashboard mounts the dialog, and the launch panel it hands over
      // to, so that is where it opens.
      navigate(DASHBOARD_PATH);
      useAppStore.getState().requestStartMyDay();
      return;
    }

    case "review-my-day": {
      navigate(DASHBOARD_PATH);
      useAppStore.getState().requestReviewMyDay();
      return;
    }

    case "start-focus": {
      navigate(FOCUS_TIMER_PATH);

      // No options: the session is sized by whichever preset the Focus page
      // is on, the same as pressing Start there. Nothing on a tray menu named
      // a task or a length, and §88 would rather use the user's own default
      // than invent one. A session already running is refused and said so by
      // `startFocusFor`, and the navigation above has put the clock it is
      // talking about on screen.
      await startFocusFor({});
      return;
    }

    case "add-task": {
      navigate(TASKS_TODAY_PATH);
      useTaskStore.getState().openQuickAdd();
      return;
    }

    case "open-dashboard":
      navigate(DASHBOARD_PATH);
      return;

    case "open-settings":
      navigate(SETTINGS_PATH);
  }
}
