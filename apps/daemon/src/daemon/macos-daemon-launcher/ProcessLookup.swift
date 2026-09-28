import Darwin
import Foundation

private func lookupProcessComm(pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXCOMLEN))
    let len = proc_name(pid, &buffer, UInt32(buffer.count))
    guard len > 0 else { return nil }
    let name = String(cString: buffer).trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? nil : name
}

private func lookupExecutablePath(pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    let len = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard len > 0 else { return nil }
    let path = String(cString: buffer).trimmingCharacters(in: .whitespacesAndNewlines)
    return path.isEmpty ? nil : path
}

private func lookupAppBundlePath(from executablePath: String) -> String? {
    if let range = executablePath.range(of: ".app") {
        let end = executablePath.index(range.lowerBound, offsetBy: 4, limitedBy: executablePath.endIndex) ?? executablePath.endIndex
        return String(executablePath[..<end])
    }
    return nil
}

private func lookupDisplayName(fromAppBundlePath appPath: String) -> String? {
    if let bundle = Bundle(path: appPath), let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String, !name.isEmpty {
        return name
    }
    if let bundle = Bundle(path: appPath), let name = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String, !name.isEmpty {
        return name
    }
    return URL(fileURLWithPath: appPath).deletingPathExtension().lastPathComponent
}

func lookupProcessBundleId(pid: pid_t) -> String? {
    guard let path = lookupExecutablePath(pid: pid),
          let appPath = lookupAppBundlePath(from: path) else {
        return nil
    }
    return Bundle(path: appPath)?.bundleIdentifier
}

/// Resolve a human-readable process label when NSRunningApplication is unavailable.
func lookupProcessLabel(pid: pid_t) -> String? {
    if let path = lookupExecutablePath(pid: pid),
       let appPath = lookupAppBundlePath(from: path),
       let display = lookupDisplayName(fromAppBundlePath: appPath) {
        return display
    }

    if let comm = lookupProcessComm(pid: pid) {
        return comm
    }

    if let path = lookupExecutablePath(pid: pid) {
        return URL(fileURLWithPath: path).lastPathComponent
    }

    return nil
}
