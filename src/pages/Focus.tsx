import { Outlet } from "react-router-dom";
import SubNav from "../components/common/SubNav";

const SUB_NAV_ITEMS = [
  { to: "/focus/timer", label: "Timer" },
  { to: "/focus/history", label: "History" },
];

function Focus() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Focus</h1>
      <SubNav items={SUB_NAV_ITEMS} />
      <Outlet />
    </div>
  );
}

export default Focus;
