import AppKit
import Carbon

@MainActor
final class GlobalHotKeys {
    private struct Registration {
        let id: UInt32
        let reference: EventHotKeyRef
    }
    private var registrations: [NativeShortcut: Registration] = [:]
    private var handler: EventHandlerRef?
    private var captureID: UInt32?
    private var historyID: UInt32?
    var capture: (() -> Void)?
    var history: (() -> Void)?

    func start() throws {
        try configure(capture: .capture, history: .history) {}
    }

    func configure(capture: NativeShortcut, history: NativeShortcut, updateCache: () throws -> Void) throws {
        try capture.validate()
        try history.validate()
        guard capture != history else { throw NativeSettingsError.duplicateShortcuts }
        if handler == nil { try installHandler() }
        var additions: [NativeShortcut: Registration] = [:]
        let usedIDs = Set(registrations.values.map(\.id))
        var availableIDs: [UInt32] = [1, 2, 3, 4].filter { !usedIDs.contains($0) }
        do {
            // Retain the old registrations until both new bindings and the cache
            // update succeed. Reuse bindings when the two actions are swapped.
            for shortcut in [capture, history] where registrations[shortcut] == nil {
                additions[shortcut] = try register(shortcut, id: availableIDs.removeFirst())
            }
            try updateCache()
        } catch {
            for registration in additions.values { UnregisterEventHotKey(registration.reference) }
            if registrations.isEmpty { stop() }
            throw error
        }
        var configured: [NativeShortcut: Registration] = [:]
        for shortcut in [capture, history] { configured[shortcut] = registrations[shortcut] ?? additions[shortcut] }
        for (shortcut, registration) in registrations where configured[shortcut] == nil {
            UnregisterEventHotKey(registration.reference)
        }
        registrations = configured
        captureID = registrations[capture]?.id
        historyID = registrations[history]?.id
    }

    private func installHandler() throws {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var identifier = EventHotKeyID()
            let result = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                           EventParamType(typeEventHotKeyID), nil,
                                           MemoryLayout<EventHotKeyID>.size, nil, &identifier)
            guard result == noErr else { return result }
            // Carbon dispatches application hotkeys on the application event loop.
            let keys = Unmanaged<GlobalHotKeys>.fromOpaque(userData).takeUnretainedValue()
            MainActor.assumeIsolated {
                if identifier.id == keys.captureID { keys.capture?() }
                else if identifier.id == keys.historyID { keys.history?() }
            }
            return noErr
        }, 1, &eventType, context, &handler)
        guard status == noErr else { throw HotKeyError.registration(status) }
    }

    private func register(_ shortcut: NativeShortcut, id: UInt32) throws -> Registration {
        var reference: EventHotKeyRef?
        let identifier = EventHotKeyID(signature: 0x53554955, id: id)
        let status = RegisterEventHotKey(UInt32(shortcut.keyCode), UInt32(shortcut.modifiers), identifier,
                                         GetApplicationEventTarget(), 0, &reference)
        guard status == noErr, let reference else { throw HotKeyError.registration(status) }
        return Registration(id: id, reference: reference)
    }

    func stop() {
        for registration in registrations.values { UnregisterEventHotKey(registration.reference) }
        registrations.removeAll()
        captureID = nil
        historyID = nil
        if let handler { RemoveEventHandler(handler) }
        handler = nil
    }
}

enum HotKeyError: LocalizedError {
    case registration(OSStatus)
    var errorDescription: String? {
        switch self {
        case .registration(let status): return "全局快捷键注册失败（\(status)）。请检查所选快捷键是否被其他应用占用，或选择其他快捷键。"
        }
    }
}
