//! APNs push host FFI — confidential tier, macOS + `apns` feature only.
//!
//! Bridges the AppKit push receiver in `CoCoreMLX/PushHost.swift` to the Rust
//! serve loop. The measured agent binary (this process — it holds `K` and the
//! SE signing key) is the APNs receiver, because AMFI only lets our genuine,
//! team-signed code receive a push for our topic. A push delivers an
//! `E_K(nonce)` challenge; the serve loop opens it with `K` and SE-signs the
//! nonce (see [`crate::advisor::handle_code_challenge_payload`]).
//!
//! Threading: [`run_blocking`] hands the CURRENT thread to `NSApplication.run`
//! and never returns, so the caller must invoke it on the process **main**
//! thread (the tokio serve loop runs on worker threads). The two callbacks
//! fire on that Cocoa thread and forward into tokio channels, which are safe to
//! send on from any thread without a runtime in scope.
//!
//! What is and isn't covered by tests: the security-critical logic
//! (parse → open with `K` → SE-sign) lives in `advisor.rs` and is unit-tested
//! there with no Cocoa dependency. This module is the transport — exercised
//! end-to-end only on a notarized agent in a logged-in GUI session, the same
//! path the S5 spike (`provider/spikes/apns`) already proved works.

use std::ffi::{c_char, c_void, CStr};
use std::sync::{Mutex, OnceLock};
use tokio::sync::mpsc::UnboundedSender;

extern "C" {
    /// Implemented in `CoCoreMLX/PushHost.swift`. Blocks forever.
    fn cocore_push_host_run(
        token_cb: extern "C" fn(*const c_char, *mut c_void),
        push_cb: extern "C" fn(*const c_char, *mut c_void),
        ctx: *mut c_void,
    );
}

/// Latest APNs device token the host has registered, if any. The serve loop
/// reads this when building its `Register` frame so the advisor knows where to
/// send the code-identity challenge. `None` until APNs hands one back (or
/// forever, on a headless session that can't register — those stay best-effort).
static DEVICE_TOKEN: Mutex<Option<String>> = Mutex::new(None);

/// The most recent device token APNs issued to this process, if registration
/// has succeeded.
pub fn current_device_token() -> Option<String> {
    DEVICE_TOKEN.lock().ok().and_then(|g| g.clone())
}

/// Channels the trampolines forward Cocoa-thread events into. Boxed and handed
/// to the Swift side as the opaque `ctx`.
struct HostCtx {
    /// Raw APNs payload JSON for each received push.
    push_tx: UnboundedSender<String>,
}

// The boxed ctx must outlive the (never-returning) run loop.
static CTX: OnceLock<Box<HostCtx>> = OnceLock::new();

extern "C" fn token_trampoline(s: *const c_char, _ctx: *mut c_void) {
    if s.is_null() {
        return;
    }
    // SAFETY: Swift passes a valid, NUL-terminated UTF-8 hex string.
    let tok = unsafe { CStr::from_ptr(s) };
    if let Ok(tok) = tok.to_str() {
        if let Ok(mut g) = DEVICE_TOKEN.lock() {
            *g = Some(tok.to_string());
        }
        tracing::info!("apns: registered device token ({} hex chars)", tok.len());
    }
}

extern "C" fn push_trampoline(s: *const c_char, ctx: *mut c_void) {
    if s.is_null() || ctx.is_null() {
        return;
    }
    // SAFETY: `ctx` is the `&HostCtx` we passed to `cocore_push_host_run`,
    // which lives in `CTX` for the process lifetime; `s` is valid UTF-8 JSON.
    let host = unsafe { &*(ctx as *const HostCtx) };
    let payload = unsafe { CStr::from_ptr(s) };
    if let Ok(payload) = payload.to_str() {
        let _ = host.push_tx.send(payload.to_string());
    }
}

/// Hand the current (must be **main**) thread to the AppKit push loop. Never
/// returns. Received push payloads are forwarded on `push_tx` for the serve
/// loop to handle; device tokens are stashed in [`current_device_token`].
pub fn run_blocking(push_tx: UnboundedSender<String>) -> ! {
    let ctx = CTX.get_or_init(|| Box::new(HostCtx { push_tx }));
    let ctx_ptr = (ctx.as_ref() as *const HostCtx) as *mut c_void;
    // SAFETY: trampolines are `extern "C"`, `ctx_ptr` outlives the call.
    unsafe { cocore_push_host_run(token_trampoline, push_trampoline, ctx_ptr) };
    // run() must not return; if it does the push host is dead and we'd be
    // serving un-attested — abort so the supervisor restarts us clean.
    tracing::error!("apns: push host run loop exited unexpectedly; aborting");
    std::process::abort();
}
