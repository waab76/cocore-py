/** Default fixture values for API docs examples (client-safe). */
export type ApiDocsFixtures = {
  providerDid: string;
  requesterDid: string;
  jobUri: string;
  receiptUri: string;
  listQuery: string;
};

export function getDefaultApiDocsFixtures(): ApiDocsFixtures {
  return {
    providerDid: "did:plc:example-provider",
    requesterDid: "did:plc:example-requester",
    jobUri: "at://did:plc:example-requester/dev.cocore.compute.job/abc",
    receiptUri: "at://did:plc:example-provider/dev.cocore.compute.receipt/xyz",
    listQuery: "alice",
  };
}

const PLACEHOLDER_DID = "did:plc:example";

/** Whether fixtures still use scaffold placeholders (no env discovery). */
export function isPlaceholderApiDocsFixture(
  fixtures: ApiDocsFixtures,
  field: keyof ApiDocsFixtures,
): boolean {
  const defaults = getDefaultApiDocsFixtures();
  const value = fixtures[field];
  const defaultValue = defaults[field];
  if (value === defaultValue) {
    return true;
  }
  if (typeof value === "string" && value.includes(PLACEHOLDER_DID)) {
    return true;
  }
  return false;
}
