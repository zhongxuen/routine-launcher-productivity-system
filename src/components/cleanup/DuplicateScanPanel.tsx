import { FolderSearch, RefreshCw, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  folderName,
  formatBytes,
  formatDuration,
  formatFileCount,
  formatGroupCount,
} from "@/lib/duplicate-utils";
import { useDuplicateStore } from "@/stores/duplicateStore";

/**
 * The top of the Duplicates view: what will be scanned, and what the last scan
 * found (development-plan.md sections 38, 40).
 *
 * It is a statement and a button. There is no "clean up", no "remove the
 * copies", no recommendation of which file to lose — the app has no idea which
 * of two identical photos the user cares about, and the honest thing to print
 * is how much space the question is worth.
 *
 * Downloads and Desktop are the starting folders because prompt 10.2 says so,
 * and they are shown rather than assumed: a redirected Downloads folder or a
 * non-English Windows makes a guessed path wrong, so the real ones come back
 * from the OS and are printed here before anything is read.
 */
function DuplicateScanPanel() {
  const folders = useDuplicateStore((state) => state.folders);
  const includeSubfolders = useDuplicateStore((state) => state.includeSubfolders);
  const scan = useDuplicateStore((state) => state.scan);
  const isScanning = useDuplicateStore((state) => state.isScanning);
  const chooseFolders = useDuplicateStore((state) => state.chooseFolders);
  const resetFolders = useDuplicateStore((state) => state.resetFolders);
  const setIncludeSubfolders = useDuplicateStore((state) => state.setIncludeSubfolders);
  const runScan = useDuplicateStore((state) => state.runScan);

  return (
    <Card className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-0.5">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">DUPLICATES</p>
        <p className="text-sm text-muted-foreground">
          Files are compared by size, then by content, so a match means the
          bytes match. Nothing is ever removed on its own.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">FOLDERS</p>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => void chooseFolders()}>
              <FolderSearch />
              Choose…
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void resetFolders()}>
              <RotateCcw />
              Downloads + Desktop
            </Button>
          </div>
        </div>

        {folders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No folders chosen yet. Pick one to scan.
          </p>
        ) : (
          <ul className="flex flex-col">
            {folders.map((folder) => (
              <li
                key={folder}
                className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5 text-sm last:border-b-0"
              >
                <span className="shrink-0">{folderName(folder)}</span>
                <span
                  className="min-w-0 truncate text-xs text-muted-subtle"
                  title={folder}
                >
                  {folder}
                </span>
              </li>
            ))}
          </ul>
        )}

        <label className="flex items-center gap-2 pt-1 text-sm">
          <Switch
            checked={includeSubfolders}
            onCheckedChange={setIncludeSubfolders}
            aria-label="Include subfolders"
          />
          <span className="text-muted-foreground">Include subfolders</span>
        </label>
      </section>

      <footer className="flex flex-col gap-3 border-t border-border/60 pt-4">
        <Button
          className="w-fit"
          disabled={isScanning || folders.length === 0}
          onClick={() => void runScan()}
        >
          {scan === null ? (
            <Search />
          ) : (
            <RefreshCw className={isScanning ? "animate-spin" : undefined} />
          )}
          {isScanning ? "Scanning…" : scan === null ? "Scan for duplicates" : "Rescan"}
        </Button>

        {scan !== null && <ScanSummary />}
      </footer>
    </Card>
  );
}

/**
 * What the last scan found, in the terms the decision is made in: how many
 * groups, how many redundant copies, and how much keeping one of each frees.
 *
 * `hashedFiles` is printed because it is the honest answer to "why did that
 * take a while" — a scan reads every file that shares a size with another one,
 * and on a folder of large videos that is most of the time spent.
 */
function ScanSummary() {
  const scan = useDuplicateStore((state) => state.scan);
  if (scan === null) return null;

  const notes: string[] = [];
  if (scan.minSizeBytes > 0) {
    notes.push(`files under ${formatBytes(scan.minSizeBytes)} were not compared`);
  }
  if (scan.skipped.length > 0) {
    notes.push(
      `${scan.skipped.length} ${scan.skipped.length === 1 ? "item" : "items"} could not be read`,
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm">
        {formatGroupCount(scan.groups.length)}
        {scan.groups.length > 0 && (
          <>
            {" · "}
            {scan.duplicateFiles} redundant {scan.duplicateFiles === 1 ? "copy" : "copies"}
            {scan.reclaimableBytes > 0 && ` · ${formatBytes(scan.reclaimableBytes)} reclaimable`}
          </>
        )}
      </p>

      <p className="text-xs text-muted-subtle">
        {formatFileCount(scan.scannedFiles)} compared, {scan.hashedFiles} opened and hashed, in{" "}
        {formatDuration(scan.elapsedMs)}
        {notes.length > 0 && ` · ${notes.join(" · ")}`}.
      </p>

      {scan.truncated && (
        <p className="text-xs text-priority-urgent">
          The scan stopped at its file limit, so this is not the whole picture —
          scan a narrower folder to be sure.
        </p>
      )}
    </div>
  );
}

export default DuplicateScanPanel;
