/** Default fixture values for API docs examples (client-safe). */
export type ApiDocsFixtures = {
  providerDid: string;
  requesterDid: string;
  jobUri: string;
  receiptUri: string;
  settlementUri: string;
  listQuery: string;
};

export function getDefaultApiDocsFixtures(): ApiDocsFixtures {
  const did = "did:plc:m2sjv3wncvsasdapla35hzwj";
  return {
    providerDid: did,
    requesterDid: did,
    jobUri: `at://${did}/dev.cocore.compute.job/abc`,
    receiptUri: `at://${did}/dev.cocore.compute.receipt/xyz`,
    settlementUri: `at://${did}/dev.cocore.compute.settlement/xyz`,
    listQuery: did,
  };
}
