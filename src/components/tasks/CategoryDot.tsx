import { cn } from "@/lib/utils";

interface CategoryDotProps {
  /** The category's hex colour, or null for one that has none. */
  color: string | null;
  className?: string;
}

/**
 * A category's colour as a dot. A category with no colour gets a dashed ring
 * rather than nothing, so the names in a list still line up.
 */
function CategoryDot({ color, className }: CategoryDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        !color && "border border-dashed border-muted-foreground/60",
        className,
      )}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

export default CategoryDot;
