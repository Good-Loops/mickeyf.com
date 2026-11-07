import Foundation
import UIKit
import Capacitor
import DeclaredAgeRange

@objc(LudolumeAgePlugin)
public class LudolumeAgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LudolumeAgePlugin"
    public let jsName = "LudolumeAge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAgeRange", returnType: CAPPluginReturnPromise)
    ]
    private var requestIsActive = false

    @objc func requestAgeRange(_ call: CAPPluginCall) {
        guard call.options.count == 0 else {
            call.resolve(LudolumeAgeRangeResult.nonShared(.unavailable))
            return
        }
        Task { @MainActor in
            guard #available(iOS 26.0, *) else {
                call.resolve(LudolumeAgeRangeResult.nonShared(.unsupported))
                return
            }
            guard !self.requestIsActive,
                  let controller = self.bridge?.viewController,
                  let scene = controller.viewIfLoaded?.window?.windowScene,
                  scene.activationState == .foregroundActive,
                  controller.presentedViewController == nil,
                  !controller.isBeingPresented, !controller.isBeingDismissed else {
                call.resolve(LudolumeAgeRangeResult.nonShared(.unavailable))
                return
            }
            self.requestIsActive = true
            defer { self.requestIsActive = false }
            do {
                let response = try await AgeRangeService.shared.requestAgeRange(
                    ageGates: 13, 16, 18,
                    in: controller
                )
                switch response {
                case let .sharing(range):
                    call.resolve(LudolumeAgeRangeResult.shared(
                        lowerBound: range.lowerBound, exclusiveUpperBound: range.upperBound
                    ))
                case .declinedSharing:
                    call.resolve(LudolumeAgeRangeResult.nonShared(.notShared))
                @unknown default:
                    call.resolve(LudolumeAgeRangeResult.nonShared(.unavailable))
                }
            } catch {
                // Unknown errors never imply an adult age or consent to create an account.
                call.resolve(LudolumeAgeRangeResult.nonShared(.unavailable))
            }
        }
    }
}

// Kept independent of UIKit so the actual Swift normalization can also run in macOS tests.
enum LudolumeAgeRangeResult {
    enum NonSharedStatus: String {
        case notShared = "not-shared"
        case unsupported
        case unavailable
    }

    static func nonShared(_ status: NonSharedStatus) -> [String: Any] {
        ["status": status.rawValue, "minimumAge": NSNull(), "maximumAge": NSNull()]
    }

    static func shared(lowerBound: Int?, exclusiveUpperBound: Int?) -> [String: Any] {
        guard lowerBound != nil || exclusiveUpperBound != nil else { return nonShared(.unavailable) }
        if let lowerBound, !(0...150).contains(lowerBound) { return nonShared(.unavailable) }
        // Apple's upperBound discussion defines a gate exceeding the person's age.
        // Validate before subtraction, including overflow and empty-range cases.
        if let exclusiveUpperBound, !(1...151).contains(exclusiveUpperBound) { return nonShared(.unavailable) }
        let maximumAge = exclusiveUpperBound.map { $0 - 1 }
        if let lowerBound, let maximumAge, lowerBound > maximumAge { return nonShared(.unavailable) }
        return [
            "status": "shared",
            "minimumAge": lowerBound.map { $0 as Any } ?? NSNull(),
            "maximumAge": maximumAge.map { $0 as Any } ?? NSNull()
        ]
    }
}
