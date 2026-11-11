import Foundation

public struct ServerReadyPayload: Codable, Sendable {
    public let port: Int
    public let host: String
    public let url: String
    public let pid: Int32
}

/// Resolves bundled Node.js runtime and application server scripts inside `ArtifactAtlas.app/Contents/Resources`,
/// with fallback to repository paths during local development.
public struct BundledRuntimeResolver {
    public let nodeExecutableURL: URL
    public let cliScriptURL: URL
    public let isBundledApp: Bool

    public init(bundle: Bundle = .main) throws {
        let fm = FileManager.default

        // 1. Check inside ArtifactAtlas.app/Contents/Resources
        if let resourceURL = bundle.resourceURL {
            let bundledNode = resourceURL.appendingPathComponent("runtime/node")
            let bundledCli = resourceURL.appendingPathComponent("app/src/cli.js")
            if fm.isExecutableFile(atPath: bundledNode.path) && fm.fileExists(atPath: bundledCli.path) {
                self.nodeExecutableURL = bundledNode
                self.cliScriptURL = bundledCli
                self.isBundledApp = true
                return
            }
        }

        // 2. Check relative to executable path (e.g. Contents/MacOS/../Resources)
        if let execURL = bundle.executableURL {
            let contentsURL = execURL.deletingLastPathComponent().deletingLastPathComponent()
            let resURL = contentsURL.appendingPathComponent("Resources")
            let bundledNode = resURL.appendingPathComponent("runtime/node")
            let bundledCli = resURL.appendingPathComponent("app/src/cli.js")
            if fm.isExecutableFile(atPath: bundledNode.path) && fm.fileExists(atPath: bundledCli.path) {
                self.nodeExecutableURL = bundledNode
                self.cliScriptURL = bundledCli
                self.isBundledApp = true
                return
            }
        }

        // 3. Development fallback (repository checkout)
        let cwd = URL(fileURLWithPath: fm.currentDirectoryPath)
        let devCli = cwd.appendingPathComponent("src/cli.js")
        let candidateNodes = [
            ProcessInfo.processInfo.environment["ATLAS_NODE_BINARY"],
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ].compactMap { $0 }

        if fm.fileExists(atPath: devCli.path),
           let foundNode = candidateNodes.first(where: { fm.isExecutableFile(atPath: $0) }) {
            self.nodeExecutableURL = URL(fileURLWithPath: foundNode)
            self.cliScriptURL = devCli
            self.isBundledApp = false
            return
        }

        throw NSError(
            domain: "ArtifactAtlasRuntime",
            code: 1001,
            userInfo: [
                NSLocalizedDescriptionKey: "Bundled Node.js runtime or src/cli.js was not found inside the application bundle."
            ]
        )
    }
}

/// Launches, monitors, authenticates, and cleanly terminates the local loopback backend process.
public final class BackendProcessManager {
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?

    public private(set) var serverPayload: ServerReadyPayload?
    public let apiToken: String
    public let dataDirectoryURL: URL

    public init(dataDirectoryURL: URL? = nil) {
        let tokenPartA = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let tokenPartB = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        self.apiToken = tokenPartA + tokenPartB

        if let customDir = dataDirectoryURL {
            self.dataDirectoryURL = customDir
        } else if let envDir = ProcessInfo.processInfo.environment["ATLAS_DATA_DIR"], !envDir.isEmpty {
            self.dataDirectoryURL = URL(fileURLWithPath: envDir)
        } else {
            let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.dataDirectoryURL = appSupport.appendingPathComponent("ArtifactAtlas", isDirectory: true)
        }
    }

    public var authenticatedWebURL: URL? {
        guard let payload = serverPayload else { return nil }
        return URL(string: "http://127.0.0.1:\(payload.port)/?token=\(apiToken)")
    }

    public func start(timeoutSeconds: TimeInterval = 15.0) throws -> ServerReadyPayload {
        if let existing = serverPayload, let proc = process, proc.isRunning {
            return existing
        }

        try FileManager.default.createDirectory(at: dataDirectoryURL, withIntermediateDirectories: true)

        let resolver = try BundledRuntimeResolver()
        let proc = Process()
        proc.executableURL = resolver.nodeExecutableURL
        proc.currentDirectoryURL = resolver.cliScriptURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()

        let parentPid = ProcessInfo.processInfo.processIdentifier
        proc.arguments = [
            resolver.cliScriptURL.path,
            "serve",
            "--port", "0",
            "--data-dir", dataDirectoryURL.path,
            "--api-token", apiToken,
            "--parent-pid", "\(parentPid)",
            "--watch-stdin"
        ]

        var env = ProcessInfo.processInfo.environment
        env["ATLAS_API_TOKEN"] = apiToken
        env["ATLAS_DATA_DIR"] = dataDirectoryURL.path
        env["NO_UPDATE_NOTIFIER"] = "1"
        proc.environment = env

        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        self.stdinPipe = inPipe
        self.stdoutPipe = outPipe
        self.stderrPipe = errPipe
        self.process = proc

        let semaphore = DispatchSemaphore(value: 0)
        var capturedPayload: ServerReadyPayload?
        var accumulatedOutput = ""
        let lock = NSLock()

        outPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            lock.lock()
            accumulatedOutput += chunk
            let lines = accumulatedOutput.components(separatedBy: .newlines)
            for line in lines {
                if line.hasPrefix("ATLAS_SERVER_READY:") {
                    let jsonPart = String(line.dropFirst("ATLAS_SERVER_READY:".count))
                    if let jsonData = jsonPart.data(using: .utf8),
                       let parsed = try? JSONDecoder().decode(ServerReadyPayload.self, from: jsonData),
                       capturedPayload == nil {
                        capturedPayload = parsed
                        semaphore.signal()
                    }
                }
            }
            lock.unlock()
        }

        try proc.run()

        let waitResult = semaphore.wait(timeout: .now() + timeoutSeconds)
        outPipe.fileHandleForReading.readabilityHandler = nil

        guard waitResult == .success, let ready = capturedPayload else {
            stop()
            let stderrData = errPipe.fileHandleForReading.availableData
            let stderrText = String(data: stderrData, encoding: .utf8) ?? ""
            throw NSError(
                domain: "ArtifactAtlasRuntime",
                code: 1002,
                userInfo: [
                    NSLocalizedDescriptionKey: "Timed out waiting for local loopback backend to start. Stderr: \(stderrText)"
                ]
            )
        }

        self.serverPayload = ready
        return ready
    }

    public func stop() {
        // Closing stdin signals --watch-stdin in the child process immediately
        try? stdinPipe?.fileHandleForWriting.close()
        stdinPipe = nil

        if let proc = process, proc.isRunning {
            proc.terminate()
            let deadline = Date().addingTimeInterval(2.0)
            while proc.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if proc.isRunning {
                kill(proc.processIdentifier, SIGKILL)
            }
        }
        process = nil
        serverPayload = nil
    }

    deinit {
        stop()
    }
}
