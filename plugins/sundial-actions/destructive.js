// A destructive-command detector for gnomon_run_shell.
//
// This is a BACKSTOP, not a sandbox: a heuristic denylist that refuses the
// commands whose damage is irreversible or system-level, so an `auto`-policy
// mistake cannot wipe a disk or escalate privilege. Real isolation is dsh's
// sandbox seam; this is the cheap, legible guard that runs regardless of
// policy — a destructive command is refused even when run_shell is `auto`.
//
// Kept pure and separate so the patterns are tested exhaustively. The bias is
// to refuse when unsure: a false refusal costs the owner one manual run; a
// false allow can cost the machine.

/**
 * Each rule is a labelled test. A command is destructive if ANY rule matches.
 * Matching is over the raw command string, lower-cased, with runs of
 * whitespace normalised — so `rm    -rf` and `rm -rf` read alike — but the
 * original casing of paths does not matter to any rule here.
 */
const RULES = [
  { why: 'recursive/forced delete (rm -rf)', test: (c) => /\brm\b[^\n|;&]*\s-[a-z]*r[a-z]*f|\brm\b[^\n|;&]*\s-[a-z]*f[a-z]*r|\brm\b[^\n|;&]*\s-r\b[^\n|;&]*\s-f\b|\brm\b[^\n|;&]*\s-f\b[^\n|;&]*\s-r\b/.test(c) },
  // A broad path (root, home, or a glob at one) at the END of a token. The
  // lookahead — not `\b` — is what lets `~` match at end of string, where a
  // word boundary after a non-word char does not exist.
  { why: 'delete of a root or home path', test: (c) => /\brm\b[^\n|;&]*\s(\/|~|\$home)(?=\s|$|\/|\*)/.test(c) },
  { why: 'privilege escalation (sudo/doas/su)', test: (c) => /(^|[\s|;&(])(sudo|doas|su)\b/.test(c) },
  { why: 'raw disk / filesystem write (dd, mkfs, fdisk, parted)', test: (c) => /(^|[\s|;&(])(dd|mkfs\S*|fdisk|parted|wipefs|shred)\b/.test(c) },
  { why: 'redirect onto a block device', test: (c) => />\s*\/dev\/(sd|nvme|disk|rdisk|hd)/.test(c) },
  { why: 'recursive permission/ownership change on a broad path', test: (c) => /(chmod|chown)\b[^\n|;&]*\s-[a-z]*r[a-z]*\b[^\n|;&]*\s(\/|~|\$home)(?=\s|$|\/)/.test(c) },
  { why: 'world-writable recursive chmod', test: (c) => /chmod\b[^\n|;&]*\s-[a-z]*r[a-z]*\b[^\n|;&]*\s0?777\b/.test(c) },
  { why: 'power state change (shutdown/reboot/halt)', test: (c) => /(^|[\s|;&(])(shutdown|reboot|halt|poweroff)\b/.test(c) },
  { why: 'pipe-to-shell of remote content (curl|wget → sh)', test: (c) => /(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/.test(c) },
  { why: 'fork bomb', test: (c) => /:\(\)\s*\{.*\|\s*:.*&\s*\}|:\|:&/.test(c) },
  { why: 'mass process kill', test: (c) => /(^|[\s|;&(])(killall\b|kill\s+-9\s+-1\b|pkill\b)/.test(c) },
  { why: 'destructive git (force push, hard reset, clean -fdx)', test: (c) => /git\b[^\n]*\s(push\b[^\n]*\s(-f\b|--force)|reset\b[^\n]*--hard|clean\b[^\n]*-[a-z]*f[a-z]*d|clean\b[^\n]*-[a-z]*d[a-z]*f)/.test(c) },
  { why: 'overwrite a device or truncate a file to nothing', test: (c) => /(^|[\s|;&(])(truncate)\b[^\n]*\s-s\s*0\b/.test(c) },
  { why: 'history/credential exfiltration', test: (c) => /(cat|less|more|head|tail)\b[^\n]*(\.ssh\/id_|\.aws\/credentials|\.env\b|\.netrc\b)/.test(c) },
  // Run 8 (2026-11-13) ran `strings` on Zen's logins.json and grepped the whole profile for an address: any command at all
  // that names a browser profile, a login or cookie store, or the Keychain is refused, whatever reads it.
  // Run 9 searched the owner's whole Documents folder and named another project's files: a search names the folder it is for.
  // Run 13: four calls and about a minute went on asking the shell which apps are running and telling one to
  // quit. macOS refuses both to a process without Automation, and the screen tools do it without asking anyone.
  { why: 'asking the shell which apps are running: macOS refuses that without Automation. To see what is in front, look with no app named. To quit one app you can name, this works and is not refused: osascript -e \'tell application "NAME" to quit\'',
    // A System Events keystroke is a blind Send, which has its own refusal and its own words: leave it to that one.
    test: (c) => (!/\bkeystroke\b|\bkey code\b/i.test(c) && /\bsystem events\b|\bevery application process\b|\blsappinfo\b/i.test(c)) || /\bps\s+-[a-z]*\b[^|;&\n]*\|[^|;&\n]*\bgrep\b[^|;&\n]*(Applications|\.app)\b/i.test(c) },
  { why: 'a recursive search of the whole home or Documents folder (name the folder the task is about)', test: (c) => /(^|[\s|;&(])(grep|egrep|rg|ag|find|mdfind)\b[^|;&\n]*\s(~|\$home|\/users\/[^/\s]+)(\/documents)?\/?(?=\s|$|[|;&])/.test(c) },
  { why: 'reading a browser profile, a login or cookie store, or the Keychain', test: (c) => /application\\? support\/(zen|firefox|mozilla|google\/chrome|chromium|bravesoftware|brave|microsoft edge|arc|vivaldi|com\.operasoftware|orion|dia)\b|library\/(safari|cookies|keychains)\b|\.mozilla\/|\b(logins\.json|key[34]\.db|cookies\.sqlite|places\.sqlite|formhistory\.sqlite|login data|web data)\b|\bsecurity\s+(find-(generic|internet)-password|dump-keychain|export)\b/.test(c) },
]

/**
 * Classify a shell command.
 * @returns { destructive: boolean, reason?: string } — reason names the rule that matched.
 */
export function classifyCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { destructive: true, reason: 'empty or non-string command' }
  }
  const normalised = command.toLowerCase().replace(/\s+/g, ' ')
  for (const rule of RULES) {
    if (rule.test(normalised)) return { destructive: true, reason: rule.why }
  }
  return { destructive: false }
}
