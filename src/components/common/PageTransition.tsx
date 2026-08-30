import { useLocation } from "react-router-dom";

/**
 * The fade-and-lift a routed page arrives with (development-plan.md section
 * 84).
 *
 * Wraps the shell's `<Outlet />`. The `key` is the whole mechanism: React
 * tears down the subtree and builds a new one whenever the path changes,
 * which restarts the CSS animation on the new page's first frame. No state,
 * no timers, and no transition library — the animation is a compositor job
 * that the main thread never hears about, which matters because arriving at a
 * page is also when that page fires off its SQLite reads.
 *
 * # Enter only, and only 180ms of it
 *
 * There is no exit half. Animating the outgoing page out would mean holding
 * both on screen at once and either overlapping them — two scroll positions
 * fighting over one column — or making every navigation wait out a fade
 * before the new page starts loading. Section 84 asks for polish, and a
 * sidebar click that visibly hesitates is the opposite of it. The incoming
 * page covering the outgoing one instantly is what a fast native app does.
 *
 * # Why the path and not the full location
 *
 * `key` is `pathname` alone. The search string and the location key change
 * for things that are not navigations — most of all `revealTask`, which
 * section 24's Start Task uses to point at a row in a list that is already on
 * screen. Keying on those would remount the list under the row being revealed
 * and scroll away from the thing it was pointing at.
 *
 * Nested routes fall out of this for free: `/tasks/today` → `/tasks/upcoming`
 * changes the pathname, so the sub-view animates while the Tasks header and
 * its sub-nav sit still, which is the right reading of what moved.
 */
function PageTransition({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div key={pathname} className="animate-page-enter reduce-motion:animate-none">
      {children}
    </div>
  );
}

export default PageTransition;
