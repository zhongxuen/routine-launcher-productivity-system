import { Plus, Rocket, Timer } from "lucide-react";

import { cn } from "@/lib/utils";

import type { LauncherItem } from "./launcher-items";

interface LauncherRowProps {
  item: LauncherItem;
  isSelected: boolean;
  /** The row's DOM id, so the search box can point `aria-activedescendant` at it. */
  id: string;
  onSelect: () => void;
  /** Called on hover, so the mouse moves the same selection the arrows do. */
  onHover: () => void;
}

/**
 * One line of section 28's list.
 *
 * A `<li role="option">` rather than a button, and never focused: the search
 * box keeps the keyboard for the whole life of the window, because a launcher
 * where Tab or an arrow key moved focus out of the field would be one you
 * could not carry on typing into. Selection therefore has to be drawn rather
 * than inherited from `:focus`, and announced through the listbox's
 * `aria-activedescendant` rather than through the focus ring.
 *
 * Hovering selects rather than highlighting separately. Two different
 * "current" rows — one under the mouse, one under the arrow keys — is the
 * thing that makes a keyboard launcher feel broken the first time someone
 * touches the trackpad mid-search.
 */
function LauncherRow({ item, isSelected, id, onSelect, onHover }: LauncherRowProps) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={isSelected}
      onMouseMove={onHover}
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm",
        isSelected ? "bg-accent text-accent-foreground" : "text-foreground",
      )}
    >
      <ItemGlyph item={item} />

      <span className="min-w-0 flex-1 truncate">{item.label}</span>

      {/* The hint is what the row will do, and it is the first thing to go
          when the name needs the space: a truncated routine name is a row the
          user cannot identify, a missing hint is only a row they have to
          recognise from its name. */}
      <span
        className={cn(
          "hidden shrink-0 truncate text-xs sm:block sm:max-w-[45%]",
          isSelected ? "text-accent-foreground/70" : "text-muted-foreground",
        )}
      >
        {item.hint}
      </span>
    </li>
  );
}

/**
 * The glyph in the mockup's left column: a routine's own emoji, or the icon
 * that stands for the action.
 *
 * Bare rather than tiled — inside a list row this dense, the glyph *is* the
 * icon, and `RoutineIcon`'s rounded square would be a second box inside the
 * highlighted one.
 */
function ItemGlyph({ item }: { item: LauncherItem }) {
  if (item.kind === "add-task") return <Plus className="size-4 shrink-0" aria-hidden />;
  if (item.kind === "start-focus") return <Timer className="size-4 shrink-0" aria-hidden />;

  return item.icon ? (
    <span aria-hidden className="w-4 shrink-0 text-center text-sm leading-none">
      {item.icon}
    </span>
  ) : (
    <Rocket className="size-4 shrink-0" aria-hidden />
  );
}

export default LauncherRow;
