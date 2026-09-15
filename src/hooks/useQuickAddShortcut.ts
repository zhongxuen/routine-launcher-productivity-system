/**
 * `Ctrl+N` opens quick task creation from every page of the main window
 * (development-plan.md section 16).
 *
 * It used to be bound by the Tasks page, which made it a Tasks-page shortcut:
 * on the dashboard, in Focus or in Settings it did nothing at all. It is
 * mounted from `AppLayout` now, beside the other things that belong to the
 * window rather than to the page on screen, and the dialog it opens is mounted
 * there too — so the key raises quick-add over whatever the user is looking at
 * and never takes them somewhere else to do it.
 *
 * The signal is `isQuickAddOpen` on the task store, the same flag the
 * "+ Add Task" buttons and the tray's Add Task raise. One flag, one dialog:
 * however it is asked for, it is the same form.
 *
 * Only the main window mounts this. The popup, the launcher and the widget
 * are separate webviews with their own add-task rows, and none of them has
 * the dialog this would open.
 */

import { useEffect } from "react";

import { hasOpenOverlay, isTypingTarget } from "@/lib/keyboard";
import { useTaskStore } from "@/stores/taskStore";

export function useQuickAddShortcut(): void {
  const openQuickAdd = useTaskStore((state) => state.openQuickAdd);

  // Bound on the window so it fires whatever has focus; the global-shortcut
  // variant that works while the app is in the background belongs to the
  // Tauri stage.
  //
  // The three guards below are section 84's audit of this shortcut against
  // everything the app grew after Stage 8. It does not collide with the global
  // `Ctrl+Alt+Space` — `event.altKey` rules that combination out, and in any
  // case the launcher is a separate webview where this hook is never mounted
  // — but it does reach places that did not exist when it was written:
  //
  // * **Dialogs.** Quick-add itself, the task editor, the routine launch panel
  //   of section 32, the first-run walkthrough — and a routine launch can be
  //   in flight in one of them. Opening quick-add over any of those would be a
  //   second modal on top of a modal.
  // * **Text fields.** Those dialogs are forms, and so are pages like Create
  //   Routine and Settings; the Windows convention for `Ctrl+N` inside a field
  //   is that the field keeps it.
  // * **Held keys.** `repeat` is a key someone is leaning on, not a shortcut
  //   they are pressing.
  //
  // `event.code` rather than `event.key` for the same reason
  // `lib/shortcut-accelerator.ts` records codes: a shortcut is a position on
  // the keyboard. On a layout where N sits elsewhere, `key` would move the
  // shortcut out from under the `Ctrl+N` printed on the Tasks page's button.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.code !== "KeyN" || event.repeat || event.defaultPrevented) return;
      if (hasOpenOverlay() || isTypingTarget(event.target)) return;

      event.preventDefault();
      openQuickAdd();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openQuickAdd]);
}
