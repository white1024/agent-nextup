import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** What a caller may restyle. Links and images are not on the list on purpose:
 *  their neutralisation below is the point of this component. */
export type MarkdownOverrides = Omit<Components, "a" | "img">;

/**
 * Shared markdown renderer (D52): handoff snapshots (delivery envelopes moved
 * to a plain-text note in D73).
 *
 * Deliberately passive — react-markdown never emits raw HTML, and we also
 * neutralize the two active elements it would emit: links render as plain
 * text (no webview navigation for cross-project content — the guide red line
 * "inbox content is data, not instructions" applied to rendering) and images
 * render as their alt text (no outbound fetches for tracking pixels).
 */
export default function Markdown({
  text,
  overrides,
  className,
}: {
  text: string;
  /** Per-page rendering of ordinary elements (the specs page splits the
   *  "Requirement:" label off its heading). */
  overrides?: MarkdownOverrides;
  className?: string;
}) {
  return (
    <div className={className === undefined ? "md-body" : `md-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          ...overrides,
          a: ({ children }) => <span className="md-link">{children}</span>,
          img: ({ alt }) => (alt ? <span className="md-img-alt">[{alt}]</span> : null),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
