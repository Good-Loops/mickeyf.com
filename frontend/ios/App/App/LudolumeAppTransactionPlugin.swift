import Foundation
import Capacitor
import CryptoKit
import StoreKit

// Read only after the server identifies an eligible child and the client switch is enabled.
@objc(LudolumeAppTransactionPlugin)
public class LudolumeAppTransactionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LudolumeAppTransactionPlugin"
    public let jsName = "LudolumeAppTransaction"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "readSignedTransaction", returnType: CAPPluginReturnPromise)
    ]

    @objc func readSignedTransaction(_ call: CAPPluginCall) {
        guard call.options.isEmpty else {
            call.resolve(["status": "unavailable"])
            return
        }
        guard #available(iOS 16.0, *) else {
            call.resolve(["status": "unsupported"])
            return
        }
        Task { @MainActor in
            do {
                let result = try await AppTransaction.shared
                guard case let .verified(transaction) = result,
                      let deviceID = AppStore.deviceVerificationID else {
                    call.resolve(["status": "unavailable"])
                    return
                }
                // This check is local to the device; the backend must still verify Apple's signature.
                guard LudolumeAppTransactionDeviceCheck.matches(nonce: transaction.deviceVerificationNonce,
                    deviceID: deviceID, expected: transaction.deviceVerification) else {
                    call.resolve(["status": "unavailable"])
                    return
                }
                let signedTransaction = result.jwsRepresentation
                guard !signedTransaction.isEmpty, signedTransaction.utf8.count <= 65_536 else {
                    call.resolve(["status": "unavailable"])
                    return
                }
                call.resolve(["status": "available", "signedTransaction": signedTransaction])
            } catch {
                call.resolve(["status": "unavailable"])
            }
        }
    }
}

enum LudolumeAppTransactionDeviceCheck {
    static func matches(nonce: UUID, deviceID: UUID, expected: Data) -> Bool {
        let input = nonce.uuidString.lowercased() + deviceID.uuidString.lowercased()
        return Data(SHA384.hash(data: Data(input.utf8))) == expected
    }
}
