import { FolderInput, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  formatBytes,
  formatFileCount,
  fullySelectedGroups,
  selectedFiles,
  totalBytes,
} from "@/lib/duplicate-utils";
import { useDuplicateStore } from "@/stores/duplicateStore";

/**
 * The bar that appears once something is ticked (development-plan.md section
 * 67's "user selects" giving way to "confirm").
 *
 * It is deliberately the only place either destructive action is offered. Per
 * row there is no Delete, per group there is no Delete; a duplicate result is
 * a long list of near-identical names, and a destructive button repeated
 * beside every one of them is how the wrong photo gets removed.
 *
 * Neither button acts. Both open the confirmation, which is where the paths
 * are listed and the warnings are said.
 */
function DuplicateSelectionBar() {
  const scan = useDuplicateStore((state) => state.scan);
  const selected = useDuplicateStore((state) => state.selected);
  const isActing = useDuplicateStore((state) => state.isActing);
  const clearSelection = useDuplicateStore((state) => state.clearSelection);
  const requestAction = useDuplicateStore((state) => state.requestAction);

  if (scan === null || selected.size === 0) return null;

  const files = selectedFiles(scan.groups, selected);
  const emptied = fullySelectedGroups(scan.groups, selected);

  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-t-lg border border-b-0 bg-background/95 px-4 py-3 shadow-lg backdrop-blur">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm">
          {formatFileCount(files.length)} selected · {formatBytes(totalBytes(files))}
        </p>
        <p className="text-xs text-muted-subtle">
          {emptied.length > 0
            ? `Every copy in ${emptied.length === 1 ? "one group" : `${emptied.length} groups`} is selected — you will be told which before anything happens.`
            : "Nothing has changed yet. You will see exactly what is affected before it does."}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" onClick={clearSelection} disabled={isActing}>
          <X />
          Clear
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isActing}
          onClick={() => requestAction("move")}
        >
          <FolderInput />
          Move to…
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={isActing}
          onClick={() => requestAction("delete")}
        >
          <Trash2 />
          Delete…
        </Button>
      </div>
    </div>
  );
}

export default DuplicateSelectionBar;
