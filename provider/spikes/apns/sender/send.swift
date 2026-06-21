// APNs code-identity spike — SENDER.
//
// Stands in for the real advisor/coordinator: builds a token-auth (.p8) ES256
// JWT and POSTs a background push to APNs over HTTP/2 (URLSession negotiates
// h2 automatically for https). CryptoKit does ES256 with a raw R||S signature
// natively, so there are no pip installs and no DER→raw fiddling.
//
//   usage: apns-send <p8Path> <keyID> <teamID> <topic> <deviceToken>
//
// Production gateway, because the profile's aps-environment is "production".

import Foundation
import CryptoKit

func b64url(_ d: Data) -> String {
    d.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

let args = CommandLine.arguments
guard args.count == 6 else {
    FileHandle.standardError.write(Data("usage: apns-send <p8Path> <keyID> <teamID> <topic> <deviceToken>\n".utf8))
    exit(2)
}
let (p8Path, keyID, teamID, topic, deviceToken) = (args[1], args[2], args[3], args[4], args[5])

// --- Load the .p8 (PEM PKCS#8 EC private key) -------------------------------
let pem: String
do { pem = try String(contentsOfFile: p8Path, encoding: .utf8) }
catch { FileHandle.standardError.write(Data("cannot read \(p8Path): \(error)\n".utf8)); exit(1) }

let signingKey: P256.Signing.PrivateKey
do { signingKey = try P256.Signing.PrivateKey(pemRepresentation: pem) }
catch { FileHandle.standardError.write(Data("bad .p8 key: \(error)\n".utf8)); exit(1) }

// --- Build the JWT (ES256) --------------------------------------------------
let header = #"{"alg":"ES256","kid":"\#(keyID)"}"#
let iat = Int(Date().timeIntervalSince1970)
let payload = #"{"iss":"\#(teamID)","iat":\#(iat)}"#
let signingInput = b64url(Data(header.utf8)) + "." + b64url(Data(payload.utf8))
let sig = try! signingKey.signature(for: Data(signingInput.utf8))
let jwt = signingInput + "." + b64url(sig.rawRepresentation)

// --- POST the push ----------------------------------------------------------
var req = URLRequest(url: URL(string: "https://api.push.apple.com/3/device/\(deviceToken)")!)
req.httpMethod = "POST"
req.setValue("bearer \(jwt)", forHTTPHeaderField: "authorization")
req.setValue(topic, forHTTPHeaderField: "apns-topic")
req.setValue("background", forHTTPHeaderField: "apns-push-type")
req.setValue("5", forHTTPHeaderField: "apns-priority")     // background pushes must not be priority 10
req.setValue("0", forHTTPHeaderField: "apns-expiration")
// content-available:1 marks it a silent/background push so it routes to
// didReceiveRemoteNotification without any UI.
req.httpBody = Data(#"{"aps":{"content-available":1},"spike":"hello-from-advisor"}"#.utf8)

let sem = DispatchSemaphore(value: 0)
var code = -1
URLSession.shared.dataTask(with: req) { data, resp, err in
    defer { sem.signal() }
    if let err = err { print("TRANSPORT-ERROR: \(err)"); return }
    let http = resp as! HTTPURLResponse
    code = http.statusCode
    let apnsId = http.value(forHTTPHeaderField: "apns-id") ?? "<none>"
    let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    print("APNS-STATUS: \(code)  apns-id: \(apnsId)  body: \(body.isEmpty ? "<empty=success>" : body)")
}.resume()
sem.wait()
// APNs returns 200 on accept; anything else carries a JSON reason (BadDeviceToken,
// TopicDisallowed, ExpiredProviderToken, …) that tells us exactly what's wrong.
exit(code == 200 ? 0 : 1)
