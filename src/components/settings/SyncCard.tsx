import { useCallback, useEffect, useState } from "react";
import { CloudDownload, CloudUpload, FolderSync, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { parseTimestamp } from "@/lib/task-utils";
import { reloadAfterRestore } from "@/services/backupService";
import {
  configureSync,
  getSyncStatus,
  pickSyncFolder,
  syncPull,
  syncPush,
} from "@/services/tier5Service";
import type { SyncState, SyncStatus } from "@/types/tier5";

function when(timestamp: string | null | undefined): string {
  const date = parseTimestamp(timestamp ?? null);
  return date
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "never";
}

/** One sentence for each state, naming the other device where it matters. */
function describe(status: SyncStatus): string {
  const other = status.remote && !status.remote.isThisDevice ? status.remote.deviceName : "another computer";
  const messages: Record<SyncState, string> = {
    not_configured: "Not syncing. Choose a folder to start.",
    unavailable: status.message ?? "The sync folder is not available right now.",
    empty: "The folder is empty. Push to put this computer's data in it.",
    up_to_date: `Up to date. Last synced ${when(status.lastSyncedAt)}.`,
    local_changes: "This computer has changes the folder does not have yet.",
    remote_changes: `Newer data from ${other}, saved ${when(status.remote?.writtenAt)}.`,
    conflict: `Both this computer and ${other} changed since the last sync. Choose which to keep.`,
    first_sync: `The folder already holds data from ${other}. Choose whether to use it or replace it with this computer's.`,
    remote_too_new: `The folder was written by a newer version of Routine Launcher on ${other}. Update this computer first.`,
  };
  return messages[status.state];
}

/**
 * Settings › Sync — development-plan.md section 92's cloud and cross-device
 * synchronization, kept inside sections 56 and 68's no-account, no-backend
 * promise by syncing through a folder the user already syncs (OneDrive,
 * Dropbox, a network share). See `src-tauri/src/services/sync.rs`.
 *
 * A snapshot, not a merge: Push writes this computer's data to the folder,
 * Pull replaces this computer's data with the folder's. The card always says
 * which side changed, and a pull that would discard changes here asks first —
 * the same "show, then confirm" as Import in the Data card, which a pull
 * resembles. A pull also saves a safety copy of this computer's data first.
 */
function SyncCard() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"pull" | "push" | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getSyncStatus();
      setStatus(next);
      setDeviceName(next.deviceName);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<SyncStatus>, success?: string) {
    setIsBusy(true);
    try {
      const next = await action();
      setStatus(next);
      setDeviceName(next.deviceName);
      setError(null);
      if (success) toast.success(success);
      return next;
    } catch (cause) {
      setError(String(cause));
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  async function chooseFolder() {
    const folder = await pickSyncFolder();
    if (!folder) return;
    await run(() => configureSync(folder, deviceName, status?.autoSync ?? true), "Sync folder chosen");
  }

  async function pull(overwrite: boolean) {
    setConfirm(null);
    const next = await run(() => syncPull(overwrite));
    if (next) {
      toast.success("Data pulled from the sync folder", { description: "Reloading…" });
      reloadAfterRestore();
    }
  }

  if (!status) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Sync</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? <InlineError message={error} onRetry={() => void load()} /> : <Skeleton className="h-16" />}
        </CardContent>
      </Card>
    );
  }

  const configured = status.folder !== null;
  const needsChoice = status.state === "conflict" || status.state === "first_sync";
  const canPush = configured && !["unavailable", "up_to_date"].includes(status.state);
  const canPull = configured && ["remote_changes", "conflict", "first_sync"].includes(status.state);

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Sync</CardTitle>
        <CardDescription>
          Use Routine Launcher on more than one computer by pointing each at the same folder in
          OneDrive, Dropbox, Google Drive or a network share. Your data travels in one file in that
          folder — there is no account and no Routine Launcher server. Window positions, shortcuts,
          the calendar, application usage and the command switch stay on each computer. Works
          best with one computer in use at a time.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">Folder</p>
            <p className="truncate text-sm text-muted-foreground" title={status.folder ?? undefined}>
              {status.folder ?? "None chosen"}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" disabled={isBusy} onClick={() => void chooseFolder()}>
              <FolderSync aria-hidden />
              {configured ? "Change" : "Choose folder"}
            </Button>
            {configured && (
              <Button
                variant="ghost"
                disabled={isBusy}
                onClick={() => void run(() => configureSync(null, deviceName, false), "Sync stopped")}
              >
                Stop
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="sync-device-name">This computer's name</Label>
            <Input
              id="sync-device-name"
              value={deviceName}
              maxLength={60}
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            disabled={isBusy || deviceName.trim() === status.deviceName}
            onClick={() => void run(() => configureSync(status.folder, deviceName, status.autoSync), "Name saved")}
          >
            Save
          </Button>
        </div>

        {configured && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="sync-auto">Sync automatically</Label>
              <p className="text-sm text-muted-foreground">
                Pushes changes every two minutes, and pulls at start-up when nothing here would be
                lost. Conflicts always wait for you.
              </p>
            </div>
            <Switch
              id="sync-auto"
              checked={status.autoSync}
              disabled={isBusy}
              onCheckedChange={(next) => void run(() => configureSync(status.folder, deviceName, next))}
            />
          </div>
        )}

        <Separator />

        <p className="text-sm" role="status">
          {describe(status)}
        </p>
        {error && <InlineError message={error} onDismiss={() => setError(null)} />}

        {configured && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void load()}>
              <RefreshCw aria-hidden />
              Check
            </Button>
            <Button
              size="sm"
              variant={canPush && !needsChoice ? "default" : "outline"}
              disabled={isBusy || !canPush || status.state === "remote_too_new"}
              onClick={() =>
                needsChoice || status.state === "remote_changes"
                  ? setConfirm("push")
                  : void run(() => syncPush(false), "Pushed to the sync folder")
              }
            >
              <CloudUpload aria-hidden />
              {needsChoice ? "Keep this computer's" : "Push"}
            </Button>
            <Button
              size="sm"
              variant={status.state === "remote_changes" ? "default" : "outline"}
              disabled={isBusy || !canPull}
              onClick={() => (status.state === "remote_changes" ? void pull(false) : setConfirm("pull"))}
            >
              <CloudDownload aria-hidden />
              {needsChoice ? "Use the folder's" : "Pull"}
            </Button>
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "pull" ? "Replace this computer's data?" : "Replace the folder's data?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "pull"
                ? `This computer's tasks, routines and history are replaced with the copy from ${
                    status.remote?.deviceName ?? "the folder"
                  }. A safety copy of this computer's data is saved first, in the app's data folder under sync-safety.`
                : `The folder's copy from ${
                    status.remote?.deviceName ?? "another computer"
                  } is replaced with this computer's data. Changes made there since the last sync will be lost.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                confirm === "pull"
                  ? void pull(true)
                  : void run(() => syncPush(true), "Pushed to the sync folder").then(() => setConfirm(null))
              }
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default SyncCard;
