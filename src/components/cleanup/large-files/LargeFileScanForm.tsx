import { FolderOpen, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { THRESHOLD_CHOICES_MB } from "@/services/largeFileService";
import { formatThreshold } from "@/types/large-files";

/**
 * The first box of section 67's sequence: choose where to look and what
 * counts as big, then scan.
 *
 * Two decisions and one button, and the button is the only thing in the
 * feature that starts anything. There is no default folder and no scan on
 * mount — a tool that reads the user's disk should do it because they asked,
 * and "which folder" is a question only they can answer. The last folder is
 * remembered so that answering it a second time is one click, not a hunt.
 *
 * The folder comes from the OS picker rather than a text field, so it cannot
 * be mistyped and the app never has to guess at a path.
 */
function LargeFileScanForm({
  root,
  thresholdMb,
  isScanning,
  onChooseRoot,
  onThresholdChange,
  onScan,
}: {
  /** The folder the next scan would use, or `null` if none is chosen yet. */
  root: string | null;
  thresholdMb: number;
  isScanning: boolean;
  onChooseRoot: () => void;
  onThresholdChange: (thresholdMb: number) => void;
  onScan: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-col gap-2">
        <Label className="text-xs text-muted-foreground">Folder to search</Label>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={isScanning} onClick={onChooseRoot}>
            <FolderOpen />
            {root === null ? "Choose a folder…" : "Change folder…"}
          </Button>
          <p
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={root ?? undefined}
          >
            {root ?? "No folder chosen yet"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="large-file-threshold" className="text-xs text-muted-foreground">
            Show files bigger than
          </Label>
          <Select
            value={String(thresholdMb)}
            disabled={isScanning}
            onValueChange={(value) => onThresholdChange(Number(value))}
          >
            <SelectTrigger id="large-file-threshold" size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THRESHOLD_CHOICES_MB.map((mb) => (
                <SelectItem key={mb} value={String(mb)}>
                  {formatThreshold(mb)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button size="sm" disabled={root === null || isScanning} onClick={onScan}>
          {isScanning ? <Loader2 className="animate-spin" /> : <Search />}
          {isScanning ? "Searching…" : "Search folder"}
        </Button>
      </div>
    </div>
  );
}

export default LargeFileScanForm;
