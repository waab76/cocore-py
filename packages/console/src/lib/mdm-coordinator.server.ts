// Server side of Apple Managed Device Attestation (MDA) — the
// coordinator endpoints that drive guided MDM enrollment for the
// "Secure Mode" upgrade. We proved the flow manually with NanoMDM +
// step-ca; this module is the honest HTTP surface over it.
//
// SCOPE / HONESTY
// ---------------
// Real CA persistence (minting per-device identities, signing the
// .mobileconfig with the MDM vendor cert) and capturing Apple's x5c
// attestation chain out of step-ca are ops-gated: they require live CA
// material and a running NanoMDM/step-ca pair. So the *external* calls
// here are stubbed behind env vars with clearly-marked `TODO(ops)`
// seams. What is NOT stubbed: the HTTP surface, the agent auth, input
// validation, env wiring, and request/response shapes — those are real
// and typecheck, so wiring the backend later is a localized change.
//
// All MDM/CA specifics come from env (see REQUIRED ENV below); nothing
// is hardcoded except the .mobileconfig template skeleton, which is
// itself overridable via COCORE_MDM_PROFILE_TEMPLATE.
//
// REQUIRED ENV (documented; absent ones degrade to working stubs)
// ---------------------------------------------------------------
//   COCORE_MDM_PROFILE_TEMPLATE   Optional. A .mobileconfig template
//                                 string with `{{SERIAL}}`, `{{UDID}}`,
//                                 `{{PROFILE_UUID}}`, `{{MDM_TOPIC}}`,
//                                 `{{MDM_SERVER_URL}}`, `{{CHECKIN_URL}}`
//                                 placeholders. When unset, a built-in
//                                 skeleton is used.
//   COCORE_MDM_SERVER_URL         MDM command/server URL embedded in the
//                                 profile's MDM payload (ServerURL).
//   COCORE_MDM_CHECKIN_URL        MDM CheckInURL (defaults to server URL).
//   COCORE_MDM_TOPIC              APNs push topic (the MDM payload Topic,
//                                 e.g. com.apple.mgmt.External.<uuid>).
//   COCORE_MDM_ROOT_CA_PEM        Root CA cert (PEM) to embed for trust.
//   COCORE_MDM_INTERMEDIATE_CA_PEM Intermediate CA cert (PEM) to embed.
//   COCORE_MDM_SIGNING_CERT_PEM   Vendor/identity cert used to *sign* the
//                                 mobileconfig (CMS). TODO(ops): when set
//                                 we must CMS-sign; today we return the
//                                 templated profile unsigned.
//   COCORE_MDM_SIGNING_KEY_PEM    Private key paired with the signing cert.
//   COCORE_NANOMDM_URL            Base URL of NanoMDM (for /v1/enqueue +
//                                 push). When unset, push-attestation
//                                 returns a stubbed "queued" status.
//   COCORE_NANOMDM_API_KEY        Bearer/basic secret NanoMDM expects.
//   COCORE_MDM_CHAIN_STORE_URL    Base URL of the step-ca-fed store that
//                                 holds captured Apple x5c chains keyed by
//                                 serial. When unset, attestation-chain
//                                 returns {chain: null, status:"pending"}.

import { resolveBearerKey, type ResolvedKey } from "@/lib/api-keys.server.ts";

// ---------------------------------------------------------------------------
// Auth — same bearer-API-key surface every other /api/agent/* route uses.
// ---------------------------------------------------------------------------

export type MdmAuthResult =
  | { ok: true; caller: ResolvedKey }
  | { ok: false; response: Response };

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

export function mdmJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Authenticate an agent caller via its bearer API key — identical
 *  posture to /api/agent/whoami and /api/agent/status. Returns the
 *  resolved key on success, or a ready-to-send 401 Response. */
