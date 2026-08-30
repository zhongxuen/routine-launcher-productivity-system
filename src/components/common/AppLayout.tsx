import { Outlet } from "react-router-dom";

import OnboardingDialog from "@/components/onboarding/OnboardingDialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFocusLifecycle } from "@/hooks/useFocusLifecycle";
import { useLauncherRequests } from "@/hooks/useLauncherRequests";
import { useProgressSync } from "@/hooks/useProgressSync";
import { useReminderPrompts } from "@/hooks/useReminderPrompts";
import { useTrayActions } from "@/hooks/useTrayActions";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { useWindowSync } from "@/hooks/useWindowSync";
import PageTransition from "./PageTransition";
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
 * The fourth is section 28's quick launcher. Its `⏱ Start Focus` is the one
 * row that window cannot finish on its own — a focus session is a clock, and
 * the clock is this window's store — so it asks, and `useLauncherRequests`
 * answers here, where the request can land whatever page is on screen.
 *
 * The third is section 24's reminders. A reminder arrives on the background
 * scheduler's clock, not on the user's — it can land on any page, or on none,
 * with the window minimised — and the buttons it needs are the app's to draw
 * because the OS toast cannot carry them. `useReminderPrompts` raises them,
 * and owns what Start Task does with the window it is raised in.
 *
 * The fourth is section 27's tray menu. Its items are chosen from outside the
 * app entirely — often while this window is hidden in the tray — so the page
 * on screen when one arrives is whatever the user last left, or nothing at
 * all. `useTrayActions` navigates to wherever the action belongs and then
 * makes the same call the button for it would have made.
 *
 * The sixth is section 85's update check. It belongs to the launch in the
 * most literal sense — it runs once per run of the process, and the user it
 * exists for is the one who never opens Settings — so a page could not own it
 * even if a page wanted to. It only ever *reports*: what it finds becomes a
 * toast and a line in Settings, and installing is a button there. See
 * `useUpdateCheck`.
 *
 * The fifth is section 84's first-run walkthrough. It is a component rather
 * than a hook because it draws a dialog, but it is here for the same reason
 * as the rest: it belongs to the *launch*, not to a page. It reads the
 * first-launch flag itself on mount and stays invisible unless this is a
 * first launch or Settings has asked for it back. See `OnboardingDialog`.
 *
 * **The shell is where section 84's responsive layouts are decided.** The
 * window can be dragged down to 680x560 (`tauri.conf.json`), which is half a
 * screen on a 1366-wide laptop — the width at which somebody actually works
 * with this app beside the thing they are working on. Two of the three
 * changes that makes are here: the sidebar collapses to an icon rail (see
 * `Sidebar`) and this content column trades its outer padding for the space,
 * because at 680px the 64px of gutter this page had was a tenth of the
 * window. Everything below is a page deciding for itself how many columns it
 * has room for, at the same 1024px the shell uses.
 *
 * **Tab order starts here** (section 84). The shell is two landmarks — the
 * sidebar's `<nav>` and this `<main>` — laid out in the order the keyboard
 * walks them, so nothing has to be reordered by hand and there is not a
 * positive `tabIndex` anywhere in the app. The skip link is what makes that
 * bearable: the sidebar is eight links plus the popup button, and without a
 * way past them every visit to a page costs nine Tabs before the page itself
 * is reachable.
 */
function AppLayout() {
  useFocusLifecycle();
  useWindowSync();
  useProgressSync();
  useReminderPrompts();
  useLauncherRequests();
  useTrayActions();
  useUpdateCheck();

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Off screen until it is tabbed to, which is the only time it is of any
          use. `sr-only` alone would leave it invisible even then, so the focus
          variants put it back — the app's first focusable element, sitting
          over the sidebar it exists to skip. */}
      <a
        href="#main-content"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-3 focus-visible:top-3 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-popover focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-popover-foreground focus-visible:shadow-lg"
      >
        Skip to content
      </a>

      <Sidebar />
      <ScrollArea className="flex-1">
        {/* `tabIndex={-1}` is not for the Tab key — it is what lets the skip
            link above move focus *into* this element rather than only
            scrolling to it, which is the difference between skipping the
            sidebar and appearing to. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="px-4 py-5 focus-visible:outline-none lg:px-8 lg:py-6"
        >
          {/* Inside the scroll area rather than around it: the sidebar and the
              scrollbar are the frame, and it is the page within them that
              changes. See `PageTransition` for why it keys on the path alone. */}
          <PageTransition>
            <Outlet />
          </PageTransition>
        </main>
      </ScrollArea>

      <OnboardingDialog />
    </div>
  );
}

export default AppLayout;
