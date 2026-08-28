import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { initTheme } from "./stores/themeStore";
import "./index.css";

// Applied before the first render so the window never flashes the wrong theme.
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
