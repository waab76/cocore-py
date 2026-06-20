//! Validation harness for `codesign::read_self()` (WS-CDHASH, graduates the
//! S3 spike into the real module). Build + sign this with
//! `--options runtime,library` and confirm its reported cdHash equals
//! `codesign -dvvv`. See provider/spikes/s3-cdhash for the original spike.
//!
//!   cargo build --example codesign_probe
//!   codesign --force --options runtime,library --sign "<Developer ID>" \
//!     target/debug/examples/codesign_probe
//!   target/debug/examples/codesign_probe   # prints JSON
//!   codesign -dvvv target/debug/examples/codesign_probe  # CDHash= must match

fn main() {
    let info = cocore_provider::codesign::read_self();
    println!(
        "{{\"cdHash\":{:?},\"teamId\":{:?},\"hardenedRuntime\":{},\"libraryValidation\":{},\"getTaskAllow\":{}}}",
        info.cd_hash.as_deref().unwrap_or(""),
        info.team_id.as_deref().unwrap_or(""),
        info.hardened_runtime,
        info.library_validation,
        info.get_task_allow,
    );
}
