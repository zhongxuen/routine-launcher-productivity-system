import { useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Globe, History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { ROUTINE_ACTION_TARGET_HINTS } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import {
  displayUrl,
  matchWebsites,
  websiteSuggestions,
  type WebsiteSuggestion,
} from "@/lib/website-suggestions";
import { useRoutineStore } from "@/stores/routineStore";

interface WebsitePickerProps {
  id: string;
  /** The stored URL, or whatever the user has typed so far. */
  value: string;
  invalid: boolean;
  /** Labels the row this picker belongs to, for screen readers. */
  label: string;
  onChange: (url: string) => void;
}

/**
 * The target field for a `url` action: a text box with suggestions — the
 * websites already in the user's routines, then popular ones.
 *
 * Like `ApplicationPicker`, it stays a text box: most addresses worth opening
 * are a specific page no list could know, so anything can still be typed, and
 * choosing a suggestion just fills the field with its full address.
 */
function WebsitePicker({ id, value, invalid, label, onChange }: WebsitePickerProps) {
  const routines = useRoutineStore((state) => state.routines);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(
    () =>
      websiteSuggestions(
        routines.flatMap((routine) =>
          routine.actions.filter((action) => action.type === "url").map((action) => action.target),
        ),
      ),
    [routines],
  );
  const matches = useMemo(() => matchWebsites(suggestions, value), [suggestions, value]);

  const open = (index = 0) => {
    setActiveIndex(index);
    setIsOpen(true);
  };

  const choose = (suggestion: WebsiteSuggestion) => {
    onChange(suggestion.url);
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const isChosen = (suggestion: WebsiteSuggestion) =>
    displayUrl(suggestion.url).toLowerCase() === displayUrl(value).toLowerCase();

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

    // Enter picks the highlighted site only while the list is open and has
    // something in it, so a typed address of the user's own still means it.
    if (event.key === "Enter" && isOpen && matches[activeIndex]) {
      event.preventDefault();
      choose(matches[activeIndex]);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative min-w-0">
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
            placeholder={ROUTINE_ACTION_TARGET_HINTS.url}
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
            onClick={() => (isOpen ? setIsOpen(false) : open())}
            aria-label={`Show suggested websites for ${label}`}
          >
            <ChevronsUpDown className="opacity-60" />
          </Button>
        </div>
      </PopoverAnchor>

      {/* An address nothing suggests is still a perfectly good answer, so an
          empty match list closes rather than saying "nothing found". */}
      {matches.length > 0 && (
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) p-1"
          // The field keeps focus: it is a filter for the list.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
        >
          <ul id={`${id}-list`} role="listbox" className="max-h-64 overflow-y-auto">
            {matches.map((suggestion, index) => (
              <li key={suggestion.url}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isChosen(suggestion)}
                  // `onMouseDown`: a click that blurred the input first would
                  // close the list out from under the pointer.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(suggestion);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                    index === activeIndex && "bg-accent text-accent-foreground",
                  )}
                >
                  {suggestion.fromRoutines ? (
                    <History className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Globe className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{suggestion.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {suggestion.fromRoutines ? "In your routines · " : ""}
                      {displayUrl(suggestion.url)}
                    </span>
                  </span>
                  {isChosen(suggestion) && <Check className="size-4 shrink-0" />}
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      )}
    </Popover>
  );
}

export default WebsitePicker;
