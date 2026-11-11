import AppKit
import CoreGraphics
import Foundation

/// Generates a complete macOS `.iconset` directory with rendered PNG icons for Artifact Atlas,
/// then invokes `/usr/bin/iconutil -c icns` to produce `AppIcon.icns`.
let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: swift generate-app-icon.swift <output-icns-path>\n", stderr)
    exit(1)
}

let outputIcnsPath = args[1]
let fm = FileManager.default
let tempIconsetURL = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("AppIcon-\(UUID().uuidString).iconset", isDirectory: true)

try fm.createDirectory(at: tempIconsetURL, withIntermediateDirectories: true)
defer {
    try? fm.removeItem(at: tempIconsetURL)
}

let iconSpecs: [(name: String, pixels: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024)
]

func renderIconPNG(size: Int, to fileURL: URL) throws {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw NSError(domain: "IconGen", code: 1)
    }

    NSGraphicsContext.saveGraphicsState()
    guard let ctx = NSGraphicsContext(bitmapImageRep: rep)?.cgContext else {
        NSGraphicsContext.restoreGraphicsState()
        throw NSError(domain: "IconGen", code: 2)
    }

    let s = CGFloat(size)
    let pad = s * 0.08
    let rect = CGRect(x: pad, y: pad, width: s - pad * 2, height: s - pad * 2)
    let corner = s * 0.22

    // Rounded squircle background (#0B101B)
    let bgPath = CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil)
    ctx.addPath(bgPath)
    ctx.setFillColor(CGColor(red: 0.05, green: 0.08, blue: 0.13, alpha: 1.0))
    ctx.fillPath()

    // Subtle border
    ctx.addPath(bgPath)
    ctx.setStrokeColor(CGColor(red: 0.18, green: 0.83, blue: 0.75, alpha: 0.45))
    ctx.setLineWidth(max(1.0, s * 0.02))
    ctx.strokePath()

    // Constellation provenance graph edges
    let center = CGPoint(x: s * 0.50, y: s * 0.50)
    let satellites: [CGPoint] = [
        CGPoint(x: s * 0.28, y: s * 0.68),
        CGPoint(x: s * 0.72, y: s * 0.68),
        CGPoint(x: s * 0.26, y: s * 0.32),
        CGPoint(x: s * 0.74, y: s * 0.32)
    ]

    ctx.setStrokeColor(CGColor(red: 0.20, green: 0.83, blue: 0.60, alpha: 0.85))
    ctx.setLineWidth(max(1.2, s * 0.032))
    for pt in satellites {
        ctx.move(to: center)
        ctx.addLine(to: pt)
    }
    ctx.strokePath()

    // Center hub node
    let hubRadius = s * 0.11
    ctx.setFillColor(CGColor(red: 0.22, green: 0.74, blue: 0.97, alpha: 1.0))
    ctx.fillEllipse(in: CGRect(x: center.x - hubRadius, y: center.y - hubRadius, width: hubRadius * 2, height: hubRadius * 2))

    // Satellite artifact nodes
    let satRadius = s * 0.065
    for (idx, pt) in satellites.enumerated() {
        if idx % 2 == 0 {
            ctx.setFillColor(CGColor(red: 0.20, green: 0.83, blue: 0.60, alpha: 1.0))
        } else {
            ctx.setFillColor(CGColor(red: 0.98, green: 0.75, blue: 0.14, alpha: 1.0))
        }
        ctx.fillEllipse(in: CGRect(x: pt.x - satRadius, y: pt.y - satRadius, width: satRadius * 2, height: satRadius * 2))
    }

    NSGraphicsContext.restoreGraphicsState()

    guard let pngData = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "IconGen", code: 3)
    }
    try pngData.write(to: fileURL)
}

for spec in iconSpecs {
    let outFile = tempIconsetURL.appendingPathComponent(spec.name)
    try renderIconPNG(size: spec.pixels, to: outFile)
}

let outDir = URL(fileURLWithPath: outputIcnsPath).deletingLastPathComponent()
try fm.createDirectory(at: outDir, withIntermediateDirectories: true)

let proc = Process()
proc.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
proc.arguments = ["-c", "icns", tempIconsetURL.path, "-o", outputIcnsPath]
try proc.run()
proc.waitUntilExit()

guard proc.terminationStatus == 0 else {
    fputs("iconutil failed with status \(proc.terminationStatus)\n", stderr)
    exit(proc.terminationStatus)
}
print("Generated macOS icon at \(outputIcnsPath)")
