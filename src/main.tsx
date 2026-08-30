import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import AppErrorBoundary from "./components/common/AppErrorBoundary";
import { installCrashLogging } from "./lib/crash-log";
import { initMotion } from "./stores/motionStore";
import { initTheme } from "./stores/themeStore";
import "./index.css";

// Both applied before the first render, so the window never flashes the wrong
// theme and never animates its first frame in when animations are off.
initTheme();
initMotion();

// Section 85's crash log, armed before the first render so that a component
// which throws on mount is still recorded. `AppErrorBoundary` below is what
// the user sees when one does.
installCrashLogging("main");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
