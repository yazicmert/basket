import Foundation
import SQLite3

public enum ArtifactAtlasError: Error, LocalizedError {
    case invalidAppBundle(String)
    case protectedPathRejected(String)
    case symlinkBoundaryViolation(String)
    case fileChangedSinceScan(String)
    case confirmationRequired
    case restoreConflictExists(String)

    public var errorDescription: String? {
        switch self {
        case .invalidAppBundle(let msg): return "Invalid .app bundle: \(msg)"
        case .protectedPathRejected(let path): return "Protected system or credential path rejected: \(path)"
        case .symlinkBoundaryViolation(let path): return "Symlink escapes authorized scan boundary: \(path)"
        case .fileChangedSinceScan(let msg): return "File mutated between scan and cleanup: \(msg)"
        case .confirmationRequired: return "Explicit confirmation token is required before quarantine."
        case .restoreConflictExists(let path): return "A file already exists at restore destination: \(path)"
        }
    }
}

public final class MacOSPlatformServices {
    public let homeDirectoryURL: URL

    public init(homeDirectoryURL: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.homeDirectoryURL = homeDirectoryURL
    }

    public func isProtectedPath(_ path: String) -> Bool {
        let protectedPrefixes = [
            "/System", "/bin", "/sbin", "/usr", "/etc", "/Library/Apple",
            "/Library/Application Support/com.apple.TCC"
        ]
        for prefix in protectedPrefixes where path == prefix || path.hasPrefix(prefix + "/") {
            return true
        }
        let homeRelatives = [".ssh", ".gnupg", ".aws", ".kube", "Library/Keychains"]
        for rel in homeRelatives {
            let full = homeDirectoryURL.appendingPathComponent(rel).path
            if path == full || path.hasPrefix(full + "/") {
                return true
            }
        }
        return false
    }

    public func inspectPOSIXEntry(at path: String, authorizedRoots: [String]) -> (
        allowed: Bool,
        isSymlink: Bool,
        isDirectory: Bool,
        sizeBytes: Int64,
        inodeKey: String,
        hardlinkCount: Int,
        mode: UInt16,
        mtimeSeconds: Double
    ) {
        if isProtectedPath(path) {
            return (false, false, false, 0, "", 0, 0, 0)
        }
        var st = stat()
        guard lstat(path, &st) == 0 else {
            return (false, false, false, 0, "", 0, 0, 0)
        }
        let fileType = st.st_mode & S_IFMT
        let isSymlink = fileType == S_IFLNK
        let isDir = fileType == S_IFDIR
        if isSymlink {
            return (false, true, false, 0, "", 0, 0, 0)
        }
        let inodeKey = "\(st.st_dev):\(st.st_ino)"
        let mtime = Double(st.st_mtimespec.tv_sec) + Double(st.st_mtimespec.tv_nsec) / 1_000_000_000.0
        return (
            true,
            false,
            isDir,
            Int64(st.st_size),
            inodeKey,
            Int(st.st_nlink),
            UInt16(st.st_mode),
            mtime
        )
    }
}

public final class MacOSApplicationDiscovery {
    private let platformServices: MacOSPlatformServices

    public init(platformServices: MacOSPlatformServices) {
        self.platformServices = platformServices
    }

    /// Passively reads Contents/Info.plist without executing the .app bundle.
    public func identifyAppBundle(at bundleURL: URL) throws -> ApplicationModel {
        let path = bundleURL.path
        guard path.hasSuffix(".app") else {
            throw ArtifactAtlasError.invalidAppBundle(path)
        }

        let infoPlistURL = bundleURL.appendingPathComponent("Contents/Info.plist")
        var plistDict: [String: Any] = [:]
        if let data = try? Data(contentsOf: infoPlistURL),
           let parsed = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] {
            plistDict = parsed
        }

        let fallbackName = bundleURL.deletingPathExtension().lastPathComponent
        let name = (plistDict["CFBundleDisplayName"] as? String)
            ?? (plistDict["CFBundleName"] as? String)
            ?? fallbackName
        let bundleId = plistDict["CFBundleIdentifier"] as? String
        let execName = (plistDict["CFBundleExecutable"] as? String) ?? fallbackName
        let execURL = bundleURL.appendingPathComponent("Contents/MacOS/\(execName)")
        let version = (plistDict["CFBundleShortVersionString"] as? String)
            ?? (plistDict["CFBundleVersion"] as? String)
            ?? "Unknown"
        let copyright = plistDict["NSHumanReadableCopyright"] as? String

        let lowerId = (bundleId ?? "").lowercased()
        let lowerName = name.lowercased()
        let adapterId: String
        let isSupported: Bool

        if lowerId.contains("anthropic.claude") || lowerName.contains("claude") {
            adapterId = "claude-code"
            isSupported = true
        } else if lowerId.contains("230313mzl4w4u92") || lowerName.contains("cursor") {
            adapterId = "cursor-ide"
            isSupported = true
        } else if lowerId.contains("openai.codex") || lowerName.contains("codex") {
            adapterId = "codex-cli"
            isSupported = true
        } else {
            adapterId = "generic-macos-app"
            isSupported = false
        }

