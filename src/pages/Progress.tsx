import { Outlet } from "react-router-dom";

import ProgressLevel from "../components/progress/ProgressLevel";
import SubNav from "../components/common/SubNav";

const SUB_NAV_ITEMS = [
  { to: "/progress/statistics", label: "Statistics" },
  { to: "/progress/achievements", label: "Achievements" },
  { to: "/progress/streak", label: "Streak" },
  // Section 37: kept last and named as usage, apart from the three views of
  // progress, because usage time is not productivity time.
  { to: "/progress/app-usage", label: "App usage" },
];

/**
 * The Progress section (development-plan.md section 64).
 *
 * Layout only, with one exception: section 45's level bar sits here, above
 * the sub-nav, rather than inside one of the three tabs. Statistics,
 * Achievements and Streak are three views of the same progression, so the
 * level belongs to the section rather than to any one of them — and a
 * headline that vanished when the user changed tab would make the three read
 * as unrelated pages.
 *
 * Everything below the sub-nav owns its own data. `ProgressLevel` does too,
 * which is why this page fetches nothing. The page itself is left full-width
 * like the other section layouts — the achievements grid wants the room — so
 * the level card is the one thing here that carries its own cap.
 */
function Progress() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Progress</h1>
      <ProgressLevel className="max-w-2xl" />
      <SubNav items={SUB_NAV_ITEMS} label="Progress views" />
      <Outlet />
    </div>
  );
}

export default Progress;
