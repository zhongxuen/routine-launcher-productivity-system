import type { ReactNode } from "react";
import { Contrast, Pin, PinOff, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The stops section 83's "Opacity" moves between.
 *
 * A stepped control rather than a slider because there is nowhere to put a
 * slider: this row is three buttons wide inside a 300px window, and a control
 * you have to aim at is the wrong one to reach for on a widget you are trying
 * to fade *out* of the way. Five stops is enough to be useful and few enough
 * that clicking through them is quicker than dragging would have been. The
 * floor matches `MIN_OPACITY` in `services/widget.rs`; anything fainter is a
 * window whose only controls are inside itself.
 */
export const OPACITY_STOPS = [1, 0.85, 0.7, 0.55, 0.4] as const;

/** The stop after `current`, wrapping back to fully opaque at the bottom. */
export function nextOpacity(current: number): number {
  // The nearest stop rather than an exact match: the stored value may have
  // been clamped, or written by the Settings page's own control, and a
  // control that did nothing because 0.41 is not on the list would read as
  // broken.
  const nearest = OPACITY_STOPS.reduce((best, stop) =>
    Math.abs(stop - current) < Math.abs(best - current) ? stop : best,
  );

  const index = OPACITY_STOPS.indexOf(nearest);
  return OPACITY_STOPS[(index + 1) % OPACITY_STOPS.length];
}

interface WidgetChromeProps {
  pinned: boolean;
  opacity: number;
  onTogglePin: () => void;
  onCycleOpacity: () => void;
  onHide: () => void;
}

/**
 * Three of section 83's five controls: pin, opacity and hide.
 *
 * The other two are gestures rather than buttons — the whole body moves the
 * widget and the corner resizes it — which is why this row is as small as it
 * is. A widget is mostly content; its chrome should be the part you stop
 * noticing.
 *
 * Everything here carries `data-widget-no-drag`, which is what keeps a click
 * on a button from also starting a window drag. See `WidgetWindow`.
 */
function WidgetChrome({
  pinned,
  opacity,
  onTogglePin,
  onCycleOpacity,
  onHide,
}: WidgetChromeProps) {
  const percentage = Math.round(opacity * 100);

  return (
    <div
      data-widget-no-drag
      className={cn(
        "flex items-center gap-0.5",
        // Present but quiet until the pointer is on the widget, so what the
        // user reads is today's tasks rather than three icons.
        "opacity-40 transition-opacity duration-150",
        "group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      <ChromeButton
        label={`Opacity ${percentage}% — click to fade`}
        onClick={onCycleOpacity}
      >
        <Contrast className="size-3.5" />
      </ChromeButton>

      <ChromeButton
        label={pinned ? "Pinned in front — click to unpin" : "Not pinned — click to pin in front"}
        pressed={pinned}
        onClick={onTogglePin}
      >
        {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
      </ChromeButton>

      <ChromeButton label="Hide the widget (the app keeps running)" onClick={onHide}>
        <X className="size-3.5" />
      </ChromeButton>
    </div>
  );
}

interface ChromeButtonProps {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function ChromeButton({ label, pressed, onClick, children }: ChromeButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex size-6 items-center justify-center rounded-md transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        pressed ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

export default WidgetChrome;
