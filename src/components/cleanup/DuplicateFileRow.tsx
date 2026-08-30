import { ExternalLink, FolderSearch, Star } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatAge, formatBytes } from "@/lib/duplicate-utils";
import { cn } from "@/lib/utils";
import { openDuplicateFile, revealDuplicateFile } from "@/services/duplicateService";
import type { DuplicateFile } from "@/types/duplicates";

/**
 * One copy inside a duplicate group (development-plan.md sections 40, 67).
 *
 * A checkbox and four facts — name, folder, age, size — because those four are
 * what somebody actually decides a copy on, and in a duplicate group the
 * folder and the age are the whole question: the same bytes in `Desktop` and
 * in `Downloads\old`, one of them from last March.
 *
 * There is no per-row Delete. A destructive action one stray click from every
 * line is exactly the shape section 67 rules out; selecting is per row, acting
 * is on the selection, once, behind a confirmation.
 *
 * Open and Show in folder are here because deciding between two copies almost
 * always means looking at one, and having to leave the app to look is how a
 * review gets abandoned half-done. Both only read.
 */
function DuplicateFileRow({
  file,
  isSelected,
  onToggle,
}: {
  file: DuplicateFile;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const checkboxId = `duplicate-${file.path}`;

  return (
    <li
      className={cn(
        "group flex items-center gap-3 rounded-md px-2 py-2 transition-colors",
        isSelected ? "bg-accent/60" : "hover:bg-accent/30",
      )}
    >
      <Checkbox
        id={checkboxId}
        checked={isSelected}
        onCheckedChange={onToggle}
        aria-label={`Select ${file.name} in ${file.folder}`}
      />

      <label
        htmlFor={checkboxId}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
        title={file.path}
      >
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm">{file.name}</span>
          {file.suggestedKeep && (
            <span
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
              title="The oldest copy, so probably the original. Only a suggestion — pick whichever you want to keep."
            >
              <Star className="size-3" />
              oldest
            </span>
          )}
        </span>
        <span className="truncate text-xs text-muted-subtle">
          {file.folder} · {formatAge(file.modifiedMs)}
        </span>
      </label>

      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
        {formatBytes(file.sizeBytes)}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Open ${file.name}`}
          title="Open"
          onClick={() => {
            void openDuplicateFile(file.path).catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error)),
            );
          }}
        >
          <ExternalLink />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Show ${file.name} in the file manager`}
          title="Show in folder"
          onClick={() => {
            void revealDuplicateFile(file.path).catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error)),
            );
          }}
        >
          <FolderSearch />
        </Button>
      </span>
    </li>
  );
}

export default DuplicateFileRow;
