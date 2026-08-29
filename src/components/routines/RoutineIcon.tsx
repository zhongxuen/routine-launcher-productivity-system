import { cn } from "@/lib/utils";
import { DEFAULT_ROUTINE_ICON } from "@/lib/routine-utils";

interface RoutineIconProps {
  /** The routine's emoji, or null for the fallback glyph. */
  icon: string | null;
  /** Tailwind size classes for the tile. */
  className?: string;
}

/**
 * A routine's icon in its tile: the emoji from section 31's `Icon: [ 🚀 ]`,
 * or a rocket outline for a routine that has not picked one.
 */
function RoutineIcon({ icon, className }: RoutineIconProps) {
  const Fallback = DEFAULT_ROUTINE_ICON;

  return (
    <span
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-xl leading-none",
        className,
      )}
    >
      {icon ?? <Fallback className="size-5 text-muted-foreground" />}
    </span>
  );
}

export default RoutineIcon;
