import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  dismissWidgetWindow,
  getWidgetSettings,
  onWidgetSettingsChanged,
  onWidgetShown,
  setWidgetOpacity,
  setWidgetPinned,
  startWidgetDrag,
  type WidgetMode,
} from "@/services/widgetService";
import { refreshMotion } from "@/stores/motionStore";
import { refreshSound } from "@/stores/soundStore";
import { refreshTheme } from "@/stores/themeStore";
import WidgetChrome, { nextOpacity } from "./WidgetChrome";
import WidgetContent from "./WidgetContent";
import WidgetResizeHandle from "./WidgetResizeHandle";

/**
 * Anything a pointer-down should reach instead of dragging the window.
 *
 * Section 83 asks for the widget to move when dragged "anywhere on the body",
 * which is only tolerable if the things you can press are exempt — a checkbox
 * that moved the window instead of ticking a task would make the widget's own
 * content unusable. So the exemption is by *kind* rather than by opt-in:
 * prompt 12.2 fills this shell with real controls and gets this for free,
 * with `data-widget-no-drag` there for anything that is interactive without
 * looking it.
 */
const NO_DRAG_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='checkbox']",
  "[data-widget-no-drag]",
].join(", ");

/**
 * What the widget draws itself as until the stored settings arrive.
 *
 * `task` matches `DEFAULT_MODE` in `services/widget.rs` — section 26 leads
 * with the task widget, and it is the mode the default 300 x 260 window was
 * sized for.
 */
const FALLBACK = { pinned: true, opacity: 1, mode: "task" as WidgetMode };

/**
 * The desktop widget's window shell (development-plan.md sections 26, 83).
 *
 * The frame around whatever mode is on screen — prompt 12.2's Task, Focus,
 * Routine and Combined widgets all render inside this — and the home of the
 * five controls section 83 asks for. Two of them are gestures rather than
 * buttons:
 *
 * * **Move** is a pointer-down anywhere that is not a control, handed
 *   straight to the OS's drag loop. Nothing here tracks the pointer
 *   afterwards; the window manager moves the window and Rust hears where it
 *   ended up.
 * * **Resize** is the corner grip — see `WidgetResizeHandle`.
 *
 * The other three are in `WidgetChrome`, and all five are stored by Rust, so
 * the widget comes back where and how it was left. What this component holds
 * is only what it has to *draw*: the pin state and the opacity. Both can also
 * be changed from the Settings page of prompt 12.3, which is a different
 * webview with its own copy of them — hence `onWidgetSettingsChanged`, the
 * same announce-and-re-read as `src/lib/window-sync.ts`.
 *
 * The opacity is painted here rather than set on the window because Tauri has
 * no cross-platform window alpha. The window is a transparent pane (see
 * `services/widget.rs` and `widget.html`) and this is the only thing on it, so
 * fading this is fading the widget.
 */
function WidgetWindow() {
  const [pinned, setPinned] = useState(FALLBACK.pinned);
  const [opacity, setOpacity] = useState(FALLBACK.opacity);
  /**
   * Which of section 26's four layouts to draw. Read rather than chosen here:
   * the picker is in Settings (prompt 12.3), which is a different webview, and
   * `onWidgetSettingsChanged` below is how this one hears about a change.
   */
  const [mode, setMode] = useState(FALLBACK.mode);

  /**
   * False for the first frame or two. The window is transparent, so a widget
   * that has not read its opacity yet is better invisible than briefly solid
   * at 100% over whatever the user was looking at.
   */
  const [loaded, setLoaded] = useState(false);

  /**
   * False once unmounted, so a slow read cannot set state afterwards.
   *
   * Set back to true on the way *in* as well as false on the way out, because
   * StrictMode mounts, unmounts and remounts in development — a ref that was
   * only ever cleared would stay cleared for the rest of the window's life,
   * and every guard below it would refuse to do anything.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    void getWidgetSettings()
      .then((settings) => {
        if (!mounted.current) return;
        setPinned(settings.pinned);
        setOpacity(settings.opacity);
        setMode(settings.mode);
      })
      .catch((cause: unknown) => {
        // The widget is still a widget without its settings; it just looks
        // like a fresh one. Refusing to render would leave a window with
        // nothing in it and no way to close it.
        console.error("Could not read the widget settings:", cause);
      })
      .finally(() => {
        if (mounted.current) setLoaded(true);
      });
  }, []);

  useEffect(() => {
    load();

    // The webview survives being hidden, so a widget put away yesterday comes
    // back holding yesterday's settings — and yesterday's theme, which may
    // have been switched in the main window meanwhile.
    const shown = onWidgetShown(() => {
      refreshTheme();
      refreshMotion();
      refreshSound();
      load();
    });

    // Pin and opacity have a second home in Settings (prompt 12.3).
    const changed = onWidgetSettingsChanged(load);

    return () => {
      void shown.then((unlisten) => unlisten());
      void changed.then((unlisten) => unlisten());
    };
  }, [load]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // Left button only: a right-click is a context menu's business, and a
    // middle-click drag is not a gesture anyone means.
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(NO_DRAG_SELECTOR)) return;

    void startWidgetDrag().catch((cause: unknown) => {
      console.error("Could not move the widget:", cause);
    });
  }

  function handleTogglePin() {
    const next = !pinned;
    setPinned(next);

    void setWidgetPinned(next).catch((cause: unknown) => {
      console.error("Could not pin the widget:", cause);
      // The window did not move to the front (or out of it), so neither
      // should the button that claims it did.
      if (mounted.current) setPinned(!next);
    });
  }

  function handleCycleOpacity() {
    const next = nextOpacity(opacity);
    setOpacity(next);

    // Rust clamps, so the answer is what to draw — not the request.
    void setWidgetOpacity(next)
      .then((stored) => {
        if (mounted.current) setOpacity(stored);
      })
      .catch((cause: unknown) => {
        console.error("Could not change the widget opacity:", cause);
        if (mounted.current) setOpacity(opacity);
      });
  }

  function handleHide() {
    void dismissWidgetWindow().catch((cause: unknown) => {
      console.error("Could not hide the widget:", cause);
    });
  }

  return (
    // The padding is not spacing, it is room for the card's shadow: the window
    // is exactly as big as this element, so a shadow drawn at its edge would
    // have nowhere to fall.
    <div className="h-full w-full p-2" onPointerDown={handlePointerDown}>
      <div
        className={cn(
          "group relative flex h-full w-full flex-col overflow-hidden rounded-xl",
          "border bg-card text-card-foreground shadow-lg",
          "transition-opacity duration-150",
        )}
        style={{ opacity: loaded ? opacity : 0 }}
      >
        {/* Over the content rather than above it. The modes name themselves
            — "TODAY", "CODING" — so a title here would be a second heading,
            and a row of its own would cost the top line of a window 260px
            tall. Floating the three buttons in the corner gives that line
            back to the mode; `WidgetHeading`'s `topmost` is what keeps the
            text from running underneath them. */}
        <div className="absolute right-2 top-2 z-10">
          <WidgetChrome
            pinned={pinned}
            opacity={opacity}
            onTogglePin={handleTogglePin}
            onCycleOpacity={handleCycleOpacity}
            onHide={handleHide}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden px-2.5 pb-2.5 pt-2">
          <WidgetContent mode={mode} />
        </div>

        <WidgetResizeHandle />
      </div>
    </div>
  );
}

export default WidgetWindow;
