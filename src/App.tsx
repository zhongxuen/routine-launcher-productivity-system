import { createHashRouter, RouterProvider } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { routes } from "./routes";

const router = createHashRouter(routes);

function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

export default App;
