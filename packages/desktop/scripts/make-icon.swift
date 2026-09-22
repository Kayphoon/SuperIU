// Renders a 1024x1024 macOS app icon from a line-art source image.
//
// The source art is black ink on opaque white. It is cropped to the ink's own
// bounding box (which discards the sticker border and its drop shadow) and
// centred on a white Big Sur squircle, so the white interior of the drawing
// merges with the plate and only the line work reads.
//
// usage: swift make-icon.swift <source> <out.png> [--debug]

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write(Data("usage: make-icon <source> <out.png>\n".utf8))
  exit(2)
}
let sourcePath = args[1]
let outputPath = args[2]
let debug = args.contains("--debug")

func die(_ message: String) -> Never {
  FileHandle.standardError.write(Data("error: \(message)\n".utf8))
  exit(1)
}

// --- Load the source at full resolution ------------------------------------

guard let imageSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: sourcePath) as CFURL, nil),
  let art = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
else { die("cannot decode \(sourcePath)") }

let artWidth = art.width
let artHeight = art.height

// A known RGBA8 layout is required to inspect pixels; the source may be any
// colour model (this one is opaque YUV-backed WebP).
let rgba = CGColorSpaceCreateDeviceRGB()
guard
  let probe = CGContext(
    data: nil,
    width: artWidth,
    height: artHeight,
    bitsPerComponent: 8,
    bytesPerRow: artWidth * 4,
    space: rgba,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )
else { die("cannot allocate probe context") }

probe.draw(art, in: CGRect(x: 0, y: 0, width: artWidth, height: artHeight))
guard let probeData = probe.data else { die("probe context has no backing store") }

// --- Isolate the ink as a transparent-backed mask --------------------------

// The art is flat black ink on white, but the source also carries a white
// sticker border and a soft grey drop shadow. Rather than cropping those away
// and hoping, the drawing is reduced to a two-tone mask: every pixel darker
// than the threshold becomes opaque black, everything else becomes fully
// transparent. The sticker border and the shadow are both lighter than the
// threshold, so they simply cease to exist, and the result composites onto the
// white plate as clean line work with no grey fringe of its own.
let inkThreshold = 128
let pixels = probeData.bindMemory(to: UInt8.self, capacity: artWidth * artHeight * 4)

guard
  let mask = CGContext(
    data: nil,
    width: artWidth,
    height: artHeight,
    bitsPerComponent: 8,
    bytesPerRow: artWidth * 4,
    space: rgba,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ), let maskData = mask.data
else { die("cannot allocate the ink mask") }

let maskPixels = maskData.bindMemory(to: UInt8.self, capacity: artWidth * artHeight * 4)
var minX = artWidth
var minY = artHeight
var maxX = -1
var maxY = -1

for y in 0..<artHeight {
  let row = y * artWidth * 4
  for x in 0..<artWidth {
    let i = row + x * 4
    let luma = (Int(pixels[i]) * 299 + Int(pixels[i + 1]) * 587 + Int(pixels[i + 2]) * 114) / 1000
    guard luma < inkThreshold else { continue }
    maskPixels[i] = 0
    maskPixels[i + 1] = 0
    maskPixels[i + 2] = 0
    maskPixels[i + 3] = 255
    if x < minX { minX = x }
    if x > maxX { maxX = x }
    if y < minY { minY = y }
    if y > maxY { maxY = y }
  }
}

guard maxX >= minX, maxY >= minY else { die("no ink found in \(sourcePath)") }

let inkWidth = maxX - minX + 1
let inkHeight = maxY - minY + 1
if debug {
  print("source    \(artWidth)x\(artHeight)")
  print("ink bbox  x=\(minX) y=\(minY) w=\(inkWidth) h=\(inkHeight)")
}

// The mask's memory row 0 is the image's top row (verified: a CGBitmapContext
// stores rows top-down even though its drawing origin is bottom-left), and
// `CGImage.cropping` also measures from the top. So `minY` is the crop offset
// directly — no vertical flip is involved anywhere in this pipeline.
guard
  let maskImage = mask.makeImage(),
  let ink = maskImage.cropping(to: CGRect(x: minX, y: minY, width: inkWidth, height: inkHeight))
