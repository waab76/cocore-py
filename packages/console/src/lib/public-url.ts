/** Public base URL for absolute links (OG tags, OAuth, share URLs). */
export function getPublicUrl(): string {
  const url =
    process.env["PUBLIC_URL"] ??
    process.env["VITE_PUBLIC_URL"] ??
    process.env["CONSOLE_PUBLIC_URL"];
  if (!url) {
    return "http://127.0.0.1:3000";
  }
  return url.replace("localhost", "127.0.0.1").replace(/\/$/, "");
}

/** Browser-safe public URL — falls back to the current origin in dev. */
export function getPublicUrlClient(): string {
  if (globalThis.window !== undefined) {
    return globalThis.window.location.origin;
  }
  return getPublicUrl();
}
