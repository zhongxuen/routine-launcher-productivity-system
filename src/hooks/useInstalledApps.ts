/**
 * The installed-programs catalogue, loaded once for however many rows ask for
 * it.
 *
 * A routine builder shows one application picker per action, and every one of
 * them wants the same list. The promise is held at module scope so they share
 * a single `invoke` — the backend caches the scan too, but the round trip and
 * the re-render are worth avoiding six times over.
 *
 * Failure is not surfaced. The list is an aid: the target field works without
 * it exactly as it did before, so a picker that came up empty should quietly
 * be a text field rather than an error next to a form the user can still
 * complete.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { listInstalledApps } from "@/services/installedAppService";
import type { InstalledApp } from "@/types/installed-app";

let pending: Promise<InstalledApp[]> | null = null;

function catalogue(refresh: boolean): Promise<InstalledApp[]> {
  if (refresh || !pending) {
    pending = listInstalledApps(refresh).catch(() => []);
  }
  return pending;
}

export interface InstalledAppsState {
  apps: InstalledApp[];
  isLoading: boolean;
  /** Rescans — for after the user has installed something. */
  refresh: () => void;
}

export function useInstalledApps(): InstalledAppsState {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const load = useCallback((refresh: boolean) => {
    setIsLoading(true);
    void catalogue(refresh).then((loaded) => {
      if (!isMounted.current) return;
      setApps(loaded);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => load(false), [load]);

  return { apps, isLoading, refresh: () => load(true) };
}
