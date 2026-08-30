import WidgetQuickAdd from "./WidgetQuickAdd";
import WidgetTaskList from "./WidgetTaskList";

/**
 * Section 26's Task Widget.
 *
 * ```text
 * ┌─────────────────────────┐
 * │ TODAY             3/7   │
 * ├─────────────────────────┤
 * │ □ Finish report         │
 * │ □ Study JavaScript      │
 * │ ✓ Check emails          │
 * │                         │
 * │ + Add Task              │
 * └─────────────────────────┘
 * ```
 *
 * The mockup exactly, and the mockup is already the whole component: a
 * heading with the day's score, the list, and one button. Everything with
 * behaviour in it is in `WidgetTaskList` and `WidgetQuickAdd`, which the
 * combined widget shares — this file's job is the arrangement, which is the
 * one thing the two modes genuinely differ on.
 *
 * The list takes every pixel the Add Task button does not, and truncates
 * rather than scrolling. That is why the button is a sibling of the list
 * rather than the last thing inside it: it must not be the row that gets cut
 * off in a short window, because a widget with nothing to press on it is
 * a picture of today rather than a way to work on it.
 */
function WidgetTaskMode() {
  return (
    <div className="flex h-full flex-col gap-1">
      {/* Three rows even in the shortest window the user can drag this to
          (140px). Below that the mockup is not really available, and one task
          row would misrepresent the day more than a clipped third row does. */}
      <WidgetTaskList showCount topmost minimumRows={3} />
      <div className="shrink-0">
        <WidgetQuickAdd />
      </div>
    </div>
  );
}

export default WidgetTaskMode;
