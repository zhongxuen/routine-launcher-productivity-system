import { useState } from "react";
import { ChevronDown, EyeOff, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pluralize } from "@/types/large-files";

/**
 * The Ignore action of section 41, seen from the other side.
 *
 * Ignore is the only one of the five that leaves no trace on disk, which
 * makes it the only one that could quietly become permanent: a file hidden
 * six months ago is a file the user has no way of remembering they hid. So
 * every scan that hides something says how many, and this panel is where the
 * list is read and undone.
 *
 * Collapsed by default and absent entirely when nothing is ignored — it is
 * housekeeping, not a feature, and it should not take up room in a view whose
 * subject is the files that *are* on screen.
 */
function IgnoredFilesPanel({
  ignored,
  hiddenFromThisScan,
  onUnignore,
  onClear,
}: {
  ignored: string[];
  /**
   * How many of these were over the threshold in the scan on screen. Said out
   * loud because it is the number that matters: an ignore list of forty is
   * unremarkable, forty files being kept out of the results in front of you
   * is not.
   */
  hiddenFromThisScan: number;
  onUnignore: (path: string) => void;
  onClear: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  if (ignored.length === 0) return null;

  return (
    <section className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
      >
        <EyeOff className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm">
          {pluralize(ignored.length, "ignored file")}
          {hiddenFromThisScan > 0 && (
            <span className="text-muted-foreground">
              {" "}
              · {hiddenFromThisScan} left out of these results
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && (
        <div className="flex flex-col gap-3 border-t px-4 py-3">
          <ul className="flex flex-col">
            {ignored.map((path) => (
              <li
                key={path}
                className="flex items-center gap-3 border-b py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
                  {path}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onUnignore(path)}
                  aria-label={`Stop ignoring ${path}`}
                >
                  <Undo2 />
                  Stop ignoring
                </Button>
              </li>
            ))}
          </ul>

          <Button size="xs" variant="outline" className="self-start" onClick={onClear}>
            Stop ignoring all of them
          </Button>
        </div>
      )}
    </section>
  );
}

export default IgnoredFilesPanel;
