import { Outlet } from "react-router-dom";
import SubNav from "../components/common/SubNav";

const SUB_NAV_ITEMS = [
  { to: "/routines/my-routines", label: "My Routines" },
  { to: "/routines/create", label: "Create Routine" },
  { to: "/routines/templates", label: "Templates" },
];

function Routines() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Routines</h1>
      <SubNav items={SUB_NAV_ITEMS} />
      <Outlet />
    </div>
  );
}

export default Routines;
