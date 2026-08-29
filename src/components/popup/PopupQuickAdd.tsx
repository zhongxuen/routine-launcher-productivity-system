import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { todayKey } from "@/lib/task-utils";
import { useTaskStore } from "@/stores/taskStore";

interface PopupQuickAddProps {
  /** Told when a task lands, so the caller can clear any error it is showing. */
  onAdded?: () => void;
}

/**
 * Section 25's `[ + Add Task ]`, reduced to the one field it can afford.
 *
 * The app's real quick-add (section 16, `QuickAddTask.tsx`) is a dialog with
 * a due date, a priority, a routine and a repeat schedule. None of that fits
 * a 340px window, and forcing it in would make adding a task from the popup
 * slower than opening the app — which is the one outcome section 25 rules
 * out. So this is a title, Enter, done.
 *
 * The defaults are the ones that make that safe. A task added from a window
 * headed TODAY is due today, and its priority is normal — both are what the
 * section 16 dialog opens on anyway, so the popup is a shortcut through that
 * form rather than a different way of creating tasks. Anything else about the
 * task is set later, in the app, on a screen with room for it.
 *
 * It is a disclosure rather than a permanent field: the button is the
 * mockup's, and the input only exists while it is being typed into, so the
 * resting state of the window is the list.
 */
function PopupQuickAdd({ onAdded }: PopupQuickAddProps) {
  const createTask = useTaskStore((state) => state.createTask);

  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const trimmed = title.trim();

  function close() {
    setIsOpen(false);
    setTitle("");
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || isSaving) return;

    setIsSaving(true);
    setError(null);
    try {
      await createTask({ title: trimmed, priority: "normal", due_date: todayKey() });
      // Kept open with the field cleared: adding tasks is the one thing
      // people do several of in a row, and re-opening the form between each
      // would be the popup being tidy at the user's expense.
      setTitle("");
      setIsSaving(false);
      inputRef.current?.focus();
      onAdded?.();
    } catch (cause) {
      setIsSaving(false);
      // Shown in the form rather than as a toast: there is no Toaster in this
      // window, and the message names the thing to fix, which is right here.
      setError(String(cause));
    }
  }

  if (!isOpen) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="w-full justify-start"
        onClick={() => setIsOpen(true)}
      >
        <Plus className="size-4" />
        Add Task
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          // Escape puts the form away rather than closing the window, which is
          // what an undismissed Escape would otherwise do in a small always-on
          // -top window the user is half way through typing into.
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          placeholder="What needs doing today?"
          aria-label="Task title"
          className="h-8 text-sm"
        />
        <Button type="submit" size="sm" disabled={!trimmed || isSaving}>
          {isSaving ? "…" : "Add"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>

      {error && <p className="text-[11px] leading-tight text-priority-urgent">{error}</p>}
    </form>
  );
}

export default PopupQuickAdd;
