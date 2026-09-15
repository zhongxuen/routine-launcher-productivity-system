import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFocusStore } from "@/stores/focusStore";
import {
  FOCUS_PRESETS,
  MAX_CUSTOM_BREAK_MINUTES,
  MAX_CUSTOM_MINUTES,
  MIN_CUSTOM_MINUTES,
} from "@/types/focus";

/**
 * The five presets of development-plan.md section 34, and the length — and
 * optional break — behind Custom. Custom's length starts at the default focus
 * duration from Settings (section 52).
 *
 * Only drawn when nothing is running — the store refuses a preset change
 * mid-session, and a row of buttons that cannot be pressed is a worse way of
 * saying so than not showing them. `FocusTimer` decides that; this component
 * assumes it is being shown at a moment when the choice is live.
 */
function FocusPresetPicker() {
  const presetId = useFocusStore((state) => state.presetId);
  const customMinutes = useFocusStore((state) => state.customMinutes);
  const customBreakMinutes = useFocusStore((state) => state.customBreakMinutes);
  const selectPreset = useFocusStore((state) => state.selectPreset);
  const setCustomMinutes = useFocusStore((state) => state.setCustomMinutes);
  const setCustomBreakMinutes = useFocusStore((state) => state.setCustomBreakMinutes);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {FOCUS_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant={preset.id === presetId ? "default" : "outline"}
            size="sm"
            aria-pressed={preset.id === presetId}
            onClick={() => selectPreset(preset.id)}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      {/* Custom's break sits on the same row as its length rather than a
          row of its own: it is the other half of the same choice — the
          "/ 5" a fixed preset carries in its label — and zero, the default,
          means none. Wraps rather than overflowing in the narrowest window. */}
      {presetId === "custom" && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <MinutesField
            id="focus-custom-minutes"
            label="Length"
            minutes={customMinutes}
            min={MIN_CUSTOM_MINUTES}
            max={MAX_CUSTOM_MINUTES}
            onCommit={setCustomMinutes}
            readBack={() => useFocusStore.getState().customMinutes}
          />
          <MinutesField
            id="focus-custom-break-minutes"
            label="Break"
            minutes={customBreakMinutes}
            min={0}
            max={MAX_CUSTOM_BREAK_MINUTES}
            onCommit={setCustomBreakMinutes}
            readBack={() => useFocusStore.getState().customBreakMinutes}
            className="w-20"
          />
        </div>
      )}
    </div>
  );
}

/**
 * One of Custom's two numbers — the length, or the break after it.
 *
 * What is being typed is kept locally and only handed to the store once it is
 * a number — otherwise clearing the field to type `90` would be read as an
 * empty length the moment the `9` was deleted, and the store would clamp it
 * back to something the user did not ask for while their cursor was still in
 * the box. The committed value is read back rather than assumed, so a length
 * outside the allowed range shows what was actually accepted.
 *
 * The value can also change from outside — Custom's length follows the
 * default focus duration in Settings, which is read after this may already be
 * on screen — so a new `minutes` replaces the draft.
 */
function MinutesField({
  id,
  label,
  minutes,
  min,
  max,
  onCommit,
  readBack,
  className = "w-24",
}: {
  id: string;
  label: string;
  minutes: number;
  min: number;
  max: number;
  onCommit: (minutes: number) => void;
  /** The value the store accepted, after clamping. */
  readBack: () => number;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(minutes));
  const [shownMinutes, setShownMinutes] = useState(minutes);
  if (minutes !== shownMinutes) {
    setShownMinutes(minutes);
    setDraft(String(minutes));
  }

  function commit() {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isNaN(parsed) ? minutes : parsed;
    onCommit(next);
    setDraft(String(readBack()));
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        className={className}
      />
      <span className="text-sm text-muted-foreground">minutes</span>
    </div>
  );
}

export default FocusPresetPicker;