else { die("cannot crop to the ink bounding box") }

// --- Compose ---------------------------------------------------------------

let canvas = 1024
// Apple's icon grid: the rounded plate occupies 824 of the 1024 canvas, the
// remaining 100 on each side staying transparent for the Dock's perspective.
let plate = 824
let cornerExponent = 5.0

guard
  let icon = CGContext(
    data: nil,
    width: canvas,
    height: canvas,
    bitsPerComponent: 8,
    bytesPerRow: canvas * 4,
    space: rgba,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )
else { die("cannot allocate icon context") }

icon.setShouldAntialias(true)
icon.interpolationQuality = .high

func squirclePath(half: CGFloat) -> CGPath {
  let path = CGMutablePath()
  let steps = 720
  let exponent = 2.0 / cornerExponent
  for step in 0...steps {
    let theta = Double(step) / Double(steps) * 2 * Double.pi
    let cosTheta = cos(theta)
    let sinTheta = sin(theta)
    let x = half * CGFloat(copysign(pow(abs(cosTheta), exponent), cosTheta))
    let y = half * CGFloat(copysign(pow(abs(sinTheta), exponent), sinTheta))
    let point = CGPoint(x: CGFloat(canvas) / 2 + x, y: CGFloat(canvas) / 2 + y)
    if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
  }
  path.closeSubpath()
  return path
}

let platePath = squirclePath(half: CGFloat(plate) / 2)

// A white plate on a light background has no luminance edge of its own, so it
// would dissolve into Finder windows, Spotlight rows and pale desktops. Apple's
// grid reserves the 100px gutter for exactly this: an ambient shadow cast by the
// plate, plus a hairline rim that draws the silhouette where the shadow is too
// soft to read.
let shadowOffsetY: CGFloat = -12
let shadowBlur: CGFloat = 24
let shadowAlpha: CGFloat = 0.18
let rimWidth: CGFloat = 1
let rimAlpha: CGFloat = 0.08

icon.addPath(platePath)
icon.setShadow(
  offset: CGSize(width: 0, height: shadowOffsetY),
  blur: shadowBlur,
  color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: shadowAlpha))
icon.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
icon.fillPath()

// The shadow must not bleed onto the line work or the rim, so it is cleared
// before either is drawn.
icon.setShadow(offset: .zero, blur: 0, color: nil)

// The rim is drawn clipped to the plate so a 1pt stroke lands as a crisp pixel
// row just inside the edge, instead of being split across the two pixels the
// boundary straddles.
icon.saveGState()
icon.addPath(platePath)
icon.clip()
icon.addPath(platePath)
icon.setStrokeColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: rimAlpha))
icon.setLineWidth(rimWidth * 2)
icon.strokePath()
icon.restoreGState()

// Fit the ink inside the plate with a margin, so the drawing never crowds the
// curve. Height is the binding dimension for a portrait subject.
let fit = CGFloat(plate) * 0.80
let scale = min(fit / CGFloat(inkWidth), fit / CGFloat(inkHeight))
let drawWidth = CGFloat(inkWidth) * scale
let drawHeight = CGFloat(inkHeight) * scale
let drawRect = CGRect(
  x: (CGFloat(canvas) - drawWidth) / 2,
  y: (CGFloat(canvas) - drawHeight) / 2,
  width: drawWidth,
  height: drawHeight
)
icon.draw(ink, in: drawRect)

if debug {
  print("plate     \(plate) squircle, n=\(cornerExponent)")
  print("art draw  \(Int(drawWidth))x\(Int(drawHeight)) at \(Int(drawRect.minX)),\(Int(drawRect.minY))")
}

guard let rendered = icon.makeImage() else { die("cannot rasterise the icon") }
guard
  let destination = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: outputPath) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { die("cannot open \(outputPath) for writing") }

CGImageDestinationAddImage(destination, rendered, nil)
guard CGImageDestinationFinalize(destination) else { die("cannot write \(outputPath)") }
if debug { print("wrote     \(outputPath)") }
