import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Changing this clears a caught error — pass the current view id. */
  resetKey: unknown;
  title: string;
  hint: string;
  retryLabel: string;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken view from taking the whole window with it (reported during the D66 walkthrough:
 * a render loop in the team canvas blanked the entire app).
 *
 * The shell — sidebar, workspace switcher, nav — renders outside this boundary
 * on purpose: when a view dies, the way *out* of it has to survive. Without
 * that, the only recovery is restarting the app — which is exactly what
 * "the screen just went black" felt like.
 *
 * A class component because `componentDidCatch` has no hook equivalent; the
 * strings arrive as props for the same reason (no `useTranslation` in a class).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is the only place the stack survives — there is no crash
    // reporter, and the ledger is for project events, not app faults.
    console.error("view crashed:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // Navigating away clears the error, so switching views is a real recovery
    // path rather than something that repaints the same broken screen.
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="view">
        <div className="crash">
          <h2 className="crash-title">{this.props.title}</h2>
          <p className="crash-hint">{this.props.hint}</p>
          <p className="crash-detail">{error.message}</p>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            {this.props.retryLabel}
          </button>
        </div>
      </div>
    );
  }
}
