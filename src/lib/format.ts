/** Small formatting helpers shared across views. */

/** Human-readable byte size (D71 Batch B attachments). Binary units to match
 * the exchange's byte-count caps (MAX_ATTACHMENT_TOTAL_BYTES is 50 MiB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Last path segment, tolerating either separator (native pickers hand back
 * OS-native paths — backslashes on Windows). */
export function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
