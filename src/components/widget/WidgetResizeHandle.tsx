import { useCallback, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import { setWidgetSize } from "@/services/widgetService";

/**
 * Section 83's "Resize": the grip in the bottom-right corner.
 *
 * The window has no decorations, so there are no edges to grab — this is the
 * whole of it. The division of labour is the quick launcher's, one step
 * further along: the frontend knows where the pointer is and what it grabbed,
 * Rust decides what counts as a widget. So this sends the size the drag has
 * arrived at and never assumes it got it, which is why a drag past the limits
 * simply stops instead of sliding the pointer further and further from the
 * corner it is holding.
 *
 * Two details make the drag behave:
 *
 * * **Screen coordinates, not client ones.** The element being dragged is
 *   moving with the window it is resizing, so a delta measured against the
 *   window would be measured against a moving ruler.
 * * **One call in flight at a time.** A pointer move fires far more often than
 *   an `invoke` completes, and the queue that would build up is a widget still
 *   growing after the user let go. Moves that arrive while a call is out are
 *   collapsed into a single pending size — the newest one is the only one
 *   worth sending.
 */
function WidgetResizeHandle() {
  /** Where the drag started, and how big the window was then. */
  const origin = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  /** The most recent size not yet sent, and whether a call is out. */
  const pending = useRef<{ width: number; height: number } | null>(null);
  const inFlight = useRef(false);

  /**
   * False once unmounted, so a late `finally` cannot restart the loop. Set on
   * the way in too — StrictMode remounts in development, and a ref that was
   * only ever cleared would leave the handle permanently inert.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const flush = useCallback(() => {
    if (inFlight.current || !mounted.current) return;

    const next = pending.current;
    if (!next) return;

    pending.current = null;
    inFlight.current = true;

    void setWidgetSize(next.width, next.height)
      .catch((cause: unknown) => {
        console.error("Could not resize the widget:", cause);
      })
      .finally(() => {
        inFlight.current = false;
        flush();
      });
  }, []);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;

    // The pointer is captured so the drag survives leaving the handle — which
    // it does immediately, because the corner it is resizing runs away from it.
    event.currentTarget.setPointerCapture(event.pointerId);

    // `innerWidth`/`innerHeight` are the window's own size in logical pixels,
    // which is the unit Rust clamps and stores in. There is no title bar to
    // account for.
    origin.current = {
      x: event.screenX,
      y: event.screenY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const start = origin.current;
    if (!start) return;

    pending.current = {
      width: start.width + (event.screenX - start.x),
      height: start.height + (event.screenY - start.y),
    };
    flush();
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!origin.current) return;
    origin.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      // Both of these keep the corner from moving the window instead of
      // resizing it — see `WidgetWindow`'s drag handler.
      data-widget-no-drag
      onPointerDownCapture={(event) => event.stopPropagation()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role="separator"
      aria-label="Resize the widget"
      title="Drag to resize"
      className={cn(
        "absolute bottom-0 right-0 flex size-4 cursor-nwse-resize items-end justify-end",
        "text-muted-foreground/50 transition-colors hover:text-foreground",
      )}
    >
      {/* Two strokes rather than an icon: at 12px a lucide glyph is mush, and
          this is the one piece of chrome that has to read as a texture. */}
      <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true">
        <path
          d="M9 1 L1 9 M9 5 L5 9"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  );
}

export default WidgetResizeHandle;
