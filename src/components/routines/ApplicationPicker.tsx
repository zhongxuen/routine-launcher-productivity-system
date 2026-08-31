import { useMemo, useRef, useState } from "react";
import { AppWindow, Check, ChevronsUpDown, FolderOpen, RefreshCw, Store } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import {
  installedAppFor,
  matchInstalledApps,
  opensViaShell,
  resolvedAppFor,
} from "@/lib/installed-app-utils";
import { ROUTINE_ACTION_TARGET_HINTS } from "@/lib/routine-utils";
import { pickApplicationFile } from "@/services/installedAppService";
import { cn } from "@/lib/utils";
import type { InstalledApp } from "@/types/installed-app";

interface ApplicationPickerProps {
  id: string;
  /** The stored target: a path, a Store app ID, or a name the user typed. */
  value: string;
  invalid: boolean;
  /** Labels the row this picker belongs to, for screen readers. */
  label: string;
  onChange: (target: string) => void;
}

/**
 * The target field for an `application` action: a text box that knows what is
 * installed.
 *
 * It stays a text box on purpose. A dropdown alone would be a promise the
 * catalogue cannot keep — a portable program in a folder, something installed
 * for another user, an app that came with no Start Menu entry — so anything
 * can still be typed, and the list, the Browse button and the line underneath
 * are three ways of not having to.
 *
 * What the field shows is always what will be stored. The friendly name goes
 * *under* it rather than in it, which is the difference between telling the
 * user what a path is and hiding the path from them: a routine that stops
 * working because a program moved is one they can still read and fix.
 */
function ApplicationPicker({ id, value, invalid, label, onChange }: ApplicationPickerProps) {
  const { apps, isLoading, refresh } = useInstalledApps();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Typing filters the list; an empty field offers everything, which is the
  // "just show me what I have" case the dropdown exists for.
  const matches = useMemo(() => matchInstalledApps(apps, value), [apps, value]);

  // What this target already is, and — for a name rather than a path — what
  // it would open. Only one of the two can apply.
  const chosen = installedAppFor(apps, value);
  const wouldOpen = chosen ? null : resolvedAppFor(apps, value);

  const open = (index = 0) => {
    setActiveIndex(index);
    setIsOpen(true);
  };

  const choose = (app: InstalledApp) => {
    onChange(app.target);
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const browse = async () => {
    setIsOpen(false);
    const file = await pickApplicationFile();
    if (file) onChange(file);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        open();
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => {
        const next = index + step;
        if (next < 0) return matches.length - 1;
        if (next >= matches.length) return 0;
        return next;
      });
      return;
    }

    // Enter picks the highlighted program rather than submitting the form —
    // but only while the list is open and has something in it, so a user
    // typing a path of their own can still press Enter and mean it.
    if (event.key === "Enter" && isOpen && matches[activeIndex]) {
      event.preventDefault();
      choose(matches[activeIndex]);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverAnchor asChild>
          <div ref={anchorRef} className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                id={id}
                ref={inputRef}
                value={value}
                onChange={(event) => {
                  onChange(event.target.value);
                  open();
                }}
                onFocus={() => open()}
                onKeyDown={onKeyDown}
                placeholder={ROUTINE_ACTION_TARGET_HINTS.application}
                aria-invalid={invalid}
                aria-expanded={isOpen}
                aria-controls={`${id}-list`}
                role="combobox"
                autoComplete="off"
                className="pr-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1/2 right-1 -translate-y-1/2"
                // The list is what the field is for, so opening it is a
                // click rather than a discovery: the chevron says there is
                // one before the user has typed anything.
                onClick={() => (isOpen ? setIsOpen(false) : open())}
                aria-label={`Show installed programs for ${label}`}
              >
                <ChevronsUpDown className="opacity-60" />
              </Button>
            </div>

            <Button type="button" variant="outline" onClick={browse}>
              <FolderOpen />
              Browse
            </Button>
          </div>
        </PopoverAnchor>

        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) p-1"
          // The field keeps focus while the list is open: it is a filter for
          // the list, and a list that took the caret away could not be typed
          // at.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
        >
          <ul id={`${id}-list`} role="listbox" className="max-h-64 overflow-y-auto">
            {matches.map((app, index) => (
              <li key={app.target}>
                <button
                  type="button"
                  role="option"
                  aria-selected={app.target === value}
                  // `onMouseDown` rather than `onClick`: the input is
                  // focused, and a click that blurred it first would close
                  // the list out from under the pointer.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(app);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                    index === activeIndex && "bg-accent text-accent-foreground",
                  )}
                >
                  {app.via_shell ? (
                    <Store className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <AppWindow className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{app.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {app.via_shell && app.target.startsWith("shell:")
                        ? "Installed from the Microsoft Store"
                        : app.target}
                    </span>
                  </span>
                  {app.target === value && <Check className="size-4 shrink-0" />}
                </button>
              </li>
            ))}

            {matches.length === 0 && (
              <li className="px-2 py-3 text-sm text-muted-foreground">
                {isLoading
                  ? "Looking for installed programs…"
                  : apps.length === 0
                    ? "No installed programs found. Type a name or use Browse."
                    : `Nothing installed matches "${value.trim()}". Type the full path, or use Browse.`}
              </li>
            )}
          </ul>

          <div className="flex items-center justify-between gap-2 border-t px-2 pt-1.5 pb-0.5">
            <span className="text-xs text-muted-foreground">
              {isLoading ? "Scanning…" : `${apps.length} programs found`}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={refresh}
              disabled={isLoading}
            >
              <RefreshCw className={cn(isLoading && "animate-spin")} />
              Rescan
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Which program this row will actually start. A path is unreadable
          and a bare name is a guess until something confirms it, so both are
          answered here rather than at launch, where a wrong answer costs the
          user a run of the routine. */}
      {chosen && (
        <p className="truncate text-xs text-muted-foreground">
          Opens <span className="text-foreground">{chosen.name}</span>
          {chosen.via_shell && " — a Store app, which cannot take arguments"}
        </p>
      )}
      {wouldOpen && (
        <p className="truncate text-xs text-muted-foreground">
          Matches <span className="text-foreground">{wouldOpen.name}</span>
          {opensViaShell(wouldOpen.target) ? "" : ` (${wouldOpen.target})`}
        </p>
      )}
    </div>
  );
}

export default ApplicationPicker;
