//! Wire types for advisor ↔ provider WebSocket messages.
//!
//! The advisor is stateless w.r.t. receipts (anything that matters for
//! authority lives on a PDS), but we still need a transport for: provider
//! registration, heartbeats, encrypted job dispatch, and inference
//! progress. Frames are tagged JSON (`#[serde(tag = "type", rename_all =
//! "snake_case")]`) so the wire is human-debuggable and version-tolerant —
//! receivers can ignore unknown variants without dropping the connection.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AdvisorMessage {
    /// Provider → advisor: announce capabilities.
    Register(Register),
    /// Provider → advisor: liveness and load.
    Heartbeat(Heartbeat),
    /// Advisor → provider: encrypted job to serve.
    InferenceRequest(InferenceRequest),
    /// Provider → advisor: streaming response chunk.
    InferenceChunk(InferenceChunk),
    /// Provider → advisor: terminal completion notice.
    InferenceComplete(InferenceComplete),
    /// Advisor → provider: nonce-based attestation challenge.
    AttestationChallenge(AttestationChallenge),
    /// Provider → advisor: signed challenge response.
    AttestationResponse(AttestationResponse),
    /// Provider → advisor (→ requester): per-request ephemeral session key for
    /// the confidential tier. Minted fresh inside the measured engine and
    /// SE-signed over the requester's nonce + the active attestation CID, so a
    /// confidential requester can prove the key it seals to is controlled by
    /// the attested enclave and was produced for THIS request (not replayed).
    SessionKey(SessionKey),
    /// Advisor → provider: liveness probe. The provider answers `Pong`
    /// with the same nonce immediately from its serve loop, so a pong
    /// proves the request loop is pumping (stronger than a WS-level pong,
    /// which the read half auto-sends even when the loop is wedged). The
    /// advisor uses this to preflight a provider before routing a job.
    Ping(Ping),
    /// Provider → advisor: reply to `Ping`, echoing the nonce.
    Pong(Pong),
    /// Advisor → provider: standing change. `Bad` means the advisor
    /// stopped routing jobs here (failed preflight / went silent mid-job);
    /// the agent surfaces it to the operator. `Ok` clears it. Additive.
    HealthNotice(HealthNotice),
    /// Advisor → provider: "your owner-set control state changed — re-read
    /// it." A pure nudge carrying no authority; the agent re-reads the
    /// authoritative `active` from its own PDS record and reports it back
    /// in a Heartbeat. Lets a console start/stop take effect in ~a second
    /// instead of waiting for the next poll. Additive.
    ControlChanged(ControlChanged),
    /// Advisor → provider: "you've been flagged unhealthy — try to
    /// self-right now." The agent runs its engine health-check + bounded
    /// restart immediately (rather than waiting for the next scheduled
    /// health tick) and reports the outcome in `RecoverResult`. Carries no
    /// authority. Additive — old agents ignore it (they still get the
    /// `HealthNotice` that accompanies it).
    RecoverRequest(RecoverRequest),
    /// Provider → advisor: outcome of a self-right attempt. `recovered`
    /// true → engines are back and the machine is ready for jobs again
    /// (advisor clears its bad standing); false → it couldn't, and `detail`
    /// is the remediation text the console + tray surface. Additive.
    RecoverResult(RecoverResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoverRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoverResult {
    pub recovered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlChanged {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ping {
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pong {
    pub nonce: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStanding {
    Ok,
    Bad,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthNotice {
    pub standing: HealthStanding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Register {
    pub provider_did: String,
    /// Stable per-machine identifier — this machine's
    /// `dev.cocore.compute.provider` record rkey. Lets the advisor hold
    /// several machines under one DID (an owner serving on a laptop AND a
    /// desktop) instead of one evicting the other, and is the join key the
    /// console uses to map advisor live-standing onto a machine. Optional /
    /// additive: pre-`machine_id` advisors ignore it, and an advisor that
    /// wants it but doesn't get it falls back to `attestation_pub_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    pub machine_label: String,
    pub chip: String,
    pub ram_gb: u32,
    pub supported_models: Vec<String>,
    pub encryption_pub_key: String,  // base64 X25519
    pub attestation_pub_key: String, // base64 P-256
    pub attestation_uri: String,     // at://… of the active attestation record
    /// Present when the agent could not bring one or more configured
    /// inference engines online after its startup recovery loop gave up
    /// (see `build_engines`). Purely diagnostic: the failed models are
    /// already absent from `supported_models`, so matchmaking is correct
    /// without this — it exists so the advisor can *note* that a machine
    /// is up but degraded (only serving `stub`) and surface that to
    /// operators / dashboards. Omitted on a healthy serve. Additive: old
    /// advisors ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_fault: Option<crate::pds::EngineFault>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Heartbeat {
    pub load: f32,
    pub queue_depth: u32,
    pub at: chrono::DateTime<chrono::Utc>,
    /// The owner's start/stop switch as the agent currently sees it on its
    /// PDS record. `Some(false)` → the owner stopped this machine; the
    /// advisor routes it no jobs. `Some(true)` / absent → serving. Additive
    /// — old advisors ignore it (and the machine keeps serving).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    /// Content-free crash telemetry: how many times this machine's agent
    /// has panicked since its last sustained clean uptime, plus the most
    /// recent panic's location/signature/build. Lets the advisor (and an
    /// operator dashboard) spot a flapping machine fleet-wide without
    /// anyone tailing a log — the symptom that previously only showed up
    /// as a quietly-flat ledger. Carries NO prompt/token content and NO
    /// panic message (only a `file:line` and a hash). Omitted on a machine
    /// that has never crashed. Additive — old advisors ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crash: Option<crate::diagnostics::CrashSignature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceRequest {
    pub job_uri: String, // at:// strong-ref to the job record
    /// CID half of the job strong-ref. Optional on the wire because
    /// the smoke `dispatch-job.sh` requester doesn't publish a real
    /// job record; the console (which does) populates it. When
    /// missing, the provider can still serve the request but cannot
    /// publish a receipt — the receipt format requires both halves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_cid: Option<String>,
    pub requester_did: String,
    pub requester_pub_key: String, // base64 X25519
    pub model: String,
    pub max_tokens_out: u32,
    pub ciphertext: Vec<u8>, // sealed plaintext prompt, base64-decoded by the wire layer
    pub session_id: String,
    /// Confidential tier: the requester's fresh nonce. When present, the
    /// provider mints a per-request ephemeral key and returns a `SessionKey`
    /// signed over this nonce before serving. Additive — absent = best-effort.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// Confidential tier: CID of the attestation the requester verified, which
    /// the provider's `SessionKey` signature binds to (so a key signed for a
    /// different attestation can't be replayed). Additive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attestation_cid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionKey {
    pub session_id: String,
    /// base64 X25519 public key the requester seals the prompt to.
    pub ephemeral_pub_key: String,
    /// Echo of the requester's fresh nonce.
    pub nonce: String,
    /// CID of the attestation this session is bound to.
    pub attestation_cid: String,
    /// Secure Enclave P-256 signature (DER) over the canonical bytes of
    /// `{attestationCid, ephemeralPubKey, nonce}` — the exact form the SDK's
    /// `sessionKeyMessage` reconstructs and verifies against
    /// `attestation.publicKey`.
    pub signature: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceChunk {
    pub session_id: String,
    pub seq: u32,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceComplete {
    pub session_id: String,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub receipt_uri: String, // at:// where the receipt was published
    /// Inclusion pointer for the published receipt: the signed repo
    /// commit `rev` (and its CID) the receipt landed in. Lets the
    /// requester locate the receipt in the provider's signed MST without
    /// re-walking the repo. Empty/`None` when no receipt was published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_commit_rev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_commit_cid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttestationChallenge {
    pub nonce: String,
    /// Advisor-supplied wall-clock at the moment the challenge was
    /// sent. The provider signs this verbatim into its response so the
    /// advisor can prove the response was produced after time T, not
    /// replayed from an earlier exchange.
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttestationResponse {
    pub nonce: String,
    /// Echo of the coordinator-supplied timestamp from the challenge.
    /// Signed alongside `nonce` and `sip_enabled`.
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub sip_enabled: bool,
    /// Optional: hypervisor presence as detected by the provider.
    /// `None` means the provider declined to claim either way (e.g.
    /// running on a platform where the check is unreliable).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hypervisor_present: Option<bool>,
    pub signature: Vec<u8>,
}
