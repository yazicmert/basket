// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ArtifactAtlas",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "ArtifactAtlasCore",
            targets: ["ArtifactAtlasCore"]
        ),
        .executable(
            name: "ArtifactAtlasApp",
            targets: ["ArtifactAtlasApp"]
        )
    ],
    targets: [
        .target(
            name: "ArtifactAtlasCore",
            dependencies: [],
            path: "Sources/ArtifactAtlasCore",
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        ),
        .executableTarget(
            name: "ArtifactAtlasApp",
            dependencies: ["ArtifactAtlasCore"],
            path: "Sources/ArtifactAtlasApp"
        ),
        .testTarget(
            name: "ArtifactAtlasCoreTests",
            dependencies: ["ArtifactAtlasCore"],
            path: "Tests/ArtifactAtlasCoreTests"
        )
    ]
)
