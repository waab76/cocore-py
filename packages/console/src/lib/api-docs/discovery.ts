import { cocoreConfig } from "@/lib/cocore-config.ts";

/** Fragment id on did:web for the AppView XRPC service. */
export const APPVIEW_SERVICE_ID = "cocore_appview";

/** Public AppView origin. Resolved from the server-side config (the source of
 *  truth, set per-env via COCORE_APPVIEW_URL); callers that need this in the
 *  browser should thread it down from a server loader rather than guessing,
 *  since the client has no access to the env. */
export function appviewBaseUrl(): string {
  if (globalThis.window !== undefined) {
    const configured = import.meta.env["VITE_COCORE_APPVIEW_URL"] as string | undefined;
    if (configured) {
      return configured.replace(/\/$/, "");
    }
    return "http://localhost:8081";
  }
  return cocoreConfig().appviewUrl.replace(/\/$/, "");
}

/** Origin of the console itself (host of the `/api/xrpc/*` methods that
 *  haven't moved to the AppView yet). Client-side that's the current
 *  origin; server-side, the configured public URL. */
export function consoleBaseUrlClient(): string {
  if (globalThis.window !== undefined) {
    return globalThis.window.location.origin;
  }
  return (
    process.env["CONSOLE_PUBLIC_URL"] ||
    process.env["BETTER_AUTH_URL"] ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}
