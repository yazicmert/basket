import SwiftUI
import AppKit
import UniformTypeIdentifiers
import ArtifactAtlasCore

@main
struct ArtifactAtlasApp: App {
    var body: some Scene {
        WindowGroup("Artifact Atlas") {
            ArtifactAtlasRootView()
                .frame(minWidth: 1080, minHeight: 720)
        }
        .windowStyle(.titleBar)
    }
}

struct ArtifactAtlasRootView: View {
    @State private var identifiedApp: ApplicationModel?
    @State private var errorMessage: String?
    @State private var isDropTargeted: Bool = false

    private let platformServices = MacOSPlatformServices()
    private var discovery: MacOSApplicationDiscovery {
        MacOSApplicationDiscovery(platformServices: platformServices)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let app = identifiedApp {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(app.name)
                                .font(.title2.bold())
                            Text("\(app.bundleId ?? "Unknown Bundle ID") • v\(app.version) • \(app.recognitionStatus)")
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Switch Application") {
                            identifiedApp = nil
                        }
                    }
                    .padding()
                    Divider()
                    List(app.knownDataDirectories, id: \.path) { candidate in
                        HStack {
                            Text(candidate.role)
                                .font(.caption.monospaced())
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Color.accentColor.opacity(0.15))
                                .clipShape(Capsule())
                            Text(candidate.path)
                                .font(.system(.body, design: .monospaced))
                            Spacer()
                            Button("Reveal in Finder") {
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: candidate.path)])
                            }
                        }
                    }
                }
            } else {
                // Section 4.1 Empty Workspace
                VStack(spacing: 20) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 46, weight: .light))
                        .foregroundStyle(Color.accentColor)

                    Text("Drop an AI application to explore its artifacts.")
                        .font(.title2.weight(.semibold))

                    Text("Passively inspects macOS .app bundle metadata without executing the binary, then traces local sessions, caches, logs, and build outputs.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 460)

                    HStack(spacing: 12) {
                        Button("Choose Application…") {
                            chooseApplicationWithOpenPanel()
                        }
                        .buttonStyle(.borderedProminent)
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .frame(maxWidth: 620, maxHeight: 380)
                .background(
                    RoundedRectangle(cornerRadius: 16)
                        .strokeBorder(
                            isDropTargeted ? Color.accentColor : Color.secondary.opacity(0.35),
                            style: StrokeStyle(lineWidth: 1.5, dash: [8, 5])
                        )
                )
                .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
                    handleDrop(providers: providers)
                }
                .padding(40)
            }
        }
    }

    private func chooseApplicationWithOpenPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.applicationBundle]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        if panel.runModal() == .OK, let url = panel.url {
            identifyBundle(at: url)
        }
    }

    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            guard let data = item as? Data,
                  let url = URL(dataRepresentation: data, relativeTo: nil) else { return }
            DispatchQueue.main.async {
                identifyBundle(at: url)
            }
        }
        return true
    }

    private func identifyBundle(at url: URL) {
        do {
            identifiedApp = try discovery.identifyAppBundle(at: url)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
