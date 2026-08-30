import type { LucideIcon } from "lucide-react";

import EmptyState from "./EmptyState";
import ErrorState from "./ErrorState";
import ListSkeleton from "./ListSkeleton";

interface AsyncBodyProps {
  isLoading: boolean;
  /** A failed read, already user-presentable. Null when the read was fine. */
  error: string | null;
  onRetry?: () => void;
  /** True when the read succeeded but produced nothing to show. */
  isEmpty: boolean;

  /** What to draw while loading. Defaults to rows sized by `skeletonRow`. */
  loading?: React.ReactNode;
  skeletonRows?: number;
  skeletonRowClassName?: string;
  skeletonClassName?: string;
  /** What is being read, announced while it is: "Loading your routines". */
  loadingLabel: string;

  /** "Could not load your routines." */
  errorTitle: string;
  /** Anything to offer besides the retry — a link to the page that owns it. */
  errorAction?: React.ReactNode;

  emptyIcon?: LucideIcon;
  emptyTitle: string;
  emptyHint?: string;
  emptyAction?: React.ReactNode;

  /**
   * Padding overrides for the two block states.
   *
   * The default `py-14` is right on a page, where the state is the whole
   * view. Inside a dashboard card it is far too much — the card would grow
   * taller failing than it ever is succeeding — so those call sites tighten
   * it rather than growing a second set of states.
   */
  errorClassName?: string;
  emptyClassName?: string;

  /** `compact` is the widget and the popup. See {@link EmptyState}. */
  size?: "default" | "compact";

  /** The content itself, rendered only when it is none of the above. */
  children: React.ReactNode;
}

/**
 * The four things that can be where a list is: still reading, failed to read,
 * nothing to show, or the list.
 *
 * The one place in the app that decides their order and their look
 * (development-plan.md section 84). Every async view routes through here — the
 * five task views, My Routines, focus history, achievements, the cleanup
 * results — so an empty Inbox and an empty focus history behave identically
 * and a component is only ever its own filtering, grouping and rows.
 *
 * The order matters and is not negotiable: loading beats error beats empty.
 * A failed read has no rows, so without that precedence every failure would
 * flash "nothing here yet" — telling the user their data is gone when it is
 * only unreachable.
 */
function AsyncBody({
  isLoading,
  error,
  onRetry,
  isEmpty,
  loading,
  skeletonRows,
  skeletonRowClassName,
  skeletonClassName,
  loadingLabel,
  errorTitle,
  errorAction,
  errorClassName,
  emptyIcon,
  emptyTitle,
  emptyHint,
  emptyAction,
  emptyClassName,
  size = "default",
  children,
}: AsyncBodyProps) {
  if (isLoading) {
    return (
      loading ?? (
        <ListSkeleton
          rows={skeletonRows}
          rowClassName={skeletonRowClassName}
          className={skeletonClassName}
          label={loadingLabel}
        />
      )
    );
  }

  if (error) {
    return (
      <ErrorState
        title={errorTitle}
        message={error}
        onRetry={onRetry}
        action={errorAction}
        size={size}
        className={errorClassName}
      />
    );
  }

  if (isEmpty) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        hint={emptyHint}
        action={emptyAction}
        size={size}
        className={emptyClassName}
      />
    );
  }

  return <>{children}</>;
}

export default AsyncBody;
export { AsyncBody };
