import AppKit
import Carbon

struct NativeShortcut: Codable, Hashable {
    let keyCode: Int
    let modifiers: Int

    static let capture = NativeShortcut(keyCode: 19, modifiers: 768)
    static let history = NativeShortcut(keyCode: 9, modifiers: 768)

    func validate() throws {
        guard (0...127).contains(keyCode), modifiers >= 0,
              modifiers & ~6912 == 0, modifiers & 6400 != 0 else {
            throw NativeSettingsError.invalidShortcut
        }
    }

    var menuModifiers: NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if modifiers & 256 != 0 { flags.insert(.command) }
        if modifiers & 512 != 0 { flags.insert(.shift) }
        if modifiers & 2048 != 0 { flags.insert(.option) }
        if modifiers & 4096 != 0 { flags.insert(.control) }
        return flags
    }

    var keyEquivalent: String {
        let special: [Int: Int] = [
            36: 13, 48: 9, 49: 32, 51: 8, 53: 27, 76: 3,
            71: NSClearLineFunctionKey, 115: NSHomeFunctionKey, 117: NSDeleteFunctionKey,
            119: NSEndFunctionKey, 116: NSPageUpFunctionKey, 121: NSPageDownFunctionKey,
            123: NSLeftArrowFunctionKey, 124: NSRightArrowFunctionKey,
            125: NSDownArrowFunctionKey, 126: NSUpArrowFunctionKey,
            122: NSF1FunctionKey, 120: NSF2FunctionKey, 99: NSF3FunctionKey,
            118: NSF4FunctionKey, 96: NSF5FunctionKey, 97: NSF6FunctionKey,
            98: NSF7FunctionKey, 100: NSF8FunctionKey, 101: NSF9FunctionKey,
            109: NSF10FunctionKey, 103: NSF11FunctionKey, 111: NSF12FunctionKey,
            105: NSF13FunctionKey, 107: NSF14FunctionKey, 113: NSF15FunctionKey,
            106: NSF16FunctionKey, 64: NSF17FunctionKey, 79: NSF18FunctionKey,
            80: NSF19FunctionKey, 90: NSF20FunctionKey
        ]
        if let value = special[keyCode], let scalar = UnicodeScalar(value) { return String(scalar) }
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return "" }
        let data = unsafeBitCast(property, to: CFData.self)
        let layout = unsafeBitCast(CFDataGetBytePtr(data), to: UnsafePointer<UCKeyboardLayout>.self)
        var deadKey: UInt32 = 0
        var characters = [UniChar](repeating: 0, count: 4)
        var length = 0
        let status = UCKeyTranslate(layout, UInt16(keyCode), UInt16(kUCKeyActionDisplay), 0,
                                    UInt32(LMGetKbdType()), UInt32(kUCKeyTranslateNoDeadKeysMask),
                                    &deadKey, characters.count, &length, &characters)
        guard status == noErr else { return "" }
        return String(utf16CodeUnits: characters, count: length).lowercased()
    }
}

struct NativeSettings: Codable {
    var captureShortcut: NativeShortcut = .capture
    var historyShortcut: NativeShortcut = .history
    var imagePersistenceEnabled = false

    func validate() throws {
        try captureShortcut.validate()
        try historyShortcut.validate()
        guard captureShortcut != historyShortcut else { throw NativeSettingsError.duplicateShortcuts }
    }
}

struct NativeRequest: Decodable {
    let id: Int
    let action: String
    let settings: NativeSettings?
}

struct NativeRequestID: Decodable {
    let id: Int
}

struct NativeResponse: Encodable {
    let id: Int
    let ok: Bool
    var settings: NativeSettings?
    var error: String?
}

enum NativeSettingsError: LocalizedError {
    case invalidRequest, invalidShortcut, duplicateShortcuts, lineTooLong, unavailable

    var errorDescription: String? {
        switch self {
        case .invalidRequest: return "Invalid native settings request; use a positive integer id and a supported action."
        case .invalidShortcut: return "Use a key code from 0 through 127 with Command, Option or Control; only Command, Shift, Option and Control are supported."
        case .duplicateShortcuts: return "Capture and clipboard history need different shortcuts."
        case .lineTooLong: return "Native settings request exceeds the 8192-byte line limit."
        case .unavailable: return "Native clipboard store is unavailable."
        }
    }
}
