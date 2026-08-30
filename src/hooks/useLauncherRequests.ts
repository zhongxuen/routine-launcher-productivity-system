/**
 * The main window's half of the quick launcher's `⏱ Start Focus`
 * (development-plan.md section 28).
 *
 * The launcher does everything else where it stands — see
 * `src/components/launcher/QuickLauncher.tsx` — because everything else is a
 * database operation and the database is what the two windows share. A focus
 * session is not: it is a clock, and the clock is `focusStore` in *this*
 * window. A row written from the launcher would be a timer nobody is
 * watching.
 *
 * So the launcher asks and this answers, which also happens to be the right
 * thing on its own terms: someone who pressed Start Focus wants to see the
 * clock, so arriving on the timer page is the point rather than the price.
 *
 * Mounted from the app shell alongside `useFocusLifecycle`, and for the same
 * reason: the request can land on any page, or on none, with the window
 * hidden behind the tray. It is kept out of that hook because the two are
 * different joins — one closes section 18's task-to-timer chain inside this
 * window, this one crosses a window boundary — and because this one needs the
 * router and that one does not.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { focusLengthCaption, FOCUS_TIMER_PATH } from "@/hooks/useStartFocus";
import { onFocusSessionRequested } from "@/lib/launcher-events";
import { useFocusStore } from "@/stores/focusStore";

export function useLauncherRequests(): void {
  const navigate = useNavigate();

  useEffect(() => {
    // `listen` is async, so the subscription can arrive after the shell has
    // gone — in which case it is dropped rather than left behind.
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void onFocusSessionRequested(() => {
      void startFromLauncher(navigate);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => {
        console.error("Could not subscribe to quick launcher requests:", cause);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [navigate]);
}

/**
 * Starts a session with whatever length the Focus page's picker is on, and
 * puts the clock on screen.
 *
 * Not `startFocusFor`: that one is for sessions attached to a *task*, and its
 * refusals are worded for a task. This is section 28's bare `⏱ Start Focus`,
 * so it carries no task, no routine and no length of its own — `startSession`
 * with no options is the same call the Focus page's own Start button makes,
 * which is what keeps the two from disagreeing about how long a session is.
 *
 * Navigation happens either way. A shortcut pressed against a clock that is
 * already running should still show the clock; refusing to move would leave
 * the user looking at Settings wondering whether anything happened at all.
 */
async function startFromLauncher(navigate: (path: string) => void): Promise<void> {
  const { session, startSession } = useFocusStore.getState();

  if (session) {
    navigate(FOCUS_TIMER_PATH);
    toast.info("A focus session is already running", {
      description: "Finish it before starting another one.",
    });
    return;
  }

  await startSession();

  const started = useFocusStore.getState();
  navigate(FOCUS_TIMER_PATH);

  if (!started.session) {
    toast.error("Could not start focus session", {
      description: started.sessionError ?? "The session could not be recorded.",
    });
    return;
  }

  toast.success("Focus session started", {
    description: focusLengthCaption(started.session),
  });
}
