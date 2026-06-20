// End-to-end smoke for the cocore stack.
//
// Generates a real P-256 keypair via WebCrypto, signs a canonical
// receipt body, publishes the (paymentAuthorization, job, attestation,
// receipt) tuple through the bridge, waits for the exchange to charge
// + settle, then verifies via the AppView's cryptographic
// verifyReceipt route.
//
// Run against an already-running stack:
//
//   make stack-up                     # docker compose
//   node --experimental-strip-types infra/smoke.ts
//
// Or against the bare-node fallback:
//
//   cd infra/services && aube run start &
//   node --experimental-strip-types infra/smoke.ts

import { seedDevStack } from "./seed-dev-stack.ts";

const BRIDGE = process.env["BRIDGE"] ?? "http://localhost:8080";
const APPVIEW = process.env["APPVIEW"] ?? "http://localhost:8081";
const PROVIDER = "did:plc:smoke-provider";
const DEADLINE_MS = 30_000;

function step(label: string): void {
  process.stderr.write(`\n--- ${label} ---\n`);
}

async function getStats(): Promise<{ charges: number; settled: number }> {
  const res = await fetch(`${BRIDGE}/xrpc/dev.cocore.bridge.stats`);
  if (!res.ok) throw new Error(`stats: ${res.status}`);
  const body = (await res.json()) as {
    payments: { charges: number; payouts: number };
    settled: number;
  };
  return { charges: body.payments.charges, settled: body.settled };
}

async function main() {
  step("1. /healthz");
  const health = await fetch(`${BRIDGE}/healthz`).then((r) => r.json());
  console.log(JSON.stringify(health));

  step("2. snapshot starting state");
  const start = await getStats();
  console.log(`charges=${start.charges} settled=${start.settled}`);

  step("3–4. publish provider + authorization, job, attestation, signed receipt");
  const { receiptUri } = await seedDevStack({ bridge: BRIDGE });

  step(`5. wait for settlement (deadline ${DEADLINE_MS / 1000}s)`);
  const t0 = Date.now();
  while (Date.now() - t0 < DEADLINE_MS) {
    const cur = await getStats();
    if (cur.charges > start.charges && cur.settled > start.settled) {
      console.log(
        `settled (charges ${start.charges}->${cur.charges}, settlements ${start.settled}->${cur.settled})`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const final = await getStats();
  if (final.charges <= start.charges) {
    throw new Error("charge counter did not increment");
  }

  step("6. verifyReceipt at the AppView (cryptographic)");
  const verifyRes = await fetch(
    `${APPVIEW}/xrpc/dev.cocore.compute.verifyReceipt?uri=${encodeURIComponent(receiptUri)}`,
  );
  const verify = (await verifyRes.json()) as { ok: boolean; findings: { code: string }[] };
  console.log(JSON.stringify(verify));
  if (!verify.ok) {
    const codes = verify.findings.map((f) => f.code).join(",");
    throw new Error(`verifyReceipt returned ok=false: ${codes}`);
  }

  step("7. assert receipt indexed for this provider");
  const list = (await fetch(
    `${APPVIEW}/xrpc/dev.cocore.compute.listReceipts?provider=${encodeURIComponent(PROVIDER)}`,
  ).then((r) => r.json())) as { receipts: { uri: string }[] };
  if (!list.receipts.some((r) => r.uri === receiptUri)) {
    throw new Error("receipt not in AppView getReceipts response");
  }
  console.log(`indexed ${list.receipts.length} receipts for ${PROVIDER}`);

  console.log("\nsmoke OK (cryptographic verification passed)");
}

main().catch((e) => {
  console.error("FAIL:", (e as Error).message);
  process.exit(1);
});
