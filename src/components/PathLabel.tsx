import { useState } from "react";
import { useTranslation } from "react-i18next";

import { IconCheck, IconFolder } from "./icons";

/**
 * A workspace path, shown so it stays readable in a narrow card (product review §4-4).
 *
 * Full paths are long and the informative end is the *tail* (`…\clients\acme`)
 * — CSS truncation cuts exactly that off. So the middle is elided instead, the
 * complete path lives in the tooltip, and a copy button saves the user from
 * selecting text that is visually abbreviated.
 */
export default function PathLabel({
  path,
  className,
  copyable = true,
}: {
  path: string;
  className?: string;
  /** Off for dense rows (canvas nodes, switcher entries) where a button would crowd. */
  copyable?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be refused; the tooltip still carries the full path, so
      // there is nothing to recover from and nothing worth alarming about.
    }
  }

  return (
    <span className={`path-label ${className ?? ""}`} title={path}>
      <span className="path-text">{elidePath(path)}</span>
      {copyable && (
        <button
          className="btn btn-ghost btn-icon path-copy"
          title={copied ? t("common.copied") : t("common.copyPath")}
          aria-label={t("common.copyPath")}
          onClick={(e) => {
            e.stopPropagation();
            void copy();
          }}
        >
          {copied ? <IconCheck size={12} /> : <IconFolder size={12} />}
        </button>
      )}
    </span>
  );
}

/** A path segment that is nothing but a UUID. */
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Two passes, in this order.
 *
 * First, **UUID segments are shortened wherever they appear** (r2 3-4) — a
 * delivery's attachment directory ends in a bare one, 36 characters of nothing
 * to read, and the elision below could never reach it because the tail is the
 * part that elision deliberately protects. This pass runs on every path, short
 * ones included: a UUID is unreadable at any length, so "it already fits" is
 * not a reason to keep it whole.
 *
 * Then, if what is left is still over the limit, **the middle is elided**,
 * keeping the drive/root and the last two segments:
 * `C:\ws\dev\clients\acme\api` → `C:\…\acme\api`. A path that already
 * fits is returned as-is — eliding what fits only makes it harder to read.
 *
 * Both passes are display-only: the tooltip and the copy button carry the real
 * path, unshortened.
 */
export function elidePath(path: string, maxLength = 44): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const short = path
    .split(sep)
    .map((p) => (UUID_SEGMENT.test(p) ? `${p.slice(0, 8)}…` : p))
    .join(sep);
  if (short.length <= maxLength) return short;
  const parts = short.split(sep).filter((p) => p !== "");
  if (parts.length <= 3) return short;
  const head = parts[0];
  const tail = parts.slice(-2).join(sep);
  const elided = `${head}${sep}…${sep}${tail}`;
  // A deep-but-long tail can still overflow; at that point the tooltip is the
  // only honest answer, so stop rather than mangle the part that identifies it.
  return elided.length < short.length ? elided : short;
}
