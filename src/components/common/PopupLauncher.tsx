import { useEffect, useState } from "react";
import { PictureInPicture2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { isPopupWindowOpen, openPopupWindow } from "@/services/popupService";

/**
 * How the popup gets opened until Stage 8 has a tray icon and a global
 * shortcut to summon it (development-plan.md sections 27-28).
 *
 * Section 25's window is meant to be reached from outside the app, which is
 * exactly what does not exist yet — so without this the feature would be
 * finished and unreachable. It sits in the sidebar because that is the only
 * chrome every page shares, and it is deliberately plain: this is scaffolding
 * for one stage, not a piece of navigation. Stage 8 can leave it or drop it.
 *
 * The state it tracks is only what it can know. Whether the popup is open is
 * a fact about another window, and the popup can be dismissed from its own
 * title bar without telling anyone, so it is re-checked when this window is
 * focused rather than remembered. Opening an already-open popup just brings
 * it forward, so a stale "Open" is harmless either way.
 */
function PopupLauncher() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const check = () => {
      void isPopupWindowOpen()
        .then(setIsOpen)
        .catch(() => setIsOpen(false));
    };

    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  async function handleClick() {
    try {
      await openPopupWindow();
      setIsOpen(true);
    } catch (cause) {
      console.error("Could not open the popup window:", cause);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      title="A small always-on-top window with today's tasks and one-click routine launch"
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
        "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <PictureInPicture2 className="size-4" />
      Popup
      {isOpen && (
        <span
          className="ml-auto size-1.5 rounded-full bg-status-completed"
          aria-label="Open"
        />
      )}
    </button>
  );
}

export default PopupLauncher;
