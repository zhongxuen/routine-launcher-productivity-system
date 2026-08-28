import { Outlet } from "react-router-dom";
import SubNav from "../components/common/SubNav";

const SUB_NAV_ITEMS = [
  { to: "/progress/statistics", label: "Statistics" },
  { to: "/progress/achievements", label: "Achievements" },
  { to: "/progress/streak", label: "Streak" },
];

function Progress() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Progress</h1>
      <SubNav items={SUB_NAV_ITEMS} />
      <Outlet />
    </div>
  );
}

export default Progress;
