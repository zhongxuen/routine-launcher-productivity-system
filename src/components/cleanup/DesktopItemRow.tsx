import { ExternalLink, Folder, FolderSearch, Link2, Lock } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatAge, formatBytes, formatFolderContents } from "@/lib/desktop-utils";
import { cn } from "@/lib/utils";
import { openDesktopItem, revealDesktopItem } from "@/services/desktopService";
import type { DesktopItem } from "@/types/desktop";

/**
 * One item in the review list (development-plan.md sections 38, 67, 81).
 *
 * The row is a checkbox and four facts — name, kind, size or contents, age —
 * because those four are what somebody actually decides on. It carries no
 * per-row Delete: a destructive action sitting one stray click away from every
 * line is precisely the shape section 67 rules out. Selecting is per row;
 * acting is on the selection, once, behind a confirmation.
 *
 * Two rows here have no checkbox at all, and say why in place of one:
 *
 * * **a folder**, which is listed with a count of what is inside it and is
 *   never actionable — this tool does not delete folder trees from a tick box;
 * * **anything on the public desktop**, which needs administrator rights this
 *   app does not ask for.
 *
 * Saying so on the row matters more than hiding the row would: those items
 * *are* on the user's screen, so a panel that silently omitted them would be
 * a panel that disagrees with what they are looking at.
 *
 * Open and Show in folder are here because deciding usually means looking
 * first, and having to leave the app to look is how a review gets abandoned
 * half done. Both only read, and both are offered on unactionable rows too —
 * looking at a folder is exactly how you find out whether you want to keep it.
 */
function DesktopItemRow({
  item,
  isSelected,
  onToggle,
  kindLabel,
  showSource,
}: {
  item: DesktopItem;
  isSelected: boolean;
  onToggle: () => void;
  kindLabel: string;
  showSource: boolean;
}) {
  const checkboxId = `desktop-${item.path}`;
  const isFolder = item.kind === "folder";

  return (
    <li
      className={cn(
        "group flex items-center gap-3 rounded-md px-2 py-2 transition-colors",
        isSelected ? "bg-accent/60" : "hover:bg-accent/30",
        !item.actionable && "opacity-80",
      )}
    >
      {item.actionable ? (
        <Checkbox
          id={checkboxId}
          checked={isSelected}
          onCheckedChange={onToggle}
          aria-label={`Select ${item.name}`}
        />
      ) : (
        <span
          className="flex size-4 shrink-0 items-center justify-center text-muted-subtle"
          title={
            isFolder
              ? "Folders are listed but never moved or deleted from here."
              : `On the ${item.source}, which needs administrator rights this app does not ask for.`
          }
        >
          {isFolder ? <Folder className="size-3.5" /> : <Lock className="size-3.5" />}
          <span className="sr-only">
            {isFolder
              ? `${item.name} is a folder and cannot be selected`
              : `${item.name} is on the ${item.source} and cannot be selected`}
          </span>
        </span>
      )}

      {/* A label only where there is a checkbox to point it at: a `for` that
          names nothing is a click target that silently does nothing. */}
      {item.actionable ? (
        <label
          htmlFor={checkboxId}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
          title={item.path}
        >
          <ItemFacts item={item} kindLabel={kindLabel} showSource={showSource} />
        </label>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5" title={item.path}>
          <ItemFacts item={item} kindLabel={kindLabel} showSource={showSource} />
        </div>
      )}

      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
        {isFolder ? formatFolderContents(item.item_count) : formatBytes(item.size_bytes)}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Open ${item.name}`}
          title="Open"
          onClick={() => {
            void openDesktopItem(item.path).catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error)),
            );
          }}
        >
          <ExternalLink />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Show ${item.name} in the file manager`}
          title="Show in folder"
          onClick={() => {
            void revealDesktopItem(item.path).catch((error: unknown) =>
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

/**
 * The name and the line under it, written once so the row reads the same
 * whether or not it has a checkbox to hang a `<label>` on.
 *
 * The source is only printed when there is more than one desktop to be on —
 * on a machine with no public desktop, "Desktop" on every row is a column of
 * the same word.
 */
function ItemFacts({
  item,
  kindLabel,
  showSource,
}: {
  item: DesktopItem;
  kindLabel: string;
  showSource: boolean;
}) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {item.kind === "shortcut" && (
          <Link2 className="size-3.5 shrink-0 text-muted-subtle" aria-hidden />
        )}
        <span className="truncate text-sm">{item.name}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-subtle">
        <Badge variant="outline" className="font-normal">
          {kindLabel}
        </Badge>
        <span>{formatAge(item.modified_at)}</span>
        {showSource && <span>· {item.source}</span>}
      </span>
    </>
  );
}

export default DesktopItemRow;