export function authenticateAgent(request: Request): MdmAuthResult {
  const bearer = readBearer(request);
  if (!bearer) {
    return { ok: false, response: mdmJson({ error: "missing Authorization: Bearer header" }, 401) };
  }
  const caller = resolveBearerKey(bearer);
  if (!caller) {
    return { ok: false, response: mdmJson({ error: "invalid API key" }, 401) };
  }
  return { ok: true, caller };
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

/** Apple device serials are alphanumeric (historically 10–12 chars; the
 *  newer randomized serials are longer). Keep this permissive but strict
 *  enough to reject obvious garbage / injection into the templated
 *  profile. */
const SERIAL_RE = /^[A-Za-z0-9]{8,24}$/;

/** A UDID is a 40-hex string (legacy) or a UUID-shaped string on newer
 *  hardware. Accept both forms. */
const UDID_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function isValidSerial(v: unknown): v is string {
  return typeof v === "string" && SERIAL_RE.test(v);
}

export function isValidUdid(v: unknown): v is string {
  return typeof v === "string" && UDID_RE.test(v);
}

// ---------------------------------------------------------------------------
// enroll-profile — mint a per-device .mobileconfig.
// ---------------------------------------------------------------------------

/** Built-in .mobileconfig skeleton used when COCORE_MDM_PROFILE_TEMPLATE
 *  is unset. Includes a root+intermediate trust payload, a device
 *  identity placeholder, and an MDM payload with AccessRights=3 and
 *  SignMessage=true (the MDA-relevant settings). Placeholders are
 *  substituted per request. */
const DEFAULT_PROFILE_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key>
  <string>co/core Secure Mode Enrollment ({{SERIAL}})</string>
  <key>PayloadIdentifier</key>
  <string>dev.cocore.mdm.enroll.{{SERIAL}}</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>{{PROFILE_UUID}}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadIdentifier</key>
      <string>dev.cocore.mdm.trust.root.{{SERIAL}}</string>
      <key>PayloadUUID</key>
      <string>{{ROOT_PAYLOAD_UUID}}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadCertificateFileName</key>
      <string>cocore-root-ca.pem</string>
      <key>PayloadContent</key>
      <data>{{ROOT_CA_B64}}</data>
    </dict>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.pkcs1</string>
      <key>PayloadIdentifier</key>
      <string>dev.cocore.mdm.trust.intermediate.{{SERIAL}}</string>
      <key>PayloadUUID</key>
      <string>{{INTERMEDIATE_PAYLOAD_UUID}}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadCertificateFileName</key>
      <string>cocore-intermediate-ca.pem</string>
      <key>PayloadContent</key>
      <data>{{INTERMEDIATE_CA_B64}}</data>
    </dict>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.pkcs12</string>
      <key>PayloadIdentifier</key>
      <string>dev.cocore.mdm.identity.{{SERIAL}}</string>
      <key>PayloadUUID</key>
      <string>{{IDENTITY_PAYLOAD_UUID}}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadCertificateFileName</key>
      <string>cocore-device-identity.p12</string>
      <!-- TODO(ops): real per-device identity PKCS#12 minted by step-ca.
           Stub embeds an empty identity so the profile is structurally
           complete and installable in a test ring. -->
      <key>PayloadContent</key>
      <data>{{IDENTITY_P12_B64}}</data>
    </dict>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.mdm</string>
      <key>PayloadIdentifier</key>
      <string>dev.cocore.mdm.payload.{{SERIAL}}</string>
      <key>PayloadUUID</key>
      <string>{{MDM_PAYLOAD_UUID}}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>IdentityCertificateUUID</key>
      <string>{{IDENTITY_PAYLOAD_UUID}}</string>
      <key>Topic</key>
      <string>{{MDM_TOPIC}}</string>
      <key>ServerURL</key>
      <string>{{MDM_SERVER_URL}}</string>
      <key>CheckInURL</key>
      <string>{{CHECKIN_URL}}</string>
      <key>AccessRights</key>
      <integer>3</integer>
      <key>SignMessage</key>
      <true/>
      <key>CheckOutWhenRemoved</key>
      <true/>
    </dict>
  </array>
</dict>
</plist>
`;

export interface EnrollProfileResult {
  /** The .mobileconfig body to return as application/x-apple-aspen-config. */
  profile: string;
  /** Whether the profile was CMS-signed. False today (stub returns the
   *  templated-but-unsigned profile); flips true once signing is wired. */
  signed: boolean;
  /** The per-enrollment id callers thread into push-attestation. */
  enrollmentId: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** Base64 of a PEM cert's DER body — the form a `com.apple.security.*`
 *  PayloadContent expects. We strip the PEM armor and re-emit the inner
 *  base64 (which is already DER-base64). Returns "" when no PEM is
 *  configured so the template stays well-formed. */
function pemBodyB64(pem: string | undefined): string {
  if (!pem) return "";
  return pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
}

/** Build a per-device enrollment .mobileconfig for {serial, udid}.
 *
 *  Reads the template + CA material from env, substitutes the serial /
 *  udid / generated UUIDs, and returns the profile. CMS signing is the
 *  ops-gated seam (TODO below); today we return the templated profile
 *  unsigned but otherwise complete. */
export function buildEnrollmentProfile(serial: string, udid: string): EnrollProfileResult {
  const template = env("COCORE_MDM_PROFILE_TEMPLATE") ?? DEFAULT_PROFILE_TEMPLATE;
  const enrollmentId = crypto.randomUUID();

  const subs: Record<string, string> = {
    SERIAL: serial,
    UDID: udid,
    PROFILE_UUID: enrollmentId.toUpperCase(),
    ROOT_PAYLOAD_UUID: crypto.randomUUID().toUpperCase(),
    INTERMEDIATE_PAYLOAD_UUID: crypto.randomUUID().toUpperCase(),
    IDENTITY_PAYLOAD_UUID: crypto.randomUUID().toUpperCase(),
    MDM_PAYLOAD_UUID: crypto.randomUUID().toUpperCase(),
    MDM_TOPIC: env("COCORE_MDM_TOPIC") ?? "com.apple.mgmt.External.PLACEHOLDER",
    MDM_SERVER_URL: env("COCORE_MDM_SERVER_URL") ?? "https://mdm.cocore.dev/mdm",
    CHECKIN_URL:
      env("COCORE_MDM_CHECKIN_URL") ?? env("COCORE_MDM_SERVER_URL") ?? "https://mdm.cocore.dev/mdm",
    ROOT_CA_B64: pemBodyB64(env("COCORE_MDM_ROOT_CA_PEM")),
    INTERMEDIATE_CA_B64: pemBodyB64(env("COCORE_MDM_INTERMEDIATE_CA_PEM")),
    // TODO(ops): mint a real per-device PKCS#12 identity from step-ca,
    // keyed to `serial`, and embed it here. Stub leaves it empty.
    IDENTITY_P12_B64: "",
  };

  let profile = template;
  for (const [key, value] of Object.entries(subs)) {
    profile = profile.split(`{{${key}}}`).join(value);
  }

  // TODO(ops): when COCORE_MDM_SIGNING_CERT_PEM + COCORE_MDM_SIGNING_KEY_PEM
  // are configured, CMS-sign the profile (openssl smime -sign equivalent)
  // so it installs without the "unsigned profile" warning and so the MDM
  // payload's SignMessage handshake is rooted in our vendor cert. Until
  // the signer is wired we return the unsigned-but-complete profile.
  const canSign = Boolean(env("COCORE_MDM_SIGNING_CERT_PEM") && env("COCORE_MDM_SIGNING_KEY_PEM"));
  const signed = false; // flips true once CMS signing lands.
  void canSign;

  return { profile, signed, enrollmentId };
}

// ---------------------------------------------------------------------------
// push-attestation — enqueue the ACME attestation profile to NanoMDM.
// ---------------------------------------------------------------------------

export interface PushAttestationResult {
  /** Whether NanoMDM accepted the enqueue+push. */
  queued: boolean;
  /** NanoMDM command UUID, when it returned one. */
  commandUuid: string | null;
  /** Coarse status: "queued" (sent to NanoMDM or stubbed) | "error". */
  status: string;
  /** True when no NanoMDM backend was configured and we stubbed. */
  stubbed: boolean;
  /** Human-readable detail (NanoMDM error text, or the stub note). */
  detail: string | null;
}

/** Build the ACME attestation .mobileconfig that NanoMDM will deliver as
 *  an InstallProfile command. ClientIdentifier + the cert Subject CN are
 *  pinned to the device serial, which is what binds the captured Apple
 *  x5c chain back to this machine.
 *
 *  KEY-BINDING (option b, freshness-code) — TODO(ops): the verifier accepts
 *  the chain only when it binds to the agent's signing key, and we chose the
 *  freshness-code rule: the leaf's Apple freshness OID
 *  (1.2.840.113635.100.8.11.1) must equal `sha256(signing pubkey)` (the raw
 *  64-byte P-256 point published as `attestation.publicKey`). Stock
 *  `com.apple.security.acme` derives its freshness from the ACME challenge, so
 *  making Apple emit that exact value needs ONE of: (1) a custom step-ca
 *  `device-attest-01` nonce set to `sha256(signing pubkey)`, or (2) the App
 *  Attest companion where the agent controls `clientDataHash`. Until that's
 *  wired the captured chain verifies Apple-rooted but does NOT bind, so the
 *  provider stays best-effort (fail-closed). See infra/mdm/README.md
 *  "The binding decision". */
function buildAttestationCommandProfile(serial: string): string {
  const acmeUrl = env("COCORE_MDM_ACME_URL") ?? "https://ca.cocore.dev/acme/attest";
  const uuid = crypto.randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key>
  <string>co/core Device Attestation (${serial})</string>
  <key>PayloadIdentifier</key>
  <string>dev.cocore.mdm.attest.${serial}</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.security.acme</string>
      <key>PayloadIdentifier</key>
      <string>dev.cocore.mdm.acme.${serial}</string>
      <key>PayloadUUID</key>
      <string>${crypto.randomUUID().toUpperCase()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>ClientIdentifier</key>
      <string>${serial}</string>
      <key>DirectoryURL</key>
      <string>${acmeUrl}</string>
      <key>Subject</key>
      <array>
        <array>
          <array>
            <string>CN</string>
            <string>${serial}</string>
          </array>
        </array>
      </array>
      <key>Attest</key>
      <true/>
      <key>HardwareBound</key>
      <true/>
    </dict>
  </array>
</dict>
</plist>
`;
}

