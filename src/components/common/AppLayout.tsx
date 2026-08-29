import { Outlet } from "react-router-dom";

import { ScrollArea } from "@/components/ui/scroll-area";
import { useFocusLifecycle } from "@/hooks/useFocusLifecycle";
import { useReminderPrompts } from "@/hooks/useReminderPrompts";
import { useWindowSync } from "@/hooks/useWindowSync";
import Sidebar from "./Sidebar";

/**
 * Persistent app shell: sidebar nav + routed content area.
 *
 * Also the mounting point for anything that has to outlive the page being
 * looked at. A focus session is the first of those: it keeps running while
 * the user is in Tasks, so the window it survives — and the closing window it
 * has to be recorded on the way out of — are the shell's business rather than
 * the timer's. See `useFocusLifecycle`.
 *
 * The second is the compact popup of section 25. It is a separate window with
 * its own copy of every store, so a task ticked off there has to reach this
 * window's list; `useWindowSync` is what hears it. Mounted here for the same
 * reason: it is about the window, not about whichever page is on screen.
 *
 * The third is section 24's reminders. A reminder arrives on the background
 * scheduler's clock, not on the user's — it can land on any page, or on none,
 * with the window minimised — and the buttons it needs are the app's to draw
 * because the OS toast cannot carry them. `useReminderPrompts` raises them,
 * and owns what Start Task does with the window it is raised in.
 */
function AppLayout() {
  useFocusLifecycle();
  useWindowSync();
  useReminderPrompts();

  return (
    <div className="flex h-full w-full overflow-hidden">
      <Sidebar />
      <ScrollArea className="flex-1">
        <main className="px-8 py-6">
          <Outlet />
        </main>
      </ScrollArea>
    </div>
  );
}

export default AppLayout;
