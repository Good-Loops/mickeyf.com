import Foundation
import Capacitor
import WebKit

class LudolumeBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(LudolumeApiPlugin())
        bridge?.registerPluginInstance(LudolumeIdentityPlugin())
    }
}

@objc(LudolumeApiPlugin)
public class LudolumeApiPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LudolumeApiPlugin"
    public let jsName = "LudolumeApi"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "nativeRequest", returnType: CAPPluginReturnPromise)
    ]
    private var pendingPosts: [() -> Void] = []
    private var postIsActive = false

    @objc func nativeRequest(_ call: CAPPluginCall) {
        guard let request = LudolumeApiPolicy.request(from: call) else {
            call.reject("Unsupported native API request.", "INVALID_REQUEST")
            return
        }
        guard request.httpMethod == "POST" else {
            startRequest(call, request: request, onComplete: {})
            return
        }
        // Preserve mutation order so a late login cannot recreate a cookie after logout.
        DispatchQueue.main.async {
            self.pendingPosts.append {
                self.startRequest(call, request: request, onComplete: self.completePost)
            }
            self.startNextPost()
        }
    }

    private func startNextPost() {
        guard !postIsActive, !pendingPosts.isEmpty else { return }
        postIsActive = true
        pendingPosts.removeFirst()()
    }

    private func completePost() {
        DispatchQueue.main.async {
            self.postIsActive = false
            self.startNextPost()
        }
    }

    private func startRequest(_ call: CAPPluginCall, request: URLRequest, onComplete: @escaping () -> Void) {
        let operation = LudolumeApiRequest(call: call, request: request, onComplete: onComplete)
        // The server needs the cookie to revoke this device's session.
        operation.start()
    }
}

private enum LudolumeApiPolicy {
    static let host = "mickeyf-org-j7yuum4tiq-uc.a.run.app"
    static let origin = "https://\(host)"
    static let maximumRequestBytes = 32 * 1024
    static let maximumResponseBytes = 1024 * 1024
    static let routes: Set<String> = [
        "POST /api/users",
        "GET /auth/verify-token",
        "POST /auth/logout",
        "POST /auth/renew",
        "POST /auth/delete-account",
        "GET /auth/providers/config",
        "GET /auth/providers/account",
        "POST /auth/providers/begin",
        "POST /auth/providers/complete",
        "GET /api/leaderboards",
        "GET /api/leaderboards/p4-vega",
        "GET /api/leaderboards/three-bosses",
        "POST /api/leaderboards/three-bosses/run-tickets",
        "POST /api/leaderboards/three-bosses/runs"
    ]

    static func request(from call: CAPPluginCall) -> URLRequest? {
        guard let address = call.getString("url"), address.utf8.count <= 512,
              let method = call.getString("method"),
              let components = URLComponents(string: address),
              components.scheme == "https", components.host == host,
              components.port == nil, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              address == origin + components.path,
              routes.contains("\(method) \(components.path)"),
              let url = components.url else { return nil }

        let body = call.getString("body")
        guard call.options["body"] == nil || body != nil else { return nil }
        guard method != "GET" || body == nil else { return nil }
        let bodyData = body.map { Data($0.utf8) }
        guard (bodyData?.count ?? 0) <= maximumRequestBytes else { return nil }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = method
        request.httpBody = bodyData
        request.httpShouldHandleCookies = true
        request.setValue("capacitor://localhost", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if bodyData != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private static func isSessionCookie(_ cookie: HTTPCookie) -> Bool {
        cookie.name == "session" && cookie.domain == host && cookie.path == "/"
    }

    static func clearSessionCookie(completion: @escaping () -> Void) {
        // Called only after confirmed logout or account deletion.
        HTTPCookieStorage.shared.cookies?.filter(isSessionCookie)
            .forEach { HTTPCookieStorage.shared.deleteCookie($0) }
        DispatchQueue.main.async {
            let cookieStore = WKWebsiteDataStore.default().httpCookieStore
            cookieStore.getAllCookies { cookies in
                let deletion = DispatchGroup()
                for cookie in cookies where isSessionCookie(cookie) {
                    deletion.enter()
                    cookieStore.delete(cookie) { deletion.leave() }
                }
                // Delete stale WebView copies, never import them into the native session jar.
                deletion.notify(queue: .main, execute: completion)
            }
        }
    }
}

// Each request owns a serial URLSession delegate queue; response state never crosses requests.
private final class LudolumeApiRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let call: CAPPluginCall
    private let request: URLRequest
    private let onComplete: () -> Void
    private var session: URLSession?
    private var response: HTTPURLResponse?
    private var body = Data()
    private var finished = false

    init(call: CAPPluginCall, request: URLRequest, onComplete: @escaping () -> Void) {
        self.call = call
        self.request = request
        self.onComplete = onComplete
        super.init()
    }

    func start() {
        let configuration = URLSessionConfiguration.default
        // Foundation owns the persistent HttpOnly cookies; none are exposed to JavaScript.
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        session.dataTask(with: request).resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        reject("Native API redirects are not allowed.", code: "INVALID_RESPONSE")
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard !finished else {
            completionHandler(.cancel)
            return
        }
        guard let response = response as? HTTPURLResponse,
              response.url == request.url,
              !(300...399).contains(response.statusCode),
              response.expectedContentLength <= Int64(LudolumeApiPolicy.maximumResponseBytes) else {
            completionHandler(.cancel)
            reject("Invalid native API response.", code: "INVALID_RESPONSE")
            return
        }
        self.response = response
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished else { return }
        guard data.count <= LudolumeApiPolicy.maximumResponseBytes - body.count else {
            reject("Native API response exceeded the size limit.", code: "INVALID_RESPONSE")
            return
        }
        body.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        guard error == nil else {
            // Transport diagnostics can contain request details; return only a fixed message.
            reject("Unable to reach the API service.", code: "NETWORK_ERROR")
            return
        }
        guard let response = response, let text = String(data: body, encoding: .utf8) else {
            reject("Invalid native API response.", code: "INVALID_RESPONSE")
            return
        }
        finished = true
        session.finishTasksAndInvalidate()
        self.session = nil
        let finish = {
            // Never pass response headers or cookie values through the Capacitor bridge.
            self.call.resolve(["status": response.statusCode, "body": text])
            self.onComplete()
        }
        // Preserve credentials on network/server failure so the user can retry revocation.
        if response.statusCode == 200,
           let result = try? JSONDecoder().decode([String: Bool].self, from: body),
           (request.url?.path == "/auth/delete-account" && result == ["deleted": true])
            || (request.url?.path == "/auth/logout" && result == ["loggedOut": true]) {
            LudolumeApiPolicy.clearSessionCookie(completion: finish)
        } else {
            finish()
        }
    }

    private func reject(_ message: String, code: String) {
        guard !finished else { return }
        finished = true
        call.reject(message, code)
        session?.invalidateAndCancel()
        session = nil
        onComplete()
    }
}