        let home = platformServices.homeDirectoryURL
        var dirs: [CandidateDataDirectory] = [
            CandidateDataDirectory(role: "APP_SUPPORT", path: home.appendingPathComponent("Library/Application Support/\(name)").path),
            CandidateDataDirectory(role: "CACHES", path: home.appendingPathComponent("Library/Caches/\(bundleId ?? name)").path),
            CandidateDataDirectory(role: "LOGS", path: home.appendingPathComponent("Library/Logs/\(name)").path)
        ]
        if adapterId == "claude-code" {
            dirs.insert(CandidateDataDirectory(role: "CLAUDE_HOME", path: home.appendingPathComponent(".claude").path), at: 0)
        } else if adapterId == "codex-cli" {
            dirs.insert(CandidateDataDirectory(role: "CODEX_HOME", path: home.appendingPathComponent(".codex").path), at: 0)
        }

        return ApplicationModel(
            id: "app_\(bundleId ?? name)",
            name: name,
            bundleId: bundleId,
            bundlePath: path,
            executablePath: FileManager.default.fileExists(atPath: execURL.path) ? execURL.path : nil,
            version: version,
            copyright: copyright,
            adapterId: adapterId,
            isSupportedAIApp: isSupported,
            recognitionStatus: isSupported ? "VERIFIED_AI_ADAPTER" : "GENERIC_MACOS_ADAPTER",
            knownDataDirectories: dirs
        )
    }
}

public final class MacOSArtifactClassifier {
    public init() {}

    public func classify(path: String, hasSharedDependencies: Bool, provenance: ProvenanceConfidence) -> (ArtifactType, RiskCategory, String, String) {
        let lower = path.lowercased()
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        let name = URL(fileURLWithPath: path).lastPathComponent.lowercased()

        if lower.contains("/.git/") || name == ".gitignore" {
            return (.userContent, .protected, "Protected Git metadata.", "Corrupts repository history.")
        }
        if name.hasPrefix(".env") || ["pem", "key", "p12"].contains(ext) {
            return (.userContent, .protected, "Credential or secret file.", "Breaks authentication or loses keys.")
        }
        if ["package.json", "tsconfig.json", "package.swift", "cargo.toml"].contains(name) {
            return (.userContent, .protected, "Project configuration manifest.", "Breaks project build configuration.")
        }
        if (lower.contains("/.claude/projects/") || lower.contains("/.codex/sessions/")) && ext == "jsonl" {
            return (.sessionHistory, .high, "Authoritative AI session transcript.", "Removes conversation history and provenance ledger.")
        }
        if lower.contains("/checkpoints/") || ext == "ckpt" {
            return (.checkpoint, .high, "Workspace or model checkpoint.", "Prevents state rollback.")
        }
        if ["gguf", "safetensors", "onnx", "mlx"].contains(ext) || lower.contains("/models/") {
            return (.modelData, .high, "Local model weights or dataset.", "Requires re-downloading or loses weights.")
        }
        if lower.contains("/dist/") || lower.contains("/build/") || lower.contains("/deriveddata/") {
            return (ext == "map" ? .derivedData : .buildOutput, .review, "Compiled build output.", "Requires rebuilding project.")
        }
        if lower.contains("/library/caches/") || lower.contains("/.claude/statsig/") || lower.contains("/cacheddata/") {
            let risk: RiskCategory = hasSharedDependencies ? .review : .low
            return (.regenerableCache, risk, "Dedicated application cache container.", "Rebuilt automatically on next launch.")
        }
        if lower.contains("/library/logs/") || lower.contains("/.claude/debug/") || ext == "log" {
            let safeContainer = (lower.contains("/library/logs/") || lower.contains("/.claude/debug/")) && !hasSharedDependencies && provenance != .unknown
            return (.log, safeContainer ? .low : .review, "Diagnostic log file.", "Moves historical log trace to quarantine.")
        }
        if lower.contains("/.claude/shell-snapshots/") || lower.contains("/.codex/tmp/") || ext == "tmp" {
            let safeContainer = (lower.contains("/.claude/shell-snapshots/") || lower.contains("/.codex/tmp/")) && !hasSharedDependencies && provenance != .unknown
            return (.tempFile, safeContainer ? .low : .review, "Temporary file evaluated by container context (never extension alone).", "Reclaims scratch space.")
        }
        if ["swift", "ts", "js", "py", "rs", "md"].contains(ext) || lower.contains("/src/") || lower.contains("/sources/") {
            return (.userContent, .protected, "Project source code or documentation.", "Permanent loss of source code if deleted.")
        }
        return (.unknown, .high, "Unclassified artifact with uncertain dependencies.", "Inspect manually before quarantine.")
    }
}
