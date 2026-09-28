import AppKit
import CoreAudio
import Foundation

func resolveProcessRef(pid: pid_t, bundleId: String?) -> AvProcessUsage {
    if let app = NSRunningApplication(processIdentifier: pid) {
        let name = app.localizedName ?? lookupProcessLabel(pid: pid) ?? bundleId ?? "pid:\(pid)"
        return AvProcessUsage(
            pid: pid,
            processName: name,
            bundleId: app.bundleIdentifier ?? bundleId ?? lookupProcessBundleId(pid: pid)
        )
    }

    let resolvedBundle = bundleId ?? lookupProcessBundleId(pid: pid)
    let name = lookupProcessLabel(pid: pid) ?? resolvedBundle ?? "pid:\(pid)"
    return AvProcessUsage(pid: pid, processName: name, bundleId: resolvedBundle)
}

/// Live-tested finding (2026-07-17): these system daemons genuinely
/// register as "running input" via CoreAudio HAL much of the time,
/// unrelated to any real user activity — confirmed live (`corespeechd`
/// fired in lockstep with an unrelated Spotify playback event, with no
/// dictation/Siri session running). This is real HAL data, not a bug in
/// the query — likely always-on "Hey Siri"/dictation hot-word listening
/// infrastructure present on modern macOS regardless of whether the user
/// asked for it. WCS already knew about this exact set (see its
/// `in-call-detection.ts`'s `INPUT_ONLY_SYSTEM_PROCESSES`, used there to
/// avoid misclassifying ambient system listening as a real call) — ported
/// the same list here, one level earlier: excluded from the raw
/// audio-process enumeration entirely; `media:usage` and
/// `microphoneActive` should reflect real engagement, not background OS
/// infrastructure.
private let systemAudioProcesses: Set<String> = [
    "corespeechd",
    "SpeechSynthesisServer",
    "speechsynthesisd",
    "voicebankingd",
    "audiomxd",
    "heard",
]

private func getAudioPropertyUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

/// CoreAudio HAL's process-object API — a direct, cheap kernel/HAL query
/// (no subprocess spawn), so unlike camera attribution below, this needs no
/// throttling: it's called every second at the same cost as any other
/// window-info field.
func enumerateAudioProcesses() -> (input: [AvProcessUsage], output: [AvProcessUsage]) {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize
    ) == noErr, dataSize > 0 else {
        return ([], [])
    }

    let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
    var objects = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &objects
    ) == noErr else {
        return ([], [])
    }

    let myPid = ProcessInfo.processInfo.processIdentifier
    var input: [AvProcessUsage] = []
    var output: [AvProcessUsage] = []

    for obj in objects {
        guard let pidVal = getAudioPropertyUInt32(obj, kAudioProcessPropertyPID) else { continue }
        let pid = pid_t(pidVal)
        if pid == myPid { continue }

        let isInput = (getAudioPropertyUInt32(obj, kAudioProcessPropertyIsRunningInput) ?? 0) != 0
        let isOutput = (getAudioPropertyUInt32(obj, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
        guard isInput || isOutput else { continue }

        let ref = resolveProcessRef(pid: pid, bundleId: nil)
        if systemAudioProcesses.contains(ref.processName) { continue }
        if isInput { input.append(ref) }
        if isOutput { output.append(ref) }
    }

    return (input, output)
}
