/**
 * Reads section 52's Daily Settings into this window, and hands the focus
 * timer its share of them.
 *
 * Mounted once per window that has a focus timer — the app shell
 * (`AppLayout`) and the widget (`WidgetContent`) — because each is a separate
 * webview with its own copy of the settings store and of the focus store.
 * `useWindowSync` re-reads the settings when another window saves them; this
 * is what makes the first read, and what carries every read on to the clock.
 *
 * The other consumers read the store directly where they draw: the quick-add
 * form's priority, the edit dialog's reminder and the quest count are each
 * one field, read by the component that uses it. The focus timer is the
 * exception because its Custom length lives in its own store, which has to
 * be told rather than asked — see `followDefaultCustomMinutes`.
 */

import { useEffect } from "react";

import { useFocusStore } from "@/stores/focusStore";
import { useSettingsStore } from "@/stores/settingsStore";

export function useDailySettings(): void {
  const defaultFocusMinutes = useSettingsStore((state) => state.daily.defaultFocusMinutes);

  useEffect(() => {
    void useSettingsStore.getState().ensureDaily();
  }, []);

  useEffect(() => {
    useFocusStore.getState().followDefaultCustomMinutes(defaultFocusMinutes);
  }, [defaultFocusMinutes]);
}
