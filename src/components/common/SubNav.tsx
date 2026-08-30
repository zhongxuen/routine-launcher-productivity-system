import { NavLink } from "react-router-dom";

import { cn } from "@/lib/utils";

export interface SubNavItem {
  to: string;
  label: string;
}

interface SubNavProps {
  items: SubNavItem[];
  /**
   * Names the landmark — "Tasks views", "Cleanup views". Every page that draws
   * one of these also has the sidebar's `<nav>` on screen, and two unnamed
   * navigations in a landmark list are two identical entries.
   */
  label: string;
}

/**
 * Secondary tab navigation used inside section layouts
 * (Tasks, Routines, Focus, Cleanup, Progress) to switch sub-views.
 *
 * It scrolls sideways rather than wrapping (section 84). Five tabs and a
 * 600px content column is the case that fits; a section that grows a sixth
 * tab, or a user on a narrower window, would otherwise get a second row of
 * tabs under a border drawn for one — and a row of navigation that changes
 * height as you move between sections is worse than one that has to be
 * swiped. The links refuse to shrink so the scrolling is real rather than
 * eight squeezed words, and the scrollbar itself is hidden because a
 * horizontal bar under a tab row reads as a divider.
 *
 * Links rather than `role="tablist"`, deliberately. These change the route,
 * and the arrow-key behaviour a tablist promises would be a lie about what
 * they are — a browser's Back button takes you out of a tab panel, and here it
 * should. So the keyboard contract is the plain one: Tab to reach them, Enter
 * to follow, `aria-current="page"` (from `NavLink`) to say where you are.
 */
function SubNav({ items, label }: SubNavProps) {
  return (
    <nav
      aria-label={label}
      className="no-scrollbar flex items-center gap-1 overflow-x-auto border-b"
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            cn(
              "-mb-px shrink-0 rounded-t-sm border-b-2 px-3 py-2 text-sm transition-colors",
              // Offset inward at the bottom so the ring does not sit on top of
              // the underline that marks the current tab.
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
              isActive
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export default SubNav;
