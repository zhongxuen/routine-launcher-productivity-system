import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import CategoryDot from "@/components/tasks/CategoryDot";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { CATEGORY_COLORS, nextCategoryColor } from "@/lib/category-colors";
import { listTasks } from "@/services/taskService";
import { useTaskStore } from "@/stores/taskStore";
import type { Task, TaskCategory } from "@/types/task";

/** What deleting one category would touch. */
interface CategoryUsage {
  /** Every task that names the category, whatever its status. */
  total: number;
  /** Of those, the completed and cancelled ones — which no list shows. */
  closed: number;
  /**
   * Repeating series whose latest task names it. The next day's copy is
   * cloned from that task (`ensure_recurring_instances`), so these are the
   * series whose future copies lose the category too.
   */
  series: number;
}

type Usage =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; byCategory: Map<number, CategoryUsage> };

const NO_USAGE: CategoryUsage = { total: 0, closed: 0, series: 0 };

/**
 * Counts, per category, the tasks that name it — from every task, because
 * the delete reaches every task: `tasks.category_id` is `ON DELETE SET NULL`,
 * with no filter on status or date.
 */
function usageByCategory(tasks: Task[]): Map<number, CategoryUsage> {
  const usage = new Map<number, CategoryUsage>();
  const entryFor = (id: number): CategoryUsage => {
    let entry = usage.get(id);
    if (!entry) {
      entry = { ...NO_USAGE };
      usage.set(id, entry);
    }
    return entry;
  };

  // The newest task in each series, which is what the backend clones from.
  const latestInSeries = new Map<number, Task>();

  for (const task of tasks) {
    if (task.recurrence_id !== null) {
      const latest = latestInSeries.get(task.recurrence_id);
      if (!latest || task.id > latest.id) latestInSeries.set(task.recurrence_id, task);
    }
    if (task.category_id === null) continue;

    const entry = entryFor(task.category_id);
    entry.total += 1;
    if (task.status === "completed" || task.status === "cancelled") entry.closed += 1;
  }

  for (const task of latestInSeries.values()) {
    if (task.category_id !== null) entryFor(task.category_id).series += 1;
  }

  return usage;
}

const taskCount = (count: number): string =>
  count === 0 ? "No tasks" : count === 1 ? "1 task" : `${count} tasks`;

/**
 * Task categories — development-plan.md section 13's "users can create
 * custom categories".
 *
 * The seven seeded categories are listed and edited exactly like the ones the
 * user adds: nothing in the database marks them, and nothing here does either.
 * They are simply the first seven rows.
 *
 * Every change goes through the task store, which re-reads the category list
 * after it, so the selects on the task forms have the new name as soon as it
 * is saved.
 */
function TaskCategoriesCard() {
  const categories = useTaskStore((state) => state.categories);
  const loadCategories = useTaskStore((state) => state.loadCategories);
  const createCategory = useTaskStore((state) => state.createCategory);
  const deleteCategory = useTaskStore((state) => state.deleteCategory);

  const [hasLoaded, setHasLoaded] = useState(() => useTaskStore.getState().categories.length > 0);
  const [usage, setUsage] = useState<Usage>({ status: "loading" });

  const [newName, setNewName] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<TaskCategory | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const readUsage = useCallback(async () => {
    try {
      setUsage({ status: "ready", byCategory: usageByCategory(await listTasks()) });
    } catch (cause) {
      // The counts are a courtesy on the list and a caution on the delete;
      // without them both still work, and the dialog says it could not count.
      console.error("Could not count the tasks in each category:", cause);
      setUsage({ status: "failed" });
    }
  }, []);

  useEffect(() => {
    void loadCategories().then(() => setHasLoaded(true));
    void readUsage();
  }, [loadCategories, readUsage]);

  const usageOf = (id: number): CategoryUsage | null =>
    usage.status === "ready" ? (usage.byCategory.get(id) ?? NO_USAGE) : null;

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || isAdding) return;

    setIsAdding(true);
    try {
      const created = await createCategory({
        name: trimmed,
        color: nextCategoryColor(categories),
      });
      setNewName("");
      toast.success("Category added", { description: created.name });
    } catch (cause) {
      toast.error("Could not add the category", { description: String(cause) });
    } finally {
      setIsAdding(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;

    setIsDeleting(true);
    try {
      await deleteCategory(pendingDelete.id);
      toast.success("Category deleted", { description: pendingDelete.name });
      setPendingDelete(null);
      // Those tasks count towards no category now.
      void readUsage();
    } catch (cause) {
      toast.error("Could not delete the category", { description: String(cause) });
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Task categories</CardTitle>
        <CardDescription>
          Rename, recolour, add or delete the categories tasks are sorted into. The seven you
          started with are ordinary categories — change them like any you add.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {!hasLoaded ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No categories yet. Add one below.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {categories.map((category) => (
              <CategoryRow
                key={category.id}
                category={category}
                usage={usageOf(category.id)}
                isCounting={usage.status === "loading"}
                onDelete={() => setPendingDelete(category)}
              />
            ))}
          </ul>
        )}

        <form onSubmit={(event) => void handleAdd(event)} className="flex gap-2">
          <Input
            value={newName}
            placeholder="New category"
            aria-label="New category name"
            autoComplete="off"
            disabled={isAdding}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!newName.trim() || isAdding}
            className="shrink-0"
          >
            <Plus aria-hidden="true" />
            {isAdding ? "Adding…" : "Add"}
          </Button>
        </form>
      </CardContent>

      <DeleteCategoryDialog
        category={pendingDelete}
        usage={pendingDelete ? usageOf(pendingDelete.id) : null}
        isCounting={usage.status === "loading"}
        isDeleting={isDeleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
      />
    </Card>
  );
}

