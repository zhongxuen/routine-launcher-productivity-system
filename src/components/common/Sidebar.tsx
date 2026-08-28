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
 */
function Sidebar() {
  return (
    <nav className="flex w-56 shrink-0 flex-col gap-1 border-r bg-card px-3 py-6">
      <div className="px-3 pb-5 text-sm font-semibold tracking-tight">Routine Launcher</div>

      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )
          }
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export default Sidebar;