/** Enqueue the ACME attestation profile to NanoMDM for the given device
 *  and push it. Calls NanoMDM's /v1/enqueue/<udid-or-enrollment> then
 *  /v1/push/<...> using COCORE_NANOMDM_URL + COCORE_NANOMDM_API_KEY.
 *
 *  When NanoMDM isn't configured we return a stubbed "queued" status so
 *  the agent flow is exercisable end-to-end in a backendless dev ring. */
export async function pushAttestationCommand(
  serial: string,
  enrollmentId: string,
): Promise<PushAttestationResult> {
  const base = env("COCORE_NANOMDM_URL");
  const apiKey = env("COCORE_NANOMDM_API_KEY");

  const profile = buildAttestationCommandProfile(serial);
  // NanoMDM's enqueue command envelope: an InstallProfile command whose
  // payload is the (base64) mobileconfig. NanoMDM accepts a raw plist
  // command on POST /v1/enqueue/<id>.
  const commandUuid = crypto.randomUUID().toUpperCase();
  const enqueueBody = buildInstallProfileCommand(commandUuid, profile);

  if (!base || !apiKey) {
    // TODO(ops): wire COCORE_NANOMDM_URL + COCORE_NANOMDM_API_KEY to the
    // live NanoMDM. Stub: pretend the enqueue+push succeeded so the
    // guided-enrollment UX can be developed against a backendless ring.
    return {
      queued: true,
      commandUuid,
      status: "queued",
      stubbed: true,
      detail: "NanoMDM not configured (COCORE_NANOMDM_URL/API_KEY unset); enqueue stubbed",
    };
  }

  const root = base.replace(/\/$/, "");
  // NanoMDM authenticates with HTTP Basic where the password is the API
  // key (username arbitrary, conventionally "nanomdm").
  const authHeader = `Basic ${Buffer.from(`nanomdm:${apiKey}`).toString("base64")}`;
  // We key the command by enrollmentId — the per-device enrollment whose
  // identity the agent installed in step 1.
  const target = encodeURIComponent(enrollmentId);

  try {
    const enqueueResp = await fetch(`${root}/v1/enqueue/${target}`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/xml" },
      body: enqueueBody,
    });
    if (!enqueueResp.ok) {
      const text = await enqueueResp.text().catch(() => "");
      return {
        queued: false,
        commandUuid,
        status: "error",
        stubbed: false,
        detail: `NanoMDM enqueue failed (${enqueueResp.status}): ${text.slice(0, 200)}`,
      };
    }

    // Push wakes the device so it checks in and pulls the queued command.
    const pushResp = await fetch(`${root}/v1/push/${target}`, {
      method: "GET",
      headers: { authorization: authHeader },
    });
    if (!pushResp.ok) {
      const text = await pushResp.text().catch(() => "");
      return {
        queued: true,
        commandUuid,
        status: "queued-no-push",
        stubbed: false,
        detail: `enqueued but push failed (${pushResp.status}): ${text.slice(0, 200)}`,
      };
    }

    return {
      queued: true,
      commandUuid,
      status: "queued",
      stubbed: false,
      detail: null,
    };
  } catch (e) {
    return {
      queued: false,
      commandUuid,
      status: "error",
      stubbed: false,
      detail: `NanoMDM request error: ${(e as Error).message}`,
    };
  }
}

