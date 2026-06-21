// APNs code-identity spike — RECEIVER.
//
// A minimal AppKit app that registers for remote notifications and prints
// (a) the device token APNs hands back, and (b) any push payload it receives.
// This stands in for the real cocore agent's push host. The whole point of the
// spike is to prove that a Developer-ID-signed (notarized, non-App-Store) Mac
// app carrying our embedded provisioning profile + aps-environment=production
// can actually receive a push — the AMFI-gated channel the code-identity fix
// depends on.
//
// Build/sign: see ../build-receiver.sh (must be signed with the Developer ID
// cert + the entitlements that match the embedded.provisionprofile, or APNs
// will refuse to issue a token).

import AppKit

// stdout is block-buffered when not a TTY (we run this under the Bash tool and
// tee to a log); make it unbuffered so the token line shows up immediately.
setvbuf(stdout, nil, _IONBF, 0)

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let bid = Bundle.main.bundleIdentifier ?? "<nil>"
        print("APNS-SPIKE: launched, bundleIdentifier=\(bid)")
        // Kick the registration. The result lands in one of the two delegate
        // callbacks below.
        NSApp.registerForRemoteNotifications()
        print("APNS-SPIKE: registerForRemoteNotifications() called; waiting…")
    }

    func application(_ application: NSApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("APNS-SPIKE-TOKEN: \(hex)")
        // Also drop it to a file so the sender step can read it without scraping
        // the log.
        let out = URL(fileURLWithPath: "device-token.txt")
        try? hex.write(to: out, atomically: true, encoding: .utf8)
    }

    func application(_ application: NSApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("APNS-SPIKE-FAIL: \(error)")
    }

    // Background / silent pushes (apns-push-type: background, content-available:1)
    // are delivered here while the app is running. No UNUserNotificationCenter,
    // so nothing is shown to the user or persisted to Notification Center — same
    // invariant darkbloom relies on.
    func application(_ application: NSApplication,
                     didReceiveRemoteNotification userInfo: [String: Any]) {
        print("APNS-SPIKE-PUSH: \(userInfo)")
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// .accessory: no Dock icon, no menu bar — a background agent, like the real one.
app.setActivationPolicy(.accessory)
app.run()
