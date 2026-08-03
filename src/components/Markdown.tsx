import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children }) => <span className="md-link">{children}</span>,
          img: ({ alt }) => (alt ? <span className="md-img-alt">[{alt}]</span> : null),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
