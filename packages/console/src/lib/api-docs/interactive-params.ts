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
  "dev.cocore.account.getProfile": [input("did", "did")],
  "dev.cocore.account.listIncomingFriends": [input("did", "did")],
  "dev.cocore.account.listAccounts": [input("q", "q", "search query")],
  "dev.cocore.compute.listReceipts": [
    input("provider", "provider"),
    input("requester", "requester"),
    input("job", "job"),
  ],
  "dev.cocore.compute.listJobs": [input("requester", "requester")],
  "dev.cocore.compute.listSettlements": [
    input("receipt", "receipt"),
    input("requester", "requester"),
  ],
  "dev.cocore.compute.verifyReceipt": [input("uri", "uri")],
  "dev.cocore.compute.verifySettlement": [input("uri", "uri")],
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
