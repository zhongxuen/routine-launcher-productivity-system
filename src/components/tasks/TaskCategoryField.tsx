import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { nextCategoryColor } from "@/lib/category-colors";
import { cn } from "@/lib/utils";
import { useTaskStore } from "@/stores/taskStore";

import CategoryDot from "./CategoryDot";

/** The select's value for "no category" — Select cannot hold "". */
export const NO_CATEGORY = "none";

/** The foot-of-list item that makes a category rather than picking one. */
const NEW_CATEGORY = "new";

/** A stored `category_id` as the select's value. */
export const categoryFieldValue = (categoryId: number | null): string =>
  categoryId === null ? NO_CATEGORY : String(categoryId);

/** The select's value back as a `category_id` for the wire. */
export const categoryIdFromField = (value: string): number | null =>
  value === NO_CATEGORY ? null : Number(value);

interface TaskCategoryFieldProps {
  /** Prefixed onto the control's id so two forms can be open at once. */
  idPrefix: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * The "Category" field on the task forms (section 13), with "New category…"
 * at the foot of the list: name it, press Enter, and the task is in it.
 *
 * The name is asked for in a popover anchored to the select rather than in
 * the select itself — a select's list cannot hold a text box — and the
 * popover is what makes Escape safe: it is the top layer, so Escape closes it
 * and leaves the task form open underneath.
 *
 * Categories are read from the task store. A view read fills them in, but
 * Ctrl+N opens quick-add on pages that never read a view — Settings, Cleanup
 * — so an empty list is asked for again here. Once read, the store is kept
 * current by `loadCategories` after every category change.
 */
function TaskCategoryField({ idPrefix, value, onChange, className }: TaskCategoryFieldProps) {
  const categories = useTaskStore((state) => state.categories);
  const loadCategories = useTaskStore((state) => state.loadCategories);
  const createCategory = useTaskStore((state) => state.createCategory);
  const id = `${idPrefix}-category`;

  useEffect(() => {
    if (useTaskStore.getState().categories.length === 0) void loadCategories();
  }, [loadCategories]);

  const [isNaming, setIsNaming] = useState(false);
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * Set when "New category…" is picked, and read once the select has closed.
   * A ref rather than state because it is read by the select's close handler,
   * which belongs to the render before the pick.
   */
  const wantsNewCategory = useRef(false);

  function handleValueChange(next: string) {
    // Picking the item never becomes the field's value — the select keeps
    // showing the old one until a category actually exists to show instead.
    if (next === NEW_CATEGORY) wantsNewCategory.current = true;
    else onChange(next);
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || isCreating) return;

    // Typing the name of a category that is already there means that
    // category: select it rather than refuse, or make a near-twin of it.
    const existing = categories.find(
      (category) => category.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) {
      onChange(String(existing.id));
      setIsNaming(false);
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const created = await createCategory({
        name: trimmed,
        color: nextCategoryColor(categories),
      });
      onChange(String(created.id));
      setIsNaming(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Category
      </Label>

      <Popover open={isNaming} onOpenChange={setIsNaming}>
        <Select value={value} onValueChange={handleValueChange}>
          <PopoverAnchor asChild>
            <SelectTrigger ref={triggerRef} id={id} className="w-full">
              <SelectValue />
            </SelectTrigger>
          </PopoverAnchor>
          <SelectContent
            onCloseAutoFocus={(event) => {
              if (!wantsNewCategory.current) return;
              wantsNewCategory.current = false;

              // The popover opens only now, once the list is gone. Opened any
              // earlier, it would lose focus to the trigger the closing select
              // hands it back to — and a popover that loses focus closes.
              event.preventDefault();
              setName("");
              setError(null);
              setIsNaming(true);
            }}
          >
            <SelectItem value={NO_CATEGORY}>None</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.id} value={String(category.id)}>
                <CategoryDot color={category.color} />
                {category.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={NEW_CATEGORY} className="text-muted-foreground">
              <Plus className="size-3.5" />
              New category…
            </SelectItem>
          </SelectContent>
        </Select>

        <PopoverContent
          align="start"
          className="flex w-(--radix-popover-trigger-width) min-w-56 flex-col gap-2 p-3"
          onCloseAutoFocus={(event) => {
            // There is no popover trigger to return to; the select is where
            // the user was.
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <Label htmlFor={`${id}-new`} className="text-xs text-muted-foreground">
            New category
          </Label>
          <div className="flex gap-2">
            <Input
              id={`${id}-new`}
              value={name}
              placeholder="Name"
              autoComplete="off"
              disabled={isCreating}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // Not a <form>: this one is portalled out of the task form's
                // DOM but not out of its React tree, so a submit here would
                // bubble up and save the task as well.
                if (event.key !== "Enter") return;
                event.preventDefault();
                void handleCreate();
              }}
            />
            <Button
              type="button"
              size="sm"
              className="h-9"
              disabled={!name.trim() || isCreating}
              onClick={() => void handleCreate()}
            >
              {isCreating ? "Adding…" : "Add"}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default TaskCategoryField;
