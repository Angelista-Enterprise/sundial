import AVFoundation
import Foundation

/// Live-tested finding (2026-07-17), confirmed three independent ways --
/// Photo Booth, a real Google Meet call, and KVO observation on a
/// persistent AVCaptureDevice reference: `isInUseByAnotherApplication`
/// stays `false` on this machine even with full Camera authorization and
/// `isConnected == true`. This machine uses the modern DriverKit-based
/// camera stack (`appleh16camerad` / `cameracaptured`, confirmed via `ps`),
/// which mediates camera access through IPC rather than the direct
/// VDC/AppleCamera/CMIO file descriptors the (also-tried) lsof heuristic
/// looks for -- so that approach found nothing either.
///
/// What DOES work, live-verified over two independent on/off cycles:
/// `cameracaptured`'s CPU usage -- ~13-16% while actually streaming,
/// a rock-steady 0.0% at idle. See `isCameraActive()` below.
/// Cheap, targeted-by-pid `ps` call (not a system-wide scan like lsof) --
/// safe to call every tick. `cameracaptured` is the CMIO extension host
/// process on the modern camera stack; `VDCAssistant` covers older
/// Intel-era architectures as a best-effort fallback (untested here, no
/// such hardware available, but harmless if the process doesn't exist).
private let cameraDaemonProcessNames = ["cameracaptured", "VDCAssistant"]
private let cameraDaemonCpuThreshold = 3.0

func isCameraActive() -> Bool {
    for name in cameraDaemonProcessNames {
        if cpuUsage(forProcessNamed: name) ?? 0 >= cameraDaemonCpuThreshold {
            return true
        }
    }
    return false
}

/// Live-tested finding (2026-07-17): `ps -axo comm=,%cpu=` truncates `comm`
/// to ~16 chars when combined with another column (BSD ps's default column
/// width behavior) -- "cameracaptured" silently became "/usr/libexec/cam"
/// and never matched anything. Fixed by resolving the pid via `pgrep -x`
/// (exact-name match, not truncated) first, then reading %cpu for that
/// specific pid -- two small, targeted subprocess calls, not a full-table
/// scan, so no pipe-overflow risk either.
private func cpuUsage(forProcessNamed name: String) -> Double? {
    guard let pid = runProcessCapturingOutput("/usr/bin/pgrep", ["-x", name])?
        .split(separator: "\n").first, let pidInt = Int32(pid) else {
        return nil
    }
    guard let cpuText = runProcessCapturingOutput("/bin/ps", ["-o", "%cpu=", "-p", "\(pidInt)"]) else {
        return nil
    }
    return Double(cpuText.trimmingCharacters(in: .whitespacesAndNewlines))
}

private func runProcessCapturingOutput(_ path: String, _ arguments: [String]) -> String? {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: path)
    proc.arguments = arguments
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do {
        try proc.run()
    } catch {
        return nil
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    guard proc.terminationStatus == 0, let text = String(data: data, encoding: .utf8) else {
        return nil
    }
    return text
}

/// Best-effort camera process attribution via lsof on VDC/CMIO handles.
/// Confirmed to find nothing on this machine's modern camera architecture
/// (see comment above) -- kept as-is since it's harmless (empty result,
/// not wrong data) and may still work on older Intel Macs where consuming
/// apps hold direct device handles. Gated behind `isCameraActive()` (now
/// the CPU-based check) so the expensive full-fd-table scan only runs
/// while we already know the camera is on.
func findCameraProcesses() -> [AvProcessUsage] {
    guard isCameraActive() else { return [] }

    let lsofPath = "/usr/sbin/lsof"
    guard FileManager.default.isExecutableFile(atPath: lsofPath) else { return [] }

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: lsofPath)
    proc.arguments = ["-n", "-F", "pcn"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do {
        try proc.run()
    } catch {
        return []
    }
    // Live-tested finding (2026-07-17): lsof -F pcn produces ~40k lines on a
    // real dev machine -- well over the pipe's buffer size. Calling
    // waitUntilExit() before draining the pipe deadlocks (lsof blocks
    // writing to a full pipe; we block waiting for lsof to exit). Read to
    // EOF first -- that drains the pipe as lsof writes, so it naturally
    // unblocks and exits, then waitUntilExit() returns immediately after.
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    proc.waitUntilExit()
    guard proc.terminationStatus == 0,
          let text = String(data: data, encoding: .utf8) else {
        return []
    }

    let cameraTokens = ["VDC", "AppleCamera", "CMIO"]
    var pids = Set<pid_t>()
    var currentPid: pid_t?
    for line in text.split(separator: "\n") {
        if line.hasPrefix("p") {
            currentPid = pid_t(String(line.dropFirst())) ?? nil
        } else if line.hasPrefix("c"), let pid = currentPid {
            let cmd = String(line.dropFirst())
            if cameraTokens.contains(where: { cmd.contains($0) }) {
                pids.insert(pid)
            }
        }
    }

    return pids.map { resolveProcessRef(pid: $0, bundleId: nil) }
}

// --- Throttled wrapper ---
// isCameraActive() (above) is now cheap and reliable, checked every second.
// findCameraProcesses() is not (full-fd-table lsof scan) -- decoupling "is
// the camera on" from "who is using it" still applies, same as before.
private var cameraAttributionCache: [AvProcessUsage] = []
private var cameraAttributionCheckedAt = Date.distantPast
private let cameraAttributionThrottleSeconds: TimeInterval = 15

func findCameraProcessesThrottled(now: Date = Date()) -> [AvProcessUsage] {
    guard isCameraActive() else {
        cameraAttributionCache = []
        cameraAttributionCheckedAt = .distantPast
        return []
    }

    let dueForRecheck = cameraAttributionCache.isEmpty
        || now.timeIntervalSince(cameraAttributionCheckedAt) >= cameraAttributionThrottleSeconds
    guard dueForRecheck else { return cameraAttributionCache }

    cameraAttributionCheckedAt = now
    cameraAttributionCache = findCameraProcesses()
    return cameraAttributionCache
}
