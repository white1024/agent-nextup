// In-app update (D144): the parts of the flow that are plain values.

/** Where the portable build and the "what changed" link send people. */
export const RELEASES_URL = "https://github.com/white1024/agent-nextup/releases";

/** The release page for one version — where the hand-written change notes
 *  live. The updater's own `body` is the workflow's boilerplate about unsigned
 *  builds, which says nothing about what changed. */
export function releasePageUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version.replace(/^v/, "")}`;
}

/** Whole-number download percentage, or null while the size is unknown (the
 *  server may not send a Content-Length). Never reports 100 before the last
 *  byte: a bar that sits at 100% while the install has not started reads as
 *  stuck. */
export function downloadPercent(done: number, total: number | null | undefined): number | null {
  if (!total || total <= 0) return null;
  if (done >= total) return 100;
  return Math.min(99, Math.floor((done / total) * 100));
}
