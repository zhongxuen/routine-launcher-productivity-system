import { Hammer } from "lucide-react";

import EmptyState from "./states/EmptyState";

interface PlaceholderViewProps {
  title: string;
}

/**
 * Generic stub used by every not-yet-implemented view.
 * Later prompts will replace individual usages with real components.
 *
 * Drawn as an {@link EmptyState} so a route that has nothing in it yet looks
 * like every other screen with nothing in it, rather than like a page that
 * failed to load.
 */
function PlaceholderView({ title }: PlaceholderViewProps) {
  return (
    <EmptyState
      icon={Hammer}
      title={`${title} is not built yet.`}
      hint="It has a place in the plan and a route to live at — there is just nothing behind it so far."
    />
  );
}

export default PlaceholderView;
