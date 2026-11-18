import { Component, createRef, type ErrorInfo, type ReactNode } from "react";

import { motionOff } from "../lib/fx";

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
  retrying: boolean;
}

/** How long C225 plays before the page is given another go. */
const RETRY_MS = 820;

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
 *
 * D153: the crash is drawn as the app's own cube with one edge missing. Retry
 * (C225) grows the edge back from both ends and lights the cube, and only then
 * gives the page another go.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, retrying: false };

  private cube = createRef<HTMLDivElement>();
  private timer: number | undefined;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, retrying: false };
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
      window.clearTimeout(this.timer);
      this.setState({ error: null, retrying: false });
    }
  }

  componentWillUnmount() {
    window.clearTimeout(this.timer);
  }

  private retry = () => {
    const w = this.cube.current;
    if (w === null || motionOff()) {
      this.setState({ error: null, retrying: false });
      return;
    }
    this.setState({ retrying: true });
    for (const half of w.querySelectorAll<SVGPathElement>(".crash-cube-h")) {
      half.animate([{ transform: "scale(0)" }, { transform: "scale(1)" }], {
        duration: 420,
        easing: "cubic-bezier(.3,.7,.2,1)",
        fill: "forwards",
      });
    }
    w.querySelector(".crash-cube-gap")?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 200,
      delay: 260,
      fill: "forwards",
    });
    w.querySelector(".crash-cube-glow")?.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }],
      { duration: 560, delay: 440, easing: "ease-out" },
    );
    this.timer = window.setTimeout(() => this.setState({ error: null, retrying: false }), RETRY_MS);
  };

  render() {
    const { error, retrying } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="view">
        <div className="crash" role="alert">
          <div className="crash-cube" ref={this.cube} aria-hidden="true">
            <i className="crash-cube-glow" />
            {/* The mark's cube (IconLogo) with its top-right edge broken off:
                a short dashed stub where it should be, and the edge's two
                halves waiting at scale 0 at either end. */}
            <svg viewBox="0 0 24 24" width="112" height="112">
              <path
                className="crash-cube-l"
                d="M12 3L4 7.5v9L12 21l8-4.5v-9M12 12l8-4.5M12 12v9M12 12L4 7.5"
              />
              <path className="crash-cube-gap" d="M14.6 4.46L17.4 6.04" />
              <path className="crash-cube-h crash-cube-h1" d="M12 3L16 5.25" />
              <path className="crash-cube-h crash-cube-h2" d="M20 7.5L16 5.25" />
            </svg>
          </div>
          <h2 className="crash-title">{this.props.title}</h2>
          <p className="crash-hint">{this.props.hint}</p>
          <p className="crash-detail">{error.message}</p>
          <button className="btn" disabled={retrying} onClick={this.retry}>
            {this.props.retryLabel}
          </button>
        </div>
      </div>
    );
  }
}
