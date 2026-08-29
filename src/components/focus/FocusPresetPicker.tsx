import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFocusStore } from "@/stores/focusStore";
import { FOCUS_PRESETS, MAX_CUSTOM_MINUTES, MIN_CUSTOM_MINUTES } from "@/types/focus";

/**
 * The five presets of development-plan.md section 34, and the length behind
 * Custom.
 *
 * Only drawn when nothing is running — the store refuses a preset change
 * mid-session, and a row of buttons that cannot be pressed is a worse way of
 * saying so than not showing them. `FocusTimer` decides that; this component
 * assumes it is being shown at a moment when the choice is live.
 */
function FocusPresetPicker() {
  const presetId = useFocusStore((state) => state.presetId);
  const customMinutes = useFocusStore((state) => state.customMinutes);
  const selectPreset = useFocusStore((state) => state.selectPreset);
  const setCustomMinutes = useFocusStore((state) => state.setCustomMinutes);

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

      {presetId === "custom" && <CustomMinutesField minutes={customMinutes} onCommit={setCustomMinutes} />}
    </div>
  );
}

/**
 * The Custom length.
 *
 * What is being typed is kept locally and only handed to the store once it is
 * a number — otherwise clearing the field to type `90` would be read as an
 * empty length the moment the `9` was deleted, and the store would clamp it
 * back to something the user did not ask for while their cursor was still in
 * the box. The committed value is read back rather than assumed, so a length
 * outside the allowed range shows what was actually accepted.
 */
function CustomMinutesField({
  minutes,
  onCommit,
}: {
  minutes: number;
  onCommit: (minutes: number) => void;
}) {
  const [draft, setDraft] = useState(String(minutes));

  function commit() {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isNaN(parsed) ? minutes : parsed;
    onCommit(next);
    setDraft(String(useFocusStore.getState().customMinutes));
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="focus-custom-minutes" className="text-sm font-normal text-muted-foreground">
        Length
      </Label>
      <Input
        id="focus-custom-minutes"
        type="number"
        inputMode="numeric"
        min={MIN_CUSTOM_MINUTES}
        max={MAX_CUSTOM_MINUTES}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        className="w-24"
      />
      <span className="text-sm text-muted-foreground">minutes</span>
    </div>
  );
}

export default FocusPresetPicker;
