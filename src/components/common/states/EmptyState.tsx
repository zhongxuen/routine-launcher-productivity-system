import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Optional glyph above the title. Omitted inside cards that already have one. */
  icon?: LucideIcon;
  /** The fact, as a sentence: "No routines yet." */
  title: string;
  /** Why it is empty, or what to do about it. */
  hint?: string;
  /** A way out — a link to the builder, a button that opens quick-add. */
  action?: React.ReactNode;
  /**
   * `compact` is the widget and the popup, where the whole state has to fit
   * on one line at 0.7rem. Same words, no padding, no icon.
   */
  size?: "default" | "compact";
  className?: string;
}

/**
 * "There is nothing here, and that is not a failure."
 *
 * One shape for every empty list in the app (development-plan.md section 84),
 * so an empty Inbox, an empty My Routines and an empty focus history all read
 * the same way and none of them can be mistaken for a screen still loading or
 * a screen that broke. See {@link ErrorState} for the one that did break.
 */
function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  size = "default",
  className,
}: EmptyStateProps) {
  if (size === "compact") {
    return (
      <p className={cn("px-1 pt-1 text-[0.7rem] leading-tight text-muted-foreground", className)}>
        {title}
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col items-center gap-2 py-14 text-center", className)}>
      {Icon && <Icon className="size-5 text-muted-foreground/50" aria-hidden />}
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{title}</p>
        {hint && <p className="max-w-md text-xs text-muted-subtle">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export default EmptyState;
export { EmptyState };
