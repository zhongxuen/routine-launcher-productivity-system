import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface WidgetHeadingProps {
  /** `TODAY`, `FOCUS`, `ROUTINES` — section 26 shouts them, so this does. */
  label: string;
  /** The `3/7` of the mockup, or anything else the line is worth carrying. */
  trailing?: ReactNode;
  /**
   * True for the line at the very top of the widget. It has to keep clear of
   * the window controls floating over that corner, and it is the document's
   * heading rather than a section's — the widget has no other title.
   */
  topmost?: boolean;
  /**
   * The full text, when the label is a name rather than a word — the focus
   * widget heads itself with the running session, and a task title has
   * nowhere to go in 300px.
   */
  title?: string;
  className?: string;
}

/**
 * The `TODAY` / `FOCUS` line the four modes name themselves with.
 *
 * Section 26's mockups draw the count hard against the right-hand edge:
 *
 * ```text
 * │ TODAY             3/7   │
 * ```
 *
 * It sits next to the word here instead, because in this window that corner
 * belongs to the pin, opacity and hide buttons of section 83 — see
 * `WidgetWindow`. Putting the count under them would mean either a heading
 * the controls cover or a second line spent on nothing, and a widget 260px
 * tall cannot afford the line. `topmost` is what reserves the room for them.
 *
 * Small, quiet and uppercase for the same reason the mockup writes it that
 * way: it is a label for what is underneath, not a title for the window. The
 * window's title is that it is a widget, and it does not need saying.
 */
function WidgetHeading({ label, trailing, topmost, title, className }: WidgetHeadingProps) {
  // Whatever the mode calls itself at the top of the window is that
  // document's heading; a widget whose outline started at h2 would be one
  // with no title at all.
  const Level = topmost ? "h1" : "h2";

  return (
    <div
      className={cn(
        "flex items-baseline gap-2",
        // Three 24px buttons and the gaps between them.
        topmost && "pr-[5.25rem]",
        className,
      )}
    >
      <Level
        title={title}
        className="min-w-0 truncate text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground"
      >
        {label}
      </Level>
      {trailing}
    </div>
  );
}

export default WidgetHeading;
