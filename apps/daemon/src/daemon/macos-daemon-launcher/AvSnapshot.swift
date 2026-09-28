import Foundation

func captureAvSnapshot() -> AvContextSnapshot {
    let avProcesses = enumerateAudioProcesses()
    let cameraProcs = findCameraProcessesThrottled()
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    // Live-tested finding (2026-07-17): `isMicrophoneActive()`'s device-level
    // check (kAudioDevicePropertyDeviceIsRunningSomewhere) doesn't know which
    // process is using the mic — it would still report `true` from
    // `corespeechd`'s background listening alone, even after filtering it
    // out of the per-process list above (see AvProcessAttribution.swift's
    // comment). Dropped as a fallback for the same reason that filter
    // exists: `microphoneActive` should reflect real engagement, and the
    // per-process HAL query is already reliable enough on its own not to
    // need a device-level OR.
    return AvContextSnapshot(
        microphoneActive: !avProcesses.input.isEmpty,
        cameraActive: !cameraProcs.isEmpty || isCameraActive(),
        audioInputProcesses: avProcesses.input,
        audioOutputProcesses: avProcesses.output,
        cameraProcesses: cameraProcs,
        captureTimestamp: formatter.string(from: Date())
    )
}
