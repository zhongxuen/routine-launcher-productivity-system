import { useFocusStore } from "@/stores/focusStore";

import WidgetFocusPanel, { focusLabel } from "./WidgetFocusPanel";
import WidgetHeading from "./WidgetHeading";

/**
 * Section 26's Focus Widget.
 *
 * ```text
 * ┌─────────────────────────┐
 * │ CODING                  │
 * │                         │
 * │       42:18             │
 * │                         │
 * │ [ Pause ] [ Finish ]    │
 * └─────────────────────────┘
 * ```
 *
 * The one mode with nothing to truncate, and the one that most wants to be a
 * widget: a clock you can see without going and finding it is most of why
 * section 83 offers an always-on-top window at all.
 *
 * The heading is the session's own name rather than the word FOCUS, exactly
 * as the mockup writes it. `CODING` is a routine or a task, not a feature —
 * and in a window where the clock says what this is, a label saying "focus"
 * would be the least informative line on screen. What it falls back to when
 * nothing is running is the preset, which is the next most useful answer to
 * "what would Start do".
 */
function WidgetFocusMode() {
  const session = useFocusStore((state) => state.session);
  const presetId = useFocusStore((state) => state.presetId);

  const label = focusLabel(session, presetId);

  return (
    <div className="flex h-full flex-col gap-1">
      {/* The full name in a tooltip: a task called "Rewrite the onboarding
          email sequence" has nowhere to go in 300px. */}
      <WidgetHeading label={label} title={label} topmost />
      <WidgetFocusPanel variant="large" />
    </div>
  );
}

export default WidgetFocusMode;
