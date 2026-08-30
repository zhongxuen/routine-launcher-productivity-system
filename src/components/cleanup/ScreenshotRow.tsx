import { ExternalLink, FolderSearch } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatBytes, formatCapturedAt } from "@/lib/screenshot-utils";
import { openScreenshot, revealScreenshot } from "@/services/screenshotService";
import type { Screenshot } from "@/types/screenshot";

/**
 * One screenshot in the review list (development-plan.md sections 42, 67).
 *
 * A checkbox and four facts — name, where it came from, when it was taken,
 * how big it is. No per-row action that files or removes anything: an action
 * sitting one stray click away from every line is precisely the shape section
 * 67 rules out. Selecting is per row; moving is on the selection, once,
 * behind a confirmation.
 *
 * Open and Show in folder are here because a screenshot is a *picture*, and
 * `Screenshot 2026-08-14 093122.png` says almost nothing about which picture.
 * Deciding usually means looking, and having to leave the app to look is how
 * a review gets abandoned half done. Both only read.
 */
function ScreenshotRow({
  screenshot,
  isSelected,
  onToggle,
}: {
  screenshot: Screenshot;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const checkboxId = `screenshot-${screenshot.path}`;

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
        aria-label={`Select ${screenshot.name}`}
      />

      <label
        htmlFor={checkboxId}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
        title={screenshot.path}
      >
        <span className="truncate text-sm">{screenshot.name}</span>
        <span className="flex items-center gap-2 text-xs text-muted-subtle">
          <Badge variant="outline" className="font-normal">
            {screenshot.source}
          </Badge>
          <span>{formatCapturedAt(screenshot.modifiedEpoch)}</span>
          {screenshot.matchedBy === "location" && (
            <span
              className="hidden sm:inline"
              title="Matched because of the folder it is in, not its name"
            >
              · by folder
            </span>
          )}
        </span>
      </label>

      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
        {formatBytes(screenshot.bytes)}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Open ${screenshot.name}`}
          title="Open"
          onClick={() => {
            void openScreenshot(screenshot.path).catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error)),
            );
          }}
        >
          <ExternalLink />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Show ${screenshot.name} in the file manager`}
          title="Show in folder"
          onClick={() => {
            void revealScreenshot(screenshot.path).catch((error: unknown) =>
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

export default ScreenshotRow;
