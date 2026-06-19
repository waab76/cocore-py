import type { ApiDocsCatalogEntry } from "./catalog.ts";

export type ApiDocsParamControl =
  | {
      kind: "input";
      param: string;
      label?: string;
      placeholder?: string;
    }
  | {
      kind: "select";
      param: string;
      label?: string;
      optionsSource: "tags";
    };

const input = (param: string, label?: string, placeholder?: string): ApiDocsParamControl => ({
  kind: "input",
  param,
  label,
  placeholder,
});

export const API_DOCS_INTERACTIVE: Partial<Record<string, Array<ApiDocsParamControl>>> = {
  "dev.cocore.appview.getProfile": [input("did", "did")],
  "dev.cocore.appview.listIncomingFriends": [input("did", "did")],
  "dev.cocore.appview.listAccounts": [input("q", "q", "search query")],
  "dev.cocore.appview.getReceipts": [
    input("provider", "provider"),
    input("requester", "requester"),
    input("job", "job"),
  ],
  "dev.cocore.appview.getJobs": [input("requester", "requester")],
  "dev.cocore.appview.getSettlements": [
    input("receipt", "receipt"),
    input("requester", "requester"),
  ],
  "dev.cocore.appview.verifyReceipt": [input("uri", "uri")],
  "dev.cocore.appview.verifySettlement": [input("uri", "uri")],
};

/** Params the user can edit in the curl panel for this endpoint. */
export function apiDocsParamControls(
  entry: ApiDocsCatalogEntry,
  signedIn: boolean,
): Array<ApiDocsParamControl> {
  const controls = API_DOCS_INTERACTIVE[entry.nsid];
  if (!controls) return [];
  if (!signedIn) return controls;
  return controls.filter((control) => control.param !== "did");
}

export function apiDocsUsesSessionAuth(entry: ApiDocsCatalogEntry): boolean {
  return entry.auth === "required" || entry.method === "procedure";
}
