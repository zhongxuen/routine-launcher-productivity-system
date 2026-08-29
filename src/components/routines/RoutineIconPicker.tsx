import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import RoutineIcon from "./RoutineIcon";

/** A starting set covering the kinds of routine people actually build. */
const SUGGESTED_ICONS = [
  "🚀", "💻", "📚", "🎯", "🎨", "🧠",
  "🌙", "☀️", "🏃", "🎧", "📝", "🔧",
  "⚡", "🔥", "🌱", "🧭", "📊", "🛠️",
  "🎬", "🧪", "☕", "🗂️", "🏁", "🌊",
];

interface RoutineIconPickerProps {
  value: string | null;
  onChange: (icon: string | null) => void;
  /** Prefix for the ids this control generates. */
  idPrefix: string;
}

/**
 * Section 31's `Icon: [ 🚀 ]` field.
 *
 * The tile is the control: clicking it opens a grid of suggestions plus a
 * free-text box, so a routine can carry any emoji rather than only the ones
 * listed here. Emoji rather than a bundled icon set because the icon is
 * personal shorthand, not part of the design system.
 */
function RoutineIconPicker({ value, onChange, idPrefix }: RoutineIconPickerProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">Icon</Label>

      <Popover>
        <PopoverTrigger
          className="w-fit cursor-pointer rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="Choose an icon"
        >
          <RoutineIcon icon={value} className="size-9 hover:bg-accent" />
        </PopoverTrigger>

        <PopoverContent align="start" className="w-64">
          <div className="grid grid-cols-6 gap-1">
            {SUGGESTED_ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                onClick={() => onChange(icon)}
                aria-label={`Use ${icon}`}
                className={cn(
                  "flex size-9 cursor-pointer items-center justify-center rounded-md text-lg hover:bg-accent",
                  value === icon && "bg-accent ring-1 ring-ring",
                )}
              >
                {icon}
              </button>
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-icon`} className="text-xs text-muted-foreground">
              Or paste any emoji
            </Label>
            <Input
              id={`${idPrefix}-icon`}
              value={value ?? ""}
              onChange={(event) => onChange(event.target.value.trim() || null)}
              placeholder="🚀"
              className="h-8"
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default RoutineIconPicker;
