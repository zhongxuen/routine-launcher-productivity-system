import { Copy, EyeOff, Folder, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { describeScanStop, formatBytes, isComplete, pluralize } from "@/lib/storage-utils";
import { cn } from "@/lib/utils";
import type { SizedFolder } from "@/types/storage";

/**
 * One folder of the profile: how big it is, and the two places to go next.
 *
 * ```text
 * 📁 Downloads                                    24.1 GB
 *    12,043 files in 318 folders
 *    [ Find large files here ]  [ Find duplicates here ]
 * ```
 *
 * # The two buttons are links, not actions
 *
 * This is the only Cleanup view with no move, no delete and no confirmation
 * dialog, and these two buttons are why it still belongs under Cleanup. Each
 * one carries the folder into a tool that *does* act — the Large File Finder
 * and the Duplicate Finder — where the user picks the files and confirms
 * them there, under those tools' own guards. Nothing on this row changes
 * anything, and nothing on it is one click away from doing so.
 *
 * They appear only once a folder has been measured and only when it holds
 * something: "find the large files in this empty folder" is an offer with no
 * answer behind it.
 *
 * # A folder that is still being measured says so and keeps its place
 *
 * Sizes arrive one at a time, so a row spends its first moments with no
 * figure at all. It shows a spinner rather than a zero — a zero is an answer,
 * and it would be the wrong one — and it sits at the bottom of the list until
 * its real size arrives and moves it.
 */
function ProfileFolderRow({
  folder,
  /** The largest measured folder, which is what the bar is drawn against. */
  largestBytes,
  isMeasuring,
  onFindLargeFiles,
  onFindDuplicates,
}: {
  folder: SizedFolder;
  largestBytes: number;
  isMeasuring: boolean;
  onFindLargeFiles: () => void;
  onFindDuplicates: () => void;
}) {
  const size = folder.size;
  const complete = isComplete(folder);
  const share = size !== null && largestBytes > 0 ? (size.sizeBytes / largestBytes) * 100 : 0;
  const worthExploring = size !== null && size.sizeBytes > 0;
  const stoppedBecause = size?.stopped ? describeScanStop(size.stopped) : null;

  return (
    <li className="flex flex-col gap-2 border-b px-2 py-3 last:border-b-0">
      <div className="flex items-baseline gap-3">
        <Folder className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="truncate text-sm font-medium" title={folder.path}>
              {folder.name}
            </p>
            {folder.hidden && (
              // AppData is nearly always the biggest row here and the user has
              // very likely never seen it in Explorer. Marked quietly so its
              // presence is explained rather than alarming.
              <span
                className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                title="Windows hides this folder"
              >
                <EyeOff className="size-3" aria-hidden />
                Hidden
              </span>
            )}
          </div>

          {/* Decorative: the size beside it is the same fact in words. */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className={cn(
                "h-full rounded-full bg-primary/70 transition-all duration-500",
                size === null && "bg-transparent",
              )}
              style={{ width: `${share}%` }}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {size === null ? (
              isMeasuring ? (
                "Measuring…"
              ) : (
                "Not measured"
              )
            ) : (
              <>
                {pluralize(size.fileCount, "file")} in {pluralize(size.folderCount, "folder")}
                {size.skippedFolders > 0 && (
                  // A fact, not a warning. Locked corners of AppData are
                  // normal on every Windows machine, so this is said plainly
                  // and in the same colour as everything else on the line.
                  <> · {pluralize(size.skippedFolders, "folder")} could not be opened</>
                )}
                {stoppedBecause !== null && (
                  // Why the figure beside it says "at least". Without this the
                  // hedge would be unexplained, which reads as the app being
                  // unsure rather than as the folder being enormous.
                  <> · {stoppedBecause}</>
                )}
              </>
            )}
          </p>
        </div>

        <p className="shrink-0 text-sm font-semibold tabular-nums">
          {size === null ? (
            isMeasuring ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
            ) : (
              <span className="text-muted-foreground">—</span>
            )
          ) : (
            <>
              {!complete && <span className="font-normal text-muted-foreground">at least </span>}
              {formatBytes(size.sizeBytes)}
            </>
          )}
        </p>
      </div>

      {worthExploring && (
        <div className="flex flex-wrap gap-1 pl-6">
          <Button size="xs" variant="ghost" onClick={onFindLargeFiles}>
            <Search aria-hidden />
            Find large files here
          </Button>
          <Button size="xs" variant="ghost" onClick={onFindDuplicates}>
            <Copy aria-hidden />
            Find duplicates here
          </Button>
        </div>
      )}
    </li>
  );
}

export default ProfileFolderRow;
