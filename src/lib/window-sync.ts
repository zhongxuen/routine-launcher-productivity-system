/**
 * Keeping two windows from disagreeing about the same database.
 *
 * The compact popup (development-plan.md section 25) is a second OS window,
 * which means a second webview, which means a second copy of every zustand
 * store. Both read the same SQLite file, so a task ticked off in the popup is
 * really ticked off — but the main window is holding a list it read before
 * that happened, and nothing would tell it. Two windows quietly showing
 * different answers about today is worse than either window alone.
 *
 * So a window that changes something says so, and the others re-read:
 *
 * ```text
 * popup  ──toggleTaskCompletion──▶ SQLite
 *        └─announceDataChanged("tasks")─▶  main window re-reads its view
 * ```
 *
 * This is the same idea as `focus-events.ts` and `focus-intent.ts` — an
 * announcement rather than one module reaching into another — except it has
 * to cross a process-level boundary, so it goes through Tauri's event bus
 * instead of a `Set` of handlers. What travels is only *that* something
 * changed, never the changed rows: the database is the shared state, and a
 * re-read is how a window gets the backend's derived values (`is_overdue`,
 * `completed_at`, `launch_count`) rather than a guess at them.
 *
 * Emitting is deliberately fire-and-forget. The write it follows has already
 * landed; a broadcast that fails is a stale list in another window, not a
 * lost edit, and it must never be the reason a mutation reports failure.
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Which store's data changed. Coarse on purpose — the answer is a re-read. */
export type DataScope = "tasks" | "routines" | "settings";

const DATA_CHANGED_EVENT = "app://data-changed";

interface DataChangedPayload {
  scope: DataScope;
  /** Which webview wrote it, so nobody re-reads on their own announcement. */
  source: string;
}

/**
 * This webview's identity for the length of its life.
 *
 * Tauri's `emit` broadcasts to every window including the sender, and a
 * window that re-read on its own writes would run a redundant query after
 * every keystroke-sized change — and, worse, could clobber a newer optimistic
 * state with an older read. Comparing against this is the filter.
 *
 * Exported because it is this webview's identity for *every* cross-window
 * announcement, not just this one — `src/lib/reminder-events.ts` filters its
 * own broadcasts out the same way, and two windows agreeing about who they
 * are matters more than either module owning an id.
 */
export const WEBVIEW_ID = crypto.randomUUID();

/** Tells the other windows that something they may be showing has changed. */
export function announceDataChanged(scope: DataScope): void {
  const payload: DataChangedPayload = { scope, source: WEBVIEW_ID };

  void emit(DATA_CHANGED_EVENT, payload).catch((cause) => {
    console.error("Could not tell the other windows about a change:", cause);
  });
}

/**
 * Subscribes to changes made in *other* windows. Returns the unsubscribe
 * function, so it can be returned straight out of a `useEffect`.
 */
export async function onDataChanged(
  handler: (scope: DataScope) => void,
): Promise<UnlistenFn> {
  return listen<DataChangedPayload>(DATA_CHANGED_EVENT, (event) => {
    if (event.payload.source === WEBVIEW_ID) return;
    handler(event.payload.scope);
  });
}
