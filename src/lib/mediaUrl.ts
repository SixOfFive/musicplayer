/**
 * Build a URL that our custom `mp-media` Electron protocol will serve.
 *
 * Chromium's <img>/<audio> URL safety check rejects opaque origins (URLs
 * with an empty host / `///`), so we always use an explicit host of `local`.
 * Paths are segment-encoded so real `%` characters in filenames survive,
 * and Windows backslashes become forward slashes for URL compliance.
 */
export function mediaUrl(absolutePath: string | null | undefined): string | undefined {
  if (!absolutePath) return undefined;
  const normalized = absolutePath.replace(/\\/g, '/');
  const encoded = normalized.split('/').map(encodeURIComponent).join('/');
  return `mp-media://local/${encoded}`;
}
