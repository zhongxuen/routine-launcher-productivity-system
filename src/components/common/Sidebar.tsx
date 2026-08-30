import { NavLink } from "react-router-dom";
import {
  CalendarCheck,
  LayoutDashboard,
  Rocket,
  Settings as SettingsIcon,
  Sparkles,
  Timer,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import PopupLauncher from "./PopupLauncher";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/tasks", label: "Tasks", icon: CalendarCheck },
  { to: "/routines", label: "Routines", icon: Rocket },
  { to: "/focus", label: "Focus", icon: Timer },
  { to: "/cleanup", label: "Cleanup", icon: Trash2 },
  { to: "/progress", label: "Progress", icon: Sparkles },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

/**
 * Persistent top-level navigation for the app shell.
 *
 * The popup launcher below the nav is not navigation — it opens section 25's
 * separate window rather than routing anywhere — which is why it is pushed to
 * the bottom and separated from the links above it.
 *
 * `aria-label` on the landmark rather than a heading: the word above the links
 * is the *product* name, not a name for this nav, and there is a second
 * `<nav>` on most pages (`SubNav`) that a screen reader's landmark list has to
 * be able to tell this one from. The active link announces itself through
 * `NavLink`'s own `aria-current="page"`, so nothing here has to say it twice.
 *
 * **Below `lg` this becomes an icon rail** (section 84's responsive layouts).
 * 224px of navigation is a fifth of a 1200px window and a third of a 680px
 * one, and the thing it is taking that third from is the only part of the
 * screen the user came for. The breakpoint is 1024px because that is where
 * the two-column blocks on the dashboard and the Progress page give up as
 * well, so the whole shell changes shape at one width rather than at three.
 *
 * The labels are `sr-only`, not `hidden`. `display: none` would take them out
 * of the accessibility tree and leave seven links named after nothing, which
 * is the usual way an icon rail quietly undoes section 84's other half — so
 * the text is always *there*, and only stops being drawn. `title` is what
 * replaces it for a pointer, and the accessible name comes from the same
 * string in both layouts.
 */
function Sidebar() {
  return (
    <nav
      aria-label="Sections"
      className="flex w-14 shrink-0 flex-col gap-1 border-r bg-card px-2 py-6 lg:w-56 lg:px-3"
    >
      {/* The full name at full width, its initials on the rail — where three
          characters still say which app this is, and the window's own title
          bar is saying the rest. */}
      <div className="pb-5 text-center text-sm font-semibold tracking-tight lg:px-3 lg:text-left">
        <span className="lg:hidden" aria-hidden>
          RL
        </span>
        <span className="hidden lg:inline">Routine Launcher</span>
      </div>

      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          title={label}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 rounded-md py-2 text-sm transition-colors",
              // Centred on the rail, where there is no label for the icon to
              // sit to the left of.
              "justify-center px-0 lg:justify-start lg:px-3",
              // Inset, because a link this wide sits hard against the sidebar's
              // right edge and an offset ring would be clipped by it.
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )
          }
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="sr-only lg:not-sr-only">{label}</span>
        </NavLink>
      ))}

      <div className="mt-auto border-t pt-3">
        <PopupLauncher />
      </div>
    </nav>
  );
}

export default Sidebar;