/** Wrap a mobileconfig in NanoMDM's InstallProfile command plist. */
function buildInstallProfileCommand(commandUuid: string, profile: string): string {
  const payloadB64 = Buffer.from(profile, "utf8").toString("base64");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CommandUUID</key>
  <string>${commandUuid}</string>
  <key>Command</key>
  <dict>
    <key>RequestType</key>
    <string>InstallProfile</string>
    <key>Payload</key>
    <data>${payloadB64}</data>
  </dict>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// attestation-chain — fetch the captured Apple x5c chain by serial.
// ---------------------------------------------------------------------------

export interface AttestationChainResult {
  /** The captured Apple x5c chain (base64 DER certs, leaf-first) or null
   *  when no chain has been captured for this serial yet. */
  chain: string[] | null;
  /** "captured" | "pending" | "error". */
  status: string;
  /** True when no chain store was configured and we stubbed. */
  stubbed: boolean;
  /** Detail for "error"/"pending"; null on success. */
  detail: string | null;
}

/** Return the captured Apple x5c attestation chain for `serial`.
 *
 *  In production the chain is captured by step-ca during the ACME
 *  device-attest-01 challenge and persisted keyed by the cert Subject CN
 *  (= serial). We read it from an env-configured store URL. When the
 *  store isn't configured we stub a "pending" response.
 *
 *  TODO(ops): point COCORE_MDM_CHAIN_STORE_URL at the real step-ca-fed
 *  store (or replace this fetch with a direct step-ca admin API read).
 *  The store is expected to answer GET <base>/<serial> with
 *  {chain: string[]} or 404 when not-yet-captured. */
export async function fetchAttestationChain(serial: string): Promise<AttestationChainResult> {
  const base = env("COCORE_MDM_CHAIN_STORE_URL");
  if (!base) {
    return {
      chain: null,
      status: "pending",
      stubbed: true,
      detail: "chain store not configured (COCORE_MDM_CHAIN_STORE_URL unset)",
    };
  }
  const root = base.replace(/\/$/, "");
  try {
    const resp = await fetch(`${root}/${encodeURIComponent(serial)}`, {
      headers: env("COCORE_MDM_CHAIN_STORE_API_KEY")
        ? { authorization: `Bearer ${env("COCORE_MDM_CHAIN_STORE_API_KEY")}` }
        : {},
    });
    if (resp.status === 404) {
      return { chain: null, status: "pending", stubbed: false, detail: "no chain captured yet" };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        chain: null,
        status: "error",
        stubbed: false,
        detail: `chain store error (${resp.status}): ${text.slice(0, 200)}`,
      };
    }
    const body = (await resp.json()) as { chain?: unknown };
    const chain = Array.isArray(body.chain) && body.chain.every((c) => typeof c === "string")
      ? (body.chain as string[])
      : null;
    return {
      chain,
      status: chain ? "captured" : "pending",
      stubbed: false,
      detail: chain ? null : "chain store returned no chain",
    };
  } catch (e) {
    return {
      chain: null,
      status: "error",
      stubbed: false,
      detail: `chain store request error: ${(e as Error).message}`,
    };
  }
}
