import type { ReactNode } from "react";

// Inline SVG icon set.
// stroke=currentColor so icons inherit text color everywhere.

export interface IconProps {
  size?: number;
  className?: string;
}

function Base({
  size = 16,
  className,
  sw = 1.8,
  children,
}: IconProps & { sw?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Brand mark (a cube) */
export function IconLogo(p: IconProps) {
  return (
    <Base {...p} sw={2}>
      <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </Base>
  );
}

export function IconDashboard(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Base>
  );
}

export function IconTasks(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
    </Base>
  );
}

export function IconDoc(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Base>
  );
}

/** Ledger (an open notebook, D47) */
export function IconBook(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12 6c-1.5-1.7-3.7-2.5-6-2.5H4V18h2.5c2 0 4 .7 5.5 2 1.5-1.3 3.5-2 5.5-2H20V3.5h-2c-2.3 0-4.5.8-6 2.5z" />
      <path d="M12 6v14" />
    </Base>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </Base>
  );
}

export function IconTools(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6 2 2 6-6a4 4 0 0 0 5.4-5.4l-2.3 2.3-1.7-.3-.3-1.7z" />
    </Base>
  );
}

/** Terminal (a prompt and an input line, D50) */
export function IconTerminal(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </Base>
  );
}

export function IconSettings(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1H10a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1 2.7h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.2 1z" />
    </Base>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Base {...p} sw={2.4}>
      <path d="M20 6L9 17l-5-5" />
    </Base>
  );
}

export function IconX(p: IconProps) {
  return (
    <Base {...p} sw={2.4}>
      <path d="M18 6L6 18M6 6l12 12" />
    </Base>
  );
}

export function IconCaretDown(p: IconProps) {
  return (
    <Base {...p} sw={2}>
      <path d="M6 9l6 6 6-6" />
    </Base>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Base {...p} sw={2}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  );
}

export function IconArrowRight(p: IconProps) {
  return (
    <Base {...p} sw={2}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Base>
  );
}

export function IconWarn(p: IconProps) {
  return (
    <Base {...p} sw={2}>
      <path d="M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </Base>
  );
}

export function IconLock(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Base>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Base {...p} sw={2}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </Base>
  );
}

export function IconFolder(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Base>
  );
}

export function IconDownload(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </Base>
  );
}

export function IconUsers(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </Base>
  );
}

/** Inbox (a tray) */
export function IconInbox(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M3 13l3-8h12l3 8" />
      <path d="M3 13v6h18v-6" />
      <path d="M3 13h5l2 3h4l2-3h5" />
    </Base>
  );
}

/** Team flows (nodes and directed edges) */
export function IconFlow(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="5" cy="6" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="12" r="2.5" />
      <path d="M7.4 6.8L16.6 11M7.4 17.2L16.6 13" />
    </Base>
  );
}

/** Workflow templates (stacked layers, D51) */
export function IconLayers(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12 3L2.5 8 12 13l9.5-5z" />
      <path d="M2.5 12.5L12 17.5l9.5-5" />
      <path d="M2.5 17L12 22l9.5-5" />
    </Base>
  );
}

export function IconClipboardCheck(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 13l2 2 4-4" />
    </Base>
  );
}

/** Edit (a pencil, D60 task-row action) */
export function IconPencil(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M14.5 6.5l3 3" />
    </Base>
  );
}

/** Delete (a bin, D60 task-row action) */
export function IconTrash(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6M14 11v6" />
    </Base>
  );
}

/** Archive (a storage box, D60 task-row action) */
export function IconArchive(p: IconProps) {
  return (
    <Base {...p}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </Base>
  );
}

/** Pop out to a separate window (an external-link arrow, B16-C terminal pop-out) */
export function IconPopout(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
    </Base>
  );
}

/** Automatic delivery (a bolt, D71 marker on automatic edges) */
export function IconBolt(p: IconProps) {
  return (
    <Base {...p} sw={2}>
      <path d="M13 2L3 14h9l-1 8 10-12h-9z" />
    </Base>
  );
}

/** Indeterminate (the bar in the tri-state "partly automatic" box, the counterpart to IconCheck) */
export function IconMinus(p: IconProps) {
  return (
    <Base {...p} sw={2.4}>
      <path d="M5 12h14" />
    </Base>
  );
}

/** The team's prime (D116). A shape, not a colour: the canvas already spends
 *  its accent on auto-route edges, and D64 keeps state off colour alone. */
export function IconStar(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.9z" />
    </Base>
  );
}

/** Attachments (a paperclip) — replaces the 📎 the inbox used to print, whose
 *  weight and colour were the platform emoji font's call rather than ours. */
export function IconPaperclip(p: IconProps) {
  return (
    <Base {...p}>
      <path d="M21 11.5l-8.8 8.8a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3" />
    </Base>
  );
}

/** Awaiting something (a clock) — the unverified half of the milestone toggle. */
export function IconClock(p: IconProps) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Base>
  );
}

/** Stop (a filled square) — the armed state of the terminal's two-step close,
 *  so the shape says "this click acts" and not the colour alone. */
export function IconStopSquare(p: IconProps) {
  return (
    <Base {...p} sw={1.5}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
    </Base>
  );
}
