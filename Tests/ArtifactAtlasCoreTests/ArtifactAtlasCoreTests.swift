import XCTest
@testable import ArtifactAtlasCore

final class ArtifactAtlasCoreTests: XCTestCase {
    func testIdentifyMockClaudeAppBundleWithoutExecuting() throws {
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let bundleURL = tempDir.appendingPathComponent("Claude.app")
        let contentsURL = bundleURL.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contentsURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let plist: [String: Any] = [
            "CFBundleDisplayName": "Claude Code",
            "CFBundleIdentifier": "com.anthropic.claudefordesktop",
            "CFBundleShortVersionString": "1.2.4",
            "CFBundleExecutable": "Claude"
        ]
        let plistData = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try plistData.write(to: contentsURL.appendingPathComponent("Info.plist"))

        let platform = MacOSPlatformServices(homeDirectoryURL: tempDir)
        let discovery = MacOSApplicationDiscovery(platformServices: platform)
        let model = try discovery.identifyAppBundle(at: bundleURL)

        XCTAssertEqual(model.name, "Claude Code")
        XCTAssertEqual(model.bundleId, "com.anthropic.claudefordesktop")
        XCTAssertEqual(model.adapterId, "claude-code")
        XCTAssertTrue(model.isSupportedAIApp)
    }

    func testContextualClassifierNeverUsesExtensionAlone() {
        let classifier = MacOSArtifactClassifier()

        // .tmp file inside src/ must NOT be LOW risk
        let (tmpType, tmpRisk, _, _) = classifier.classify(
            path: "/Users/demo/Projects/app/src/draft.tmp",
            hasSharedDependencies: false,
            provenance: .verified
        )
        XCTAssertEqual(tmpType, .tempFile)
        XCTAssertNotEqual(tmpRisk, .low)

        // .tmp file inside dedicated .claude/shell-snapshots/ with no shared deps -> LOW risk
        let (_, safeTmpRisk, _, _) = classifier.classify(
            path: "/Users/demo/.claude/shell-snapshots/snap-1.tmp",
            hasSharedDependencies: false,
            provenance: .inferred
        )
        XCTAssertEqual(safeTmpRisk, .low)
    }
}
