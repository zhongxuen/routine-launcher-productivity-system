import { Outlet } from "react-router-dom";
import SubNav from "../components/common/SubNav";

const SUB_NAV_ITEMS = [
  { to: "/cleanup/downloads", label: "Downloads" },
  { to: "/cleanup/desktop", label: "Desktop" },
  { to: "/cleanup/duplicates", label: "Duplicates" },
  { to: "/cleanup/large-files", label: "Large Files" },
];

function Cleanup() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Cleanup</h1>
      <SubNav items={SUB_NAV_ITEMS} />
      <Outlet />
    </div>
  );
}

export default Cleanup;
