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

    // The mark matches the favicon (site/favicon.svg): an ink tile with a provenance link.
    // Coordinates below are on the favicon's 64-unit grid, with y measured from the top.
    let ink = CGColor(red: 0.106, green: 0.106, blue: 0.102, alpha: 1.0)
    let paper = CGColor(red: 0.988, green: 0.988, blue: 0.984, alpha: 1.0)
    let safeGreen = CGColor(red: 0.047, green: 0.639, blue: 0.047, alpha: 1.0)
    let unit = rect.width / 64.0
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        return CGPoint(x: rect.minX + x * unit, y: rect.maxY - y * unit)
    }
    func disc(_ center: CGPoint, _ radius: CGFloat) -> CGRect {
        return CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    }

    // Rounded ink tile
    let bgPath = CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil)
    ctx.addPath(bgPath)
    ctx.setFillColor(ink)
    ctx.fillPath()

    let hub = point(20, 45)
    let recorded = point(34, 18)
    let likely = point(51, 38)

    // Recorded link: solid
    ctx.setStrokeColor(paper)
    ctx.setLineWidth(4 * unit)
    ctx.setLineCap(.round)
    ctx.move(to: hub)
    ctx.addLine(to: recorded)
    ctx.strokePath()

    // Likely link: dashed
    ctx.setLineCap(.butt)
    ctx.setLineDash(phase: 0, lengths: [4 * unit, 6.5 * unit])
    ctx.move(to: hub)
    ctx.addLine(to: likely)
    ctx.strokePath()
    ctx.setLineDash(phase: 0, lengths: [])

    // A file that is safe to remove
    ctx.setFillColor(ink)
    ctx.fillEllipse(in: disc(recorded, 8.25 * unit))
    ctx.setFillColor(safeGreen)
    ctx.fillEllipse(in: disc(recorded, 7 * unit))

    // A file whose link is only likely: hollow
    ctx.setFillColor(paper)
    ctx.fillEllipse(in: disc(likely, 7.25 * unit))
    ctx.setFillColor(ink)
    ctx.fillEllipse(in: disc(likely, 3.75 * unit))

    // The application
    ctx.setFillColor(paper)
    ctx.fillEllipse(in: disc(hub, 8.5 * unit))

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
