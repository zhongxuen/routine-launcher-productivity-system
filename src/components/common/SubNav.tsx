import { NavLink } from "react-router-dom";

import { cn } from "@/lib/utils";

export interface SubNavItem {
  to: string;
  label: string;
}

interface SubNavProps {
  items: SubNavItem[];
}

/**
 * Secondary tab navigation used inside section layouts
 * (Tasks, Routines, Focus, Cleanup, Progress) to switch sub-views.
 */
function SubNav({ items }: SubNavProps) {
  return (
    <div className="flex items-center gap-1 border-b">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              isActive
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export default SubNav;
