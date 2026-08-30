import React from "react";

import CrashFallback from "@/components/common/CrashFallback";
import { describeError, report } from "@/lib/crash-log";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
  /** `compact` is the popup, the launcher and the widget. */
  size?: "default" | "compact";
}

interface AppErrorBoundaryState {
  /** The message to show, or `null` while nothing has gone wrong. */
  message: string | null;
}

/**
 * The last thing between a render that threw and a blank window
 * (development-plan.md section 85).
 *
 * A class component because React has no hook for this: `componentDidCatch`
 * and `getDerivedStateFromError` are the only way to catch an exception
 * thrown during rendering, and nothing in the hooks API replaces them. It is
 * the one class in this codebase, and it is one for that reason alone.
 *
 * Wrapped around the *whole* tree of each window rather than around
 * individual screens. A finer-grained boundary sounds better — keep the
 * sidebar while one page fails — but it is the wrong trade here: the app
 * shell, the router and the stores are all above the pages, so a crash in any
 * of them would sail straight past a per-page boundary and produce exactly
 * the white rectangle this exists to prevent. The states kit in
 * `components/common/states` is what handles the failures a single screen can
 * survive; this handles the ones it cannot.
 *
 * ## Trying again
 *
 * "Try again" clears the error and re-mounts the children, which is worth
 * offering before a reload because most render crashes are one bad value in
 * one component and the second attempt succeeds. `resetKey` forces React to
 * build a fresh tree rather than reuse the state of the one that threw —
 * without it the same broken state would be handed back to the same
 * component and it would throw again immediately.
 */
class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { message: null };

  private resetKey = 0;

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { message: describeError(error).message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // The component stack is the part a JavaScript stack does not have: which
    // component threw, and what it was inside. A minified production stack is
    // close to unreadable without it.
    report("render", error, info.componentStack ?? undefined);
  }

  private retry = () => {
    this.resetKey += 1;
    this.setState({ message: null });
  };

  render() {
    if (this.state.message !== null) {
      return (
        <CrashFallback
          message={this.state.message}
          onRetry={this.retry}
          size={this.props.size}
        />
      );
    }

    return <React.Fragment key={this.resetKey}>{this.props.children}</React.Fragment>;
  }
}

export default AppErrorBoundary;
