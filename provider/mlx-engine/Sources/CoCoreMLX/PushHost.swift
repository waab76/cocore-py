// APNs push host for the confidential tier (provider/src/push_host.rs calls
// these C symbols). This is the production counterpart of the proven S5 spike
// (provider/spikes/apns): the MEASURED agent binary — the one that holds the
// X25519 key K and the Secure Enclave signing key and runs inference — is the
// party that registers for and receives the code-identity push. That is the
// whole point: AMFI only lets our genuine, team-signed binary receive a push
// for our topic, so a prompt-logging fork cannot answer the challenge.
//
// Threading: `cocore_push_host_run` takes over the calling thread with
// NSApplication.run(). The Rust side calls it on the process MAIN thread (the
// tokio serve loop runs on worker threads) — AppKit requires the main thread.
//
// FFI shape mirrors MLXBridge.swift: C callbacks + an opaque ctx the Rust side
// recovers its channel state from.

import AppKit

private final class CoCorePushDelegate: NSObject, NSApplicationDelegate {
    typealias StrCb = @convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void
    private let tokenCb: StrCb?
    private let pushCb: StrCb?
    private let ctx: UnsafeMutableRawPointer?

    init(tokenCb: StrCb?, pushCb: StrCb?, ctx: UnsafeMutableRawPointer?) {
        self.tokenCb = tokenCb
        self.pushCb = pushCb
        self.ctx = ctx
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.registerForRemoteNotifications()
    }

    func application(_ application: NSApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        hex.withCString { tokenCb?($0, ctx) }
    }

    func application(_ application: NSApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No token → the agent registers without one → the advisor cannot
        // code-attest this machine → it stays best-effort. Fail-closed.
        NSLog("cocore push host: registration failed: \(error)")
    }

    // Silent/background pushes (apns-push-type: background, content-available:1)
    // land here while the app runs. We forward the raw payload JSON to Rust,
    // which extracts the sealed challenge, opens it with K, and replies over the
    // advisor WebSocket. No UNUserNotificationCenter, so nothing is shown.
    func application(_ application: NSApplication,
                     didReceiveRemoteNotification userInfo: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(userInfo),
              let data = try? JSONSerialization.data(withJSONObject: userInfo),
              let json = String(data: data, encoding: .utf8) else { return }
        json.withCString { pushCb?($0, ctx) }
    }
}

// Held for the process lifetime so AppKit's weak delegate reference stays valid.
private var retainedDelegate: CoCorePushDelegate?

@_cdecl("cocore_push_host_run")
public func cocore_push_host_run(
    _ tokenCb: (@convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void)?,
    _ pushCb: (@convention(c) (UnsafePointer<CChar>?, UnsafeMutableRawPointer?) -> Void)?,
    _ ctx: UnsafeMutableRawPointer?
) {
    let app = NSApplication.shared
    let delegate = CoCorePushDelegate(tokenCb: tokenCb, pushCb: pushCb, ctx: ctx)
    retainedDelegate = delegate
    app.delegate = delegate
    // .accessory: no Dock icon — the agent is a background worker.
    app.setActivationPolicy(.accessory)
    app.run() // never returns; owns the main thread
}
