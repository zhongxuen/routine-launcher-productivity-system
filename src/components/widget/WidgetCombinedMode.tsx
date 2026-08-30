import WidgetFocusPanel from "./WidgetFocusPanel";
import WidgetHeading from "./WidgetHeading";
import WidgetTaskList from "./WidgetTaskList";

/**
 * Section 26's Combined Widget.
 *
 * ```text
 * ┌─────────────────────────┐
 * │ TODAY                   │
 * │                         │
 * │ □ Finish report         │
 * │ □ Study JavaScript      │
 * │                         │
 * │ FOCUS                   │
 * │ 42:18                   │
 * │                         │
 * │ [ Start ]               │
 * └─────────────────────────┘
 * ```
 *
 * Both halves of the day in one window: what is left to do, and whether the
 * clock is running on any of it. Nothing here is new — it is `WidgetTaskList`
 * and `WidgetFocusPanel`, the same two components the task and focus widgets
 * are made of, reading the same two stores. A mode is an arrangement, not a
 * separate feature.
 *
 * The arrangement is the whole design decision, and it is this: the focus
 * section takes the height it needs and the task list takes what is left.
 * A clock is a fixed number of lines and a list is not, so the list is the
 * half that can give — which is also the half that has somewhere to give *to*,
 * since it truncates with a count of what it dropped. Doing it the other way
 * would mean a clock that shrank as the day filled up.
 *
 * The mockup drops the `3/7` count from this layout and this follows it: with
 * two lists of the day on screen at once, the count is the line worth losing.
 * The task widget keeps it.
 *
 * There is no `+ Add Task` here for the same reason, and it is the mockup's
 * call too — the combined widget is for watching the day rather than editing
 * it, and the button would cost a task row. The task widget is one click away
 * in Settings for anyone who wants the other trade.
 */
function WidgetCombinedMode() {
  return (
    <div className="flex h-full flex-col gap-1.5">
      {/* Two rows even when the window is short: below that the top half of
          this layout is a heading with nothing under it, which says less than
          a clipped second row does. */}
      <WidgetTaskList topmost minimumRows={2} />

      <div className="flex shrink-0 flex-col gap-1 border-t pt-1.5">
        <WidgetHeading label="Focus" />
        <WidgetFocusPanel variant="compact" />
      </div>
    </div>
  );
}

export default WidgetCombinedMode;
