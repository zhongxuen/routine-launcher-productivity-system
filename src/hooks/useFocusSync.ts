/**
 * Keeps this window's focus clock the same clock as every other window's.
 *
 * Mounted once per window that shows the timer — the app shell, through
 * `useFocusLifecycle`, and the widget of section 26. `useWindowSync` is the
 * same idea for tasks and routines; this one exists separately because a
 * running session is not something a window can re-read its way back to. See
 * `src/lib/focus-sync.ts`.
 *
 * Three lines of it:
 *
 * 1. **Adopt** what another window says the clock reads.
 * 2. **Answer** another window asking, but only when there is a session to
 *    answer with — silence is what "nothing is running" sounds like, and a
 *    window with no session has nothing to add.
 * 3. **Ask**, once, on mount. Announcements are only made when something
 *    changes, so a widget opened forty minutes into a session would otherwise
 *    hear nothing until it ended.
 *
 * Adopting never announces, which is what keeps two windows from echoing a
 * pause back and forth for ever.
 */

import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  announceFocusSession,
  onFocusSessionAnnounced,
  onFocusSessionRequested,
  requestFocusSession,
} from "@/lib/focus-sync";
import { useFocusStore } from "@/stores/focusStore";

export function useFocusSync(): void {
  useEffect(() => {
    // `listen` is async, so the window can be gone before either
    // subscription exists — in which case they are unsubscribed the moment
    // they arrive rather than left behind.
    const unlisten: UnlistenFn[] = [];
    let cancelled = false;

    const keep = (fn: UnlistenFn) => {
      if (cancelled) fn();
      else unlisten.push(fn);
    };

    void Promise.all([
      onFocusSessionAnnounced((session) => {
        useFocusStore.getState().adoptSession(session);
      }),
      onFocusSessionRequested(() => {
        const session = useFocusStore.getState().session;
        if (session) announceFocusSession(session);
      }),
    ])
      .then((fns) => {
        fns.forEach(keep);
        // Asked only once both subscriptions are live, so the answer cannot
        // arrive before there is anything listening for it.
        if (!cancelled) requestFocusSession();
      })
      .catch((cause) => {
        // A window that cannot hear the others still runs its own clock
        // correctly; it is only the second window that would drift. Not
        // worth a visible error over.
        console.error("Could not subscribe to the focus session:", cause);
      });

    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);
}
