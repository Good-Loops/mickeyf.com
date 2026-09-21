import AuthenticationServices
import Capacitor
import Foundation
import UIKit

@objc(LudolumeIdentityPlugin)
public class LudolumeIdentityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LudolumeIdentityPlugin"
    public let jsName = "LudolumeIdentity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCredentialState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private var pendingRequest: LudolumeAppleAuthorization?
    private var credentialObservers: [NSObjectProtocol] = []

    private var appleSignInEnabled: Bool {
        Bundle.main.object(forInfoDictionaryKey: "LudolumeAppleSignInEnabled") as? Bool == true
    }

    public override func load() {
        guard appleSignInEnabled, credentialObservers.isEmpty else { return }
        // Account deletion may not send a revocation notification, so recheck on resume too.
        for name in [ASAuthorizationAppleIDProvider.credentialRevokedNotification,
                     UIApplication.didBecomeActiveNotification] {
            credentialObservers.append(NotificationCenter.default.addObserver(
                forName: name, object: nil, queue: .main
            ) { [weak self] _ in
                guard let self, self.appleSignInEnabled else { return }
                self.notifyListeners("appleCredentialChanged", data: [:])
            })
        }
    }

    deinit {
        credentialObservers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        call.resolve(["apple": appleSignInEnabled, "google": false])
    }

    @objc func getCredentialState(_ call: CAPPluginCall) {
        guard appleSignInEnabled else {
            call.reject("Native credential state is unavailable.", "UNAVAILABLE")
            return
        }
        guard let userId = call.getString("userId"), !userId.isEmpty,
              userId.utf8.count <= 255,
              userId.utf8.allSatisfy({ (33...126).contains($0) }) else {
            call.reject("Invalid native credential-state request.", "INVALID_REQUEST")
            return
        }
        ASAuthorizationAppleIDProvider().getCredentialState(forUserID: userId) { state, error in
            DispatchQueue.main.async {
                guard error == nil else {
                    call.reject("Native credential state is unavailable.", "UNAVAILABLE")
                    return
                }
                let value: String
                switch state {
                case .authorized: value = "authorized"
                case .revoked: value = "revoked"
                case .notFound: value = "notFound"
                case .transferred: value = "transferred"
                @unknown default:
                    call.reject("Native credential state is unavailable.", "UNAVAILABLE")
                    return
                }
                call.resolve(["state": value])
            }
        }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.appleSignInEnabled else {
                call.reject("Native provider sign-in is unavailable.", "UNAVAILABLE")
                return
            }
            guard call.getString("provider") == "apple",
                  let clientId = call.getString("clientId"), !clientId.isEmpty,
                  clientId == Bundle.main.bundleIdentifier,
                  let nonce = call.getString("nonce"), Self.isChallengeValue(nonce),
                  let state = call.getString("state"), Self.isChallengeValue(state) else {
                call.reject("Invalid native sign-in request.", "INVALID_REQUEST")
                return
            }
            guard self.pendingRequest == nil else {
                call.reject("A native sign-in request is already active.", "BUSY")
                return
            }
            guard let window = self.bridge?.viewController?.viewIfLoaded?.window,
                  window.windowScene?.activationState == .foregroundActive else {
                call.reject("Native sign-in cannot be presented.", "UNAVAILABLE")
                return
            }
            let request = LudolumeAppleAuthorization(call: call, window: window, nonce: nonce, state: state) {
                [weak self] completed in
                if self?.pendingRequest === completed { self?.pendingRequest = nil }
            }
            self.pendingRequest = request
            request.start()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pendingRequest?.cancel()
            call.resolve()
        }
    }

    private static func isChallengeValue(_ value: String) -> Bool {
        guard value.utf8.count == 43,
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
                  || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { return false }
        let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let bytes = Data(base64Encoded: base64 + "="), bytes.count == 32 else { return false }
        return bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value
    }
}

// AuthenticationServices keeps weak delegates, so the plugin owns this operation until completion.
private final class LudolumeAppleAuthorization: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private var call: CAPPluginCall?
    private let window: UIWindow
    private let state: String
    private let controller: ASAuthorizationController
    private let onComplete: (LudolumeAppleAuthorization) -> Void
    private var finished = false

    init(call: CAPPluginCall, window: UIWindow, nonce: String, state: String,
         onComplete: @escaping (LudolumeAppleAuthorization) -> Void) {
        self.call = call
        self.window = window
        self.state = state
        self.onComplete = onComplete
        let request = ASAuthorizationAppleIDProvider().createRequest()
        // Signup uses only Apple's signed email claim; a profile name is unnecessary.
        request.requestedScopes = [.email]
        request.nonce = nonce
        request.state = state
        controller = ASAuthorizationController(authorizationRequests: [request])
        super.init()
        controller.delegate = self
        controller.presentationContextProvider = self
    }

    func start() {
        controller.performRequests()
    }

    func cancel() {
        call?.reject("Native sign-in was cancelled.", "CANCELLED")
        call = nil
        if #available(iOS 16.0, *) {
            controller.cancel()
            finish()
        }
        // iOS 15 cannot cancel this UI. Discard its eventual result and retain the
        // operation until dismissal, preventing another overlapping sign-in sheet.
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        window
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        DispatchQueue.main.async {
            defer { self.finish() }
            guard !self.finished, let call = self.call else { return }
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  credential.state == self.state,
                  let tokenData = credential.identityToken, !tokenData.isEmpty, tokenData.count <= 16_384,
                  let identityToken = String(data: tokenData, encoding: .utf8),
                  let codeData = credential.authorizationCode, !codeData.isEmpty, codeData.count <= 4_096,
                  codeData.allSatisfy({ (33...126).contains($0) }),
                  let authorizationCode = String(data: codeData, encoding: .utf8) else {
                call.reject("Invalid native sign-in response.", "INVALID_RESPONSE")
                return
            }
            // The server verifies the token and exchanges the short-lived code; neither is persisted here.
            call.resolve(["identityToken": identityToken, "authorizationCode": authorizationCode])
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        DispatchQueue.main.async {
            defer { self.finish() }
            guard !self.finished, let call = self.call else { return }
            let cancelled = (error as? ASAuthorizationError)?.code == .canceled
            call.reject(cancelled ? "Native sign-in was cancelled." : "Native sign-in failed.",
                        cancelled ? "CANCELLED" : "UNAVAILABLE")
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        call = nil
        controller.delegate = nil
        controller.presentationContextProvider = nil
        onComplete(self)
    }
}
