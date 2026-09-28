import Foundation

// The launcher is started by node, which is started by a login script, which
// launchd starts. TCC walks that chain to find who is RESPONSIBLE for each
// helper, and without this hop it bottoms out at node: measured 2026-09-25,
// the window helper got AXError -25211 under Node 24 while "Sundial" was
// granted Accessibility (also after `tccutil reset`), and worked under a Node 22
// that happened to hold its own Accessibility grant. A stranger's Node holds none.
//
// So the launcher re-runs itself once, disclaimed (the calendar helper's
// shape): the copy is responsible for ITSELF, its helpers inherit that, and
// TCC checks the grant the owner actually gave — "Sundial". The first process
// only waits; the copy writes sidecars.pid, so `stop` signals the copy and
// this one exits with it.

private let LAUNCHER_DISCLAIM_MARKER = "SUNDIAL_LAUNCHER_DISCLAIMED"

private typealias SetDisclaim = @convention(c) (UnsafeMutableRawPointer, Int32) -> Int32

/// Returns only when the hop could not be made (already disclaimed, or the
/// private SPI is missing) — then the caller runs as before.
func reexecLauncherDisclaimed() {
    if ProcessInfo.processInfo.environment[LAUNCHER_DISCLAIM_MARKER] != nil { return }

    guard let handle = dlopen(nil, RTLD_NOW) else { return }
    defer { dlclose(handle) }
    guard let symbol = dlsym(handle, "responsibility_spawnattrs_setdisclaim") else { return }
    let setDisclaim = unsafeBitCast(symbol, to: SetDisclaim.self)

    var attrs: posix_spawnattr_t?
    guard posix_spawnattr_init(&attrs) == 0 else { return }
    defer { posix_spawnattr_destroy(&attrs) }
    guard withUnsafeMutablePointer(to: &attrs, { setDisclaim(UnsafeMutableRawPointer($0), 1) }) == 0 else { return }

    let arguments = CommandLine.arguments
    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
    argv.append(nil)
    var environment: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment
        .map { strdup("\($0.key)=\($0.value)") }
    environment.append(strdup("\(LAUNCHER_DISCLAIM_MARKER)=1"))
    environment.append(nil)
    defer {
        for pointer in argv where pointer != nil { free(pointer) }
        for pointer in environment where pointer != nil { free(pointer) }
    }

    var pid: pid_t = 0
    guard posix_spawn(&pid, arguments[0], nil, &attrs, argv, environment) == 0 else { return }

    var status: Int32 = 0
    waitpid(pid, &status, 0)
    exit((status & 0x7F) == 0 ? (status >> 8) & 0xFF : 1)
}
