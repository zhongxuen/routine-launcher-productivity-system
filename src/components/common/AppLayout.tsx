import { Outlet } from "react-router-dom";

import { ScrollArea } from "@/components/ui/scroll-area";
import Sidebar from "./Sidebar";

/**
 * Persistent app shell: sidebar nav + routed content area.
 */
function AppLayout() {
  return (
    <div className="flex h-full w-full overflow-hidden">
      <Sidebar />
      <ScrollArea className="flex-1">
        <main className="px-8 py-6">
          <Outlet />
        </main>
      </ScrollArea>
    </div>
  );
}

export default AppLayout;
