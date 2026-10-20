import UIKit
import Capacitor

/** Presentation state belongs to this controller/scene, never to the authentication plugins. */
final class LudolumePresentationPolicy {
    private var sessionId: String?
    private var retiredSessions = Set<String>()
    private var exhausted = false
    private var revision = 0
    private(set) var fullscreen = false

    func apply(active: Bool, sessionId: String, revision: Int) -> Bool {
        guard sessionId.utf8.count == 32,
              sessionId.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              revision > 0, revision <= 2_147_483_647 else { return false }
        guard !exhausted else { fullscreen = false; return false }
        if self.sessionId != sessionId {
            guard !active, !retiredSessions.contains(sessionId) else { return false }
            if let previous = self.sessionId {
                // Never let an old document reclaim the bridge. Keep memory bounded and fail closed.
                guard retiredSessions.count < 128 else { exhausted = true; fullscreen = false; return false }
                retiredSessions.insert(previous)
            }
            self.sessionId = sessionId
            self.revision = 0
        }
        guard revision > self.revision else { return false }
        self.revision = revision
        fullscreen = active
        return true
    }

    func orientations(for idiom: UIUserInterfaceIdiom) -> UIInterfaceOrientationMask {
        guard idiom == .phone else { return .all }
        return fullscreen ? .allButUpsideDown : .portrait
    }
}

@objc(LudolumePresentationPlugin)
public class LudolumePresentationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LudolumePresentationPlugin"
    public let jsName = "LudolumePresentation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setFullscreen", returnType: CAPPluginReturnPromise)
    ]

    @objc func setFullscreen(_ call: CAPPluginCall) {
        guard call.options.count == 3,
              let active = call.getBool("active"),
              let sessionId = call.getString("sessionId"),
              let revision = call.getInt("revision") else {
            call.reject("Invalid presentation request.", "INVALID_REQUEST")
            return
        }
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController as? LudolumeBridgeViewController else {
                call.reject("Presentation is unavailable.", "UNAVAILABLE")
                return
            }
            let applied = controller.presentationPolicy.apply(active: active, sessionId: sessionId, revision: revision)
            // iPad keeps multitasking; no RequiresFullScreen opt-out or orientation lock.
            if UIDevice.current.userInterfaceIdiom == .phone {
                if #available(iOS 16.0, *) {
                    controller.setNeedsUpdateOfSupportedInterfaceOrientations()
                    if let scene = controller.viewIfLoaded?.window?.windowScene {
                        let orientations = controller.presentationPolicy.orientations(for: .phone)
                        scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientations)) { _ in
                            // Keep the current mask even if UIKit cannot rotate this scene immediately.
                        }
                    }
                } else {
                    UIViewController.attemptRotationToDeviceOrientation()
                }
            }
            if applied { call.resolve() }
            else { call.reject("The presentation request is stale.", "STALE_REQUEST") }
        }
    }
}
