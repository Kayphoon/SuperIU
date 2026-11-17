import AppKit
import Carbon

@MainActor
final class GlobalHotKeys {
    private var references: [EventHotKeyRef] = []
    private var handler: EventHandlerRef?
    var capture: (() -> Void)?
    var history: (() -> Void)?

    func start() throws {
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
                switch identifier.id {
                case 1: keys.capture?()
                case 2: keys.history?()
                default: break
                }
            }
            return noErr
        }, 1, &eventType, context, &handler)
        guard status == noErr else { throw HotKeyError.registration(status) }
        do {
            try register(key: UInt32(kVK_ANSI_2), id: 1)
            try register(key: UInt32(kVK_ANSI_V), id: 2)
        } catch {
            stop()
            throw error
        }
    }

    private func register(key: UInt32, id: UInt32) throws {
        var reference: EventHotKeyRef?
        let identifier = EventHotKeyID(signature: 0x53554955, id: id)
        let status = RegisterEventHotKey(key, UInt32(cmdKey | shiftKey), identifier,
                                         GetApplicationEventTarget(), 0, &reference)
        guard status == noErr, let reference else { throw HotKeyError.registration(status) }
        references.append(reference)
    }

    func stop() {
        for reference in references { UnregisterEventHotKey(reference) }
        references.removeAll()
        if let handler { RemoveEventHandler(handler) }
        handler = nil
    }
}

enum HotKeyError: LocalizedError {
    case registration(OSStatus)
    var errorDescription: String? {
        switch self {
        case .registration(let status): return "全局快捷键注册失败（\(status)）。请检查 ⌘⇧2 / ⌘⇧V 是否被其他应用占用；仍可通过菜单栏操作。"
        }
    }
}
