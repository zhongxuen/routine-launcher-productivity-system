import { format } from "date-fns";
import {
  Archive,
  ExternalLink,
  EyeOff,
  FolderInput,
  Loader2,
  Lock,
  MoreHorizontal,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatBytes, type DestructiveAction, type LargeFile } from "@/types/large-files";

/**
 * One line of section 41's list: the size, the file, and the five things that
 * can be done with it.
 *
 * The size leads, as it does in the plan's mockup, because size is the only
 * reason any of these files is on screen — the eye should be able to run down
 * one column and stop.
 *
 * # Why the destructive three are behind a menu
 *
 * Open and Ignore are one click: neither can lose anything, and Ignore is the
 * answer for most of what a scan turns up ("yes, I know about that, it stays").
 * Move, Archive and Delete live under the `⋯` menu, each labelled with an
 * ellipsis because each opens a confirmation rather than doing anything. That
 * is section 67's "user selects -> confirm -> perform action" made physical:
 * there is no arrangement of clicks on this row that removes a file without
 * passing through a dialog.
 *
 * A `protected` file — Windows itself, an installed program, the page file —
 * shows the three greyed out with the reason on hover. The backend refuses
 * them anyway; disabling them here means the user finds out before they have
 * decided rather than after.
 */
function LargeFileRow({
  file,
  isBusy,
  isDisabled,
  onOpen,
  onIgnore,
  onRequestAction,
}: {
  file: LargeFile;
  /** True while this row's own action is running. */
  isBusy: boolean;
  /** True while some *other* row is busy — one action at a time. */
  isDisabled: boolean;
  onOpen: () => void;
  onIgnore: () => void;
  /** Asks for a confirmation. Never performs anything itself. */
  onRequestAction: (action: DestructiveAction) => void;
}) {
  const locked = isBusy || isDisabled;
  const modified = file.modifiedMs === null ? null : new Date(file.modifiedMs);

  const details = [
    file.relativeParent || "In this folder",
    modified ? `Changed ${format(modified, "d MMM yyyy")}` : null,
  ].filter(Boolean);

  return (
    <li
      className={cn(
        "flex items-center gap-3 border-b px-2 py-3 last:border-b-0",
        isBusy && "opacity-60",
      )}
    >
      <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums">
        {formatBytes(file.sizeBytes)}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-center gap-1.5 truncate text-sm" title={file.path}>
          <span className="truncate">{file.name}</span>
          {file.protected && (
            // Not `asChild` over the icon, which is what this was. Radix would
            // have merged the trigger onto an `<svg>` — an element the Tab key
            // does not stop at and a screen reader skips — leaving the only
            // explanation of why this row cannot be deleted available to the
            // mouse alone. A real trigger is a button: focusable, so the
            // tooltip opens on focus as well as hover, and named, so the
            // padlock is readable even with the tooltip shut.
            <Tooltip>
              <TooltipTrigger
                className="flex shrink-0 rounded-sm text-muted-foreground"
                aria-label={PROTECTED_REASON}
              >
                <Lock className="size-3" />
              </TooltipTrigger>
              <TooltipContent>{PROTECTED_REASON}</TooltipContent>
            </Tooltip>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">{details.join(" · ")}</p>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {isBusy && <Loader2 className="mr-1 size-4 animate-spin text-muted-foreground" />}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={locked}
              onClick={onOpen}
              aria-label={`Open ${file.name}`}
            >
              <ExternalLink />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open the file</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={locked}
              onClick={onIgnore}
              aria-label={`Ignore ${file.name}`}
            >
              <EyeOff />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Leave this file out of future searches</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={locked}
              aria-label={`Move, archive or delete ${file.name}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {file.protected ? PROTECTED_REASON : "You will be asked to confirm."}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={file.protected}
              onSelect={() => onRequestAction("move")}
            >
              <FolderInput />
              Move to…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={file.protected}
              onSelect={() => onRequestAction("archive")}
            >
              <Archive />
              Archive…
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={file.protected}
              onSelect={() => onRequestAction("delete")}
            >
              <Trash2 />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/**
 * Said in the tooltip and again at the top of the menu, because the two are
 * reached by different users: one hovers the padlock wondering what it means,
 * the other opens the menu wondering why everything in it is grey.
 */
const PROTECTED_REASON =
  "This file belongs to Windows or to an installed program, so it is not moved or deleted from here.";

export default LargeFileRow;
