import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { todayKey } from "@/lib/task-utils";
import { useTaskStore } from "@/stores/taskStore";

/**
 * Section 26's `+ Add Task`, reduced to the one field the widget can afford.
 *
 * The same trade the popup's quick-add makes (`PopupQuickAdd`), one size
 * smaller: a title, Enter, done. The section 16 dialog with its due date,
 * priority, routine and repeat schedule is a screen's worth of form, and a
 * widget that opened one would be a launcher for the app rather than a thing
 * you can use — which is the outcome section 26's "optional, always visible"
 * widget exists to avoid.
 *
 * The defaults are what make that safe, and they are the same two: a task
 * added under a heading that says TODAY is due today, and its priority is
 * normal. Both are what the full dialog opens on, so this is a shortcut
 * through that form rather than a second way of creating tasks.
 *
 * A disclosure rather than a permanent field. The resting state of the widget
 * is the mockup's list plus one button; the input only exists while it is
 * being typed into, because in a 260px window a text field left open is a
 * task row the list does not get to use.
 */
function WidgetQuickAdd() {
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
      // Straight to SQLite through the same store the Tasks page writes with,
      // which also announces the change — so the task is in the main window's
      // list before the user has looked back at it.
      await createTask({ title: trimmed, priority: "normal", due_date: todayKey() });
      // Kept open with the field cleared: adding tasks is the one thing
      // people do several of in a row.
      setTitle("");
      setIsSaving(false);
      inputRef.current?.focus();
    } catch (cause) {
      setIsSaving(false);
      setError(String(cause));
    }
  }

  if (!isOpen) {
    return (
      <Button
        size="xs"
        variant="ghost"
        className="w-full justify-start px-1 text-muted-foreground hover:text-foreground"
        onClick={() => setIsOpen(true)}
      >
        <Plus />
        Add Task
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          // Escape puts the form away. Without it the key would reach the
          // window, which in a small always-on-top widget is the wrong thing
          // to happen half way through typing.
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          placeholder="What needs doing?"
          aria-label="Task title"
          className="h-7 text-[0.8rem]"
        />
        <Button type="submit" size="xs" disabled={!trimmed || isSaving}>
          {isSaving ? "…" : "Add"}
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" onClick={close} aria-label="Cancel">
          ✕
        </Button>
      </div>

      {error && (
        <InlineError
          className="px-1 py-1 text-[0.65rem] leading-tight"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}
    </form>
  );
}

export default WidgetQuickAdd;