interface CategoryRowProps {
  category: TaskCategory;
  /** Null while counting, or when the count could not be read. */
  usage: CategoryUsage | null;
  isCounting: boolean;
  onDelete: () => void;
}

/**
 * One category: its colour, its name — edited in place, saved on Enter or
 * when the field loses focus, abandoned on Escape — how many tasks use it,
 * and Delete.
 */
function CategoryRow({ category, usage, isCounting, onDelete }: CategoryRowProps) {
  const updateCategory = useTaskStore((state) => state.updateCategory);
  const [draft, setDraft] = useState(category.name);
  const [isSaving, setIsSaving] = useState(false);
  /** Set by Escape so the blur it causes does not save what it abandoned. */
  const isAbandoning = useRef(false);

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === category.name) {
      setDraft(category.name);
      return;
    }

    setIsSaving(true);
    try {
      const renamed = await updateCategory(category.id, { name: trimmed });
      setDraft(renamed.name);
      toast.success("Category renamed", { description: `${category.name} → ${renamed.name}` });
    } catch (cause) {
      setDraft(category.name);
      toast.error("Could not rename the category", { description: String(cause) });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <li className="flex items-center gap-2">
      <CategoryColorPicker category={category} />

      <Input
        value={draft}
        aria-label={`Name of the ${category.name} category`}
        autoComplete="off"
        disabled={isSaving}
        className="h-8 flex-1 border-transparent bg-transparent px-2 shadow-none hover:border-input dark:bg-transparent"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            isAbandoning.current = true;
            setDraft(category.name);
            event.currentTarget.blur();
          }
        }}
        onBlur={() => {
          if (isAbandoning.current) {
            isAbandoning.current = false;
            return;
          }
          void commit();
        }}
      />

      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {isCounting ? <Skeleton className="ml-auto h-3.5 w-12" /> : usage && taskCount(usage.total)}
      </span>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Delete the ${category.name} category`}
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

/** The colour swatch, opening the palette (and "No colour"). */
function CategoryColorPicker({ category }: { category: TaskCategory }) {
  const updateCategory = useTaskStore((state) => state.updateCategory);
  const [open, setOpen] = useState(false);
  const current = category.color?.toLowerCase() ?? null;

  async function choose(color: string | null) {
    setOpen(false);
    if (color === current) return;

    try {
      await updateCategory(category.id, { color });
    } catch (cause) {
      toast.error("Could not change the colour", { description: String(cause) });
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={`Colour of the ${category.name} category`}
        >
          <CategoryDot color={category.color} className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-6 gap-1">
          {CATEGORY_COLORS.map((color) => {
            const isCurrent = color.value === current;
            return (
              <button
                key={color.value}
                type="button"
                title={color.label}
                aria-label={color.label}
                aria-pressed={isCurrent}
                className="flex size-7 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void choose(color.value)}
              >
                <span
                  className="flex size-5 items-center justify-center rounded-full"
                  style={{ backgroundColor: color.value }}
                >
                  {isCurrent && <Check className="size-3.5 text-white" aria-hidden="true" />}
                </span>
              </button>
            );
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={current === null}
          className="mt-1 w-full justify-start text-muted-foreground"
          onClick={() => void choose(null)}
        >
          <CategoryDot color={null} />
          No colour
        </Button>
      </PopoverContent>
    </Popover>
  );
}

interface DeleteCategoryDialogProps {
  category: TaskCategory | null;
  usage: CategoryUsage | null;
  isCounting: boolean;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * "Delete Work?" — with what that does to the tasks in it, which is less than
 * it might sound: `delete_task_category` removes the category row and the
 * database sets `category_id` to NULL on every task that named it. No task is
 * deleted, completed or moved.
 */
function DeleteCategoryDialog({
  category,
  usage,
  isCounting,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteCategoryDialogProps) {
  return (
    <AlertDialog
      open={category !== null}
      onOpenChange={(open) => {
        if (!open && !isDeleting) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{category?.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            {isCounting ? "Counting the tasks that use it…" : deleteConsequences(usage)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isCounting || isDeleting}
            onClick={(event) => {
              // The dialog closes when the delete has landed, not on the click.
              event.preventDefault();
              onConfirm();
            }}
          >
            {isDeleting ? "Deleting…" : "Delete category"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's sentence, built from the counts. Null usage means uncounted. */
function deleteConsequences(usage: CategoryUsage | null): string {
  if (usage === null) {
    return (
      "The tasks that use it could not be counted. Any that do are kept, not deleted, and " +
      "their category is set to None."
    );
  }

  const { total, closed, series } = usage;
  if (total === 0) return "No tasks use it, so no task changes.";

  const one = total === 1;
  const closedNote =
    closed === 0
      ? ""
      : closed === total
        ? one
          ? " (it is completed or cancelled)"
          : " (all completed or cancelled)"
        : ` (${closed} of them completed or cancelled)`;

  const parts = [
    `${taskCount(total)} ${one ? "uses" : "use"} it${closedNote}.`,
    one
      ? "That task is not deleted: it is kept, and its category is set to None."
      : "Those tasks are not deleted: they are kept, and their category is set to None.",
  ];

  if (series > 0) {
    parts.push(
      series === 1
        ? one
          ? "It repeats, so its future copies will have no category either."
          : "One of them repeats, so its future copies will have no category either."
        : `${series} of them repeat, so their future copies will have no category either.`,
    );
  }

  parts.push(
    `Adding a category with the same name afterwards will not put ${one ? "it" : "them"} back.`,
  );

  return parts.join(" ");
}

export default TaskCategoriesCard;
