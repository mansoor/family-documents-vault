/**
 * A file the vault answered with, saved by the browser as a download — the
 * way a document's Download has always done it, for the ZIPs of several
 * (0.9.0, DL) too.
 */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * A plain address the browser saves as it comes, to disk (0.9.0, DL review):
 * a ZIP's ticket, or a link's ZIP or file — never held in the tab. The name
 * is the one the vault's answer gives.
 */
export function followDownload(href: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  a.rel = 'noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
