import SwiftUI
import AppKit
import WebKit
import UniformTypeIdentifiers
import ArtifactAtlasCore

@main
struct ArtifactAtlasMain {
    static func main() {
        if CommandLine.arguments.contains("--verify-workflow") {
            let exitCode = PackagedAppSelfVerifier.runFullWorkflowVerification()
            exit(exitCode)
        } else {
            ArtifactAtlasDesktopApp.main()
        }
    }
}

final class AtlasAppDelegate: NSObject, NSApplicationDelegate {
    let backendManager = BackendProcessManager()

    func applicationWillTerminate(_ notification: Notification) {
        backendManager.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

struct ArtifactAtlasDesktopApp: App {
    @NSApplicationDelegateAdaptor(AtlasAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("Artifact Atlas") {
            ArtifactAtlasRootView(backendManager: appDelegate.backendManager)
                .frame(minWidth: 1120, minHeight: 740)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Choose AI Application (.app)…") {
                    NotificationCenter.default.post(name: .atlasChooseApplication, object: nil)
                }
                .keyboardShortcut("o", modifiers: [.command])

                Button("Select Project Workspace Directory…") {
                    NotificationCenter.default.post(name: .atlasChooseWorkspace, object: nil)
                }
                .keyboardShortcut("o", modifiers: [.command, .shift])
            }
        }
    }
}

extension Notification.Name {
    static let atlasChooseApplication = Notification.Name("atlasChooseApplication")
    static let atlasChooseWorkspace = Notification.Name("atlasChooseWorkspace")
}

final class WebViewCoordinator: NSObject, WKNavigationDelegate {
    weak var webView: WKWebView?

