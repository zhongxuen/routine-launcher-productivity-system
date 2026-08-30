import { ExternalLink, FolderSearch } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatAge, formatBytes } from "@/lib/downloads-utils";
import { openDownloadsFile, revealDownloadsFile } from "@/services/downloadsService";
import type { ScannedFile } from "@/types/downloads";

/**
 * One file in the review list (development-plan.md sections 39, 67).
 *
 * The row is a checkbox and four facts — name, category, size, age — because
 * those four are what somebody actually decides on. It carries no per-row
 * Delete: a destructive action sitting one stray click away from every line
 * is precisely the shape section 67 rules out. Selecting is per row; acting
 * is on the selection, once, behind a confirmation.
 *
 * Open and Show in folder are here because deciding usually means looking
 * first, and having to leave the app to look is how a review gets abandoned
 * half done. Both only read.
 */
function DownloadsFileRow({
  file,
  isSelected,
  onToggle,
  categoryLabel,
}: {
  file: ScannedFile;
  isSelected: boolean;
  onToggle: () => void;
  categoryLabel: string;
}) {
  const checkboxId = `download-${file.path}`;

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
        aria-label={`Select ${file.name}`}
      />

      <label
        htmlFor={checkboxId}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
        title={file.path}
      >
        <span className="truncate text-sm">{file.name}</span>
        <span className="flex items-center gap-2 text-xs text-muted-subtle">
          <Badge variant="outline" className="font-normal">
            {categoryLabel}
          </Badge>
          <span>{formatAge(file.modified_at)}</span>
        </span>
      </label>

      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
        {formatBytes(file.size_bytes)}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Open ${file.name}`}
          title="Open"
          onClick={() => {
            void openDownloadsFile(file.path).catch((error: unknown) =>
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
            void revealDownloadsFile(file.path).catch((error: unknown) =>
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

export default DownloadsFileRow;
