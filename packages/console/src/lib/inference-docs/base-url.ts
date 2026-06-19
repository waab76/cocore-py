export const INFERENCE_DOCS_DEFAULT_BASE_URL = "https://console.cocore.dev/api/v1";

export function inferenceBaseUrl(origin?: string): string {
  if (origin != null && origin.length > 0) return `${origin}/api/v1`;
  if (typeof window !== "undefined") return `${window.location.origin}/api/v1`;
  return INFERENCE_DOCS_DEFAULT_BASE_URL;
}