    func sendDroppedAppPath(_ path: String) {
        guard let encoded = try? JSONEncoder().encode(path),
              let jsonString = String(data: encoded, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.handleNativeMacOSAppDrop && window.handleNativeMacOSAppDrop(\(jsonString));", completionHandler: nil)
    }

    func sendPickedWorkspacePath(_ path: String) {
        guard let encoded = try? JSONEncoder().encode(path),
              let jsonString = String(data: encoded, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.handleNativeMacOSWorkspacePicked && window.handleNativeMacOSWorkspacePicked(\(jsonString));", completionHandler: nil)
    }
}

struct AtlasWebViewContainer: NSViewRepresentable {
    let url: URL
    let coordinator: WebViewCoordinator

    func makeCoordinator() -> WebViewCoordinator {
        coordinator
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

struct ArtifactAtlasRootView: View {
    let backendManager: BackendProcessManager

    @State private var webURL: URL?
    @State private var startupError: String?
    @State private var isDropTargeted: Bool = false
    @State private var coordinator = WebViewCoordinator()

    var body: some View {
        ZStack {
            if let url = webURL {
                AtlasWebViewContainer(url: url, coordinator: coordinator)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(isDropTargeted ? Color.accentColor : Color.clear, lineWidth: 3)
                            .padding(4)
                    )
                    .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
                        handleNativeDrop(providers: providers)
                    }
            } else if let error = startupError {
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(.orange)
                    Text("Artifact Atlas Engine Startup Error")
                        .font(.title3.bold())
                    Text(error)
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 560)
                    Button("Retry Launch") {
                        startupError = nil
                        launchBackend()
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding(32)
            } else {
                VStack(spacing: 14) {
                    ProgressView()
                        .controlSize(.large)
                    Text("Starting Artifact Atlas Local Provenance Engine…")
                        .font(.headline)
                    Text("Initializing loopback service and SQLite index.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(32)
            }
        }
        .onAppear {
            launchBackend()
        }
        .onReceive(NotificationCenter.default.publisher(for: .atlasChooseApplication)) { _ in
            presentNativeAppPicker()
        }
        .onReceive(NotificationCenter.default.publisher(for: .atlasChooseWorkspace)) { _ in
            presentNativeWorkspacePicker()
        }
    }

    private func launchBackend() {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                _ = try backendManager.start()
                let authURL = backendManager.authenticatedWebURL
                DispatchQueue.main.async {
                    self.webURL = authURL
                }
            } catch {
                DispatchQueue.main.async {
                    self.startupError = error.localizedDescription
                }
            }
        }
    }

    private func handleNativeDrop(providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            let fileURL: URL?
            if let data = item as? Data {
                fileURL = URL(dataRepresentation: data, relativeTo: nil)
            } else if let url = item as? URL {
                fileURL = url
            } else {
                fileURL = nil
            }
            guard let resolved = fileURL else { return }
            DispatchQueue.main.async {
                if resolved.path.hasSuffix(".app") {
                    coordinator.sendDroppedAppPath(resolved.path)
                } else {
                    coordinator.sendPickedWorkspacePath(resolved.path)
                }
            }
        }
        return true
    }

    private func presentNativeAppPicker() {
        let panel = NSOpenPanel()
        panel.title = "Choose an AI Application (.app)"
        panel.allowedContentTypes = [.applicationBundle]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        if panel.runModal() == .OK, let url = panel.url {
            coordinator.sendDroppedAppPath(url.path)
        }
    }

    private func presentNativeWorkspacePicker() {
        let panel = NSOpenPanel()
        panel.title = "Select Project Workspace Directory"
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        if panel.runModal() == .OK, let url = panel.url {
            coordinator.sendPickedWorkspacePath(url.path)
        }
    }
}

/// Executes an automated end-to-end verification of the packaged `.app` bundle
/// against an isolated temporary sandbox (Requirement 17 & 18).
enum PackagedAppSelfVerifier {
    static func runFullWorkflowVerification() -> Int32 {
        let fm = FileManager.default
        let tempSandbox = fm.temporaryDirectory.appendingPathComponent("artifact-atlas-app-verify-\(UUID().uuidString)")
        defer {
            try? fm.removeItem(at: tempSandbox)
        }

        let manager = BackendProcessManager(dataDirectoryURL: tempSandbox)
        do {
            print("[Verify 1/6] Launching bundled Node.js backend from ArtifactAtlas.app...")
            let ready = try manager.start(timeoutSeconds: 20.0)
            let childPid = ready.pid
            print("   -> Loopback server ready at \(ready.url) (PID \(childPid))")

            let baseURL = URL(string: ready.url)!
            let token = manager.apiToken

            // Verify unauthenticated request is rejected with 401
            let (_, unauthResp) = try performRequest(url: baseURL.appendingPathComponent("api/bootstrap"), method: "GET", token: nil, body: nil)
            guard unauthResp.statusCode == 401 else {
                print("ERROR: Expected 401 for unauthenticated /api/bootstrap request, got \(unauthResp.statusCode)")
                manager.stop()
                return 1
            }
            print("   -> Confirmed local API token protection (unauthenticated request blocked with HTTP 401)")

            // 1. Bootstrap and find demo Claude.app
            let (bootData, _) = try performRequest(url: baseURL.appendingPathComponent("api/bootstrap"), method: "GET", token: token, body: nil)
            guard let bootJson = try JSONSerialization.jsonObject(with: bootData) as? [String: Any],
                  let bundles = bootJson["availableBundles"] as? [[String: Any]],
                  let claudeBundle = bundles.first(where: { ($0["name"] as? String) == "Claude Code" }),
                  let claudePath = claudeBundle["bundlePath"] as? String else {
                print("ERROR: Could not locate Claude.app fixture in bootstrap response")
                manager.stop()
                return 1
            }

            // 2. Drop / Identify Claude.app
            print("[Verify 2/6] Identifying dropped Claude.app bundle without executing binary...")
            let (idData, _) = try performRequest(
                url: baseURL.appendingPathComponent("api/app/identify"),
                method: "POST",
                token: token,
                body: ["bundlePath": claudePath]
            )
            guard let idJson = try JSONSerialization.jsonObject(with: idData) as? [String: Any],
                  let appObj = idJson["application"] as? [String: Any],
                  (appObj["bundleId"] as? String) == "com.anthropic.claudefordesktop" else {
                print("ERROR: Application identification failed")
                manager.stop()
                return 1
            }
            print("   -> Identified \(appObj["name"] ?? "") (\(appObj["bundleId"] ?? ""))")

            // 3. Scan & Build Knowledge Graph
            print("[Verify 3/6] Running permission-aware scan & building Knowledge Graph...")
            let (scanData, _) = try performRequest(
                url: baseURL.appendingPathComponent("api/scan/start"),
                method: "POST",
                token: token,
                body: ["bundlePath": claudePath]
            )
            guard let scanJson = try JSONSerialization.jsonObject(with: scanData) as? [String: Any],
                  let stateObj = scanJson["state"] as? [String: Any],
                  let artifacts = stateObj["artifacts"] as? [[String: Any]],
                  let graphObj = stateObj["graph"] as? [String: Any],
                  let nodes = graphObj["nodes"] as? [[String: Any]] else {
                print("ERROR: Scan or graph construction failed")
                manager.stop()
                return 1
            }
            print("   -> Indexed \(artifacts.count) artifacts and constructed \(nodes.count) graph nodes")

            // 4. Inspect Provenance
            print("[Verify 4/6] Tracing provenance paths for low-risk artifact...")
            guard let lowRiskArtifact = artifacts.first(where: { ($0["cleanupClassification"] as? String) == "LOW" }),
                  let lowRiskId = lowRiskArtifact["id"] as? String else {
                print("ERROR: No LOW risk artifact found")
                manager.stop()
                return 1
            }
            let (traceData, _) = try performRequest(
                url: baseURL.appendingPathComponent("api/graph/trace"),
                method: "POST",
                token: token,
                body: ["nodeId": lowRiskId]
            )
            guard let traceJson = try JSONSerialization.jsonObject(with: traceData) as? [String: Any],
                  let traceObj = traceJson["trace"] as? [String: Any],
                  let hops = traceObj["provenanceHops"] as? [[String: Any]],
                  !hops.isEmpty else {
                print("ERROR: Provenance trace returned no hops")
                manager.stop()
                return 1
            }
            print("   -> Provenance traced across \(hops.count) hop(s)")

            // 5. Review Cleanup & Move to Quarantine
            print("[Verify 5/6] Reviewing cleanup and quarantining test artifact...")
            let (revData, _) = try performRequest(
                url: baseURL.appendingPathComponent("api/cleanup/review"),
                method: "POST",
                token: token,
                body: ["artifactIds": [lowRiskId]]
            )
            guard let revJson = try JSONSerialization.jsonObject(with: revData) as? [String: Any],
                  let reviewObj = revJson["review"] as? [String: Any],
                  let confirmToken = reviewObj["confirmationToken"] as? String else {
                print("ERROR: Cleanup review failed to produce confirmationToken")
                manager.stop()
                return 1
            }

            let (quarData, _) = try performRequest(
                url: baseURL.appendingPathComponent("api/cleanup/quarantine"),
                method: "POST",
                token: token,
                body: [
                    "artifactIds": [lowRiskId],
                    "confirmationToken": confirmToken
                ]
            )
            guard let quarJson = try JSONSerialization.jsonObject(with: quarData) as? [String: Any],
                  let qEntries = quarJson["quarantinedEntries"] as? [[String: Any]],
                  let firstEntry = qEntries.first,
                  let entryId = firstEntry["id"] as? String else {
                print("ERROR: Quarantine execution failed")
                manager.stop()
                return 1
            }
            print("   -> Quarantined entry \(entryId)")

            // 6. Restore from Quarantine
            print("[Verify 6/6] Restoring quarantined artifact and shutting down backend...")
            let (restData, _) = try performRequest(
                url: baseURL.appendingPathComponent("api/cleanup/restore"),
                method: "POST",
                token: token,
                body: [
                    "entryId": entryId,
                    "conflictStrategy": "FAIL_IF_EXISTS"
                ]
            )
            guard let restJson = try JSONSerialization.jsonObject(with: restData) as? [String: Any],
                  (restJson["restored"] as? Bool) == true else {
                print("ERROR: Restore failed")
                manager.stop()
                return 1
            }
            print("   -> Restored to \(restJson["restoredToPath"] ?? "")")

            // Stop backend and verify child process is terminated
            manager.stop()
            Thread.sleep(forTimeInterval: 0.25)
            if kill(childPid, 0) == 0 {
                print("ERROR: Child backend process \(childPid) still alive after stop()")
                return 1
            }
            print("   -> Confirmed child backend process \(childPid) terminated cleanly.")
            print("PACKAGED_APP_WORKFLOW_VERIFIED: OK")
            return 0
        } catch {
            print("ERROR: \(error.localizedDescription)")
            manager.stop()
            return 1
        }
    }

    private static func performRequest(
        url: URL,
        method: String,
        token: String?,
        body: [String: Any]?
    ) throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let token {
            req.setValue(token, forHTTPHeaderField: "X-Atlas-Token")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let sem = DispatchSemaphore(value: 0)
        var outData: Data?
        var outResp: HTTPURLResponse?
        var outErr: Error?

        URLSession.shared.dataTask(with: req) { data, resp, err in
            outData = data
            outResp = resp as? HTTPURLResponse
            outErr = err
            sem.signal()
        }.resume()

        sem.wait()
        if let outErr { throw outErr }
        guard let d = outData, let r = outResp else {
            throw NSError(domain: "VerifyHTTP", code: -1)
        }
        return (d, r)
    }
}
