// What a shell command says, read from its text alone: its words, what it touches (files, hosts), whether it writes, and the
// parts a plain read (gate.js plainRead) is checked on. No policy and no app knowledge here: the gate (gate.js) decides.
import { posix } from 'node:path'

/** The `command` string of a bash / run_shell call, or '' when absent. */
export function commandOf(args) {
  if (args !== null && typeof args === 'object' && typeof args.command === 'string') return args.command
  return ''
}
// Set 4 R1 (slow-job, runs 167 to 204): an inline script (python -c, python3 - <<, node -e, a heredoc or a pipe into an
// interpreter) holding a web or app address (https://, obsidian://). The address is built where the owner, reading the ask,
// cannot see it whole. The prompt said so and was ignored one run in four.
// Fable review: the address is looked for in the script and its arguments only (a URL elsewhere in the command is the owner's
// to read), the whole command when the script's output flows into it ($(...), a pipe on) or the script cannot be cut out.
// Beyond a text fence: an address split into strings ("https" + "://") and a script written to a file and then run.
const INTERP = '(?:python[\\d.]*|nodejs|node|bun|deno|ruby|perl|php)'
const PATH = '(?:[^\\s;&|()`$\'"]*/)?'
const AT_INTERP = new RegExp(`(^|[\\s;&|(\`$])(${PATH}${INTERP})(?=[\\s;&|)]|$)`, 'g')
const PIPED = new RegExp(`(?<!\\|)\\|\\s*${PATH}${INTERP}(?:[ \\t]+-\\S*)*[ \\t]*(?=$|[;&|)\\n])`, 'gm')
const SCRIPT_FLAG = /^(?:-[A-Za-z]*[cepr]|--eval|--print|eval)$/
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/\S/i

/** One shell word from `from`, unquoted: `{ text, end }`, or null at a separator, a redirect, a comment or the end. */
function wordAt(s, from) {
  // The place read and the word so far, as one object: the host fence (F4) keeps `let` out of plugin modules.
  const w = { i: from, text: '' }
  while (s[w.i] === ' ' || s[w.i] === '\t') w.i++
  if (w.i >= s.length || ';&|\n)#>'.includes(s[w.i]) || (s[w.i] === '<' && s[w.i + 1] !== '<')) return null
  if (s.startsWith('<<', w.i)) { w.text = '<<'; w.i += 2 }
  while (w.i < s.length && !' \t;&|\n)<>'.includes(s[w.i])) {
    const c = s[w.i]
    if (c === "'") {
      const e = s.indexOf("'", w.i + 1)
      w.text += s.slice(w.i + 1, e < 0 ? s.length : e)
      w.i = e < 0 ? s.length : e + 1
    } else if (c === '"') {
      const j = { at: w.i + 1 }
      while (j.at < s.length && s[j.at] !== '"') j.at += s[j.at] === '\\' ? 2 : 1
      w.text += s.slice(w.i + 1, j.at).replace(/\\(.)/g, '$1')
      w.i = j.at + 1
    } else if (c === '\\') { w.text += s[w.i + 1] ?? ''; w.i += 2 } else { w.text += c; w.i++ }
  }
  return { text: w.text, end: w.i }
}
/** The words from `from` to the end of that command: `{ text, end }`. */
function wordsAt(s, from) {
  const out = { words: [], at: from }
  for (let w = wordAt(s, out.at); w; w = wordAt(s, out.at)) { out.words.push(w.text); out.at = w.end }
  return { text: out.words.join(' '), end: out.at }
}
/** A here-document's body after the line `at` is on, to its `delim` line; null when it cannot be cut. */
function heredocBody(s, at, delim) {
  const line = s.indexOf('\n', at)
  if (line < 0 || !delim) return null
  const end = new RegExp(`^[ \\t]*${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm').exec(s.slice(line + 1))
  return s.slice(line + 1, end ? line + 1 + end.index : s.length)
}

/** What a command's inline scripts hold: each script with its arguments, or the whole command where a script cannot be cut out. */
export function inlineParts(command) {
  const parts = []
  for (const m of command.matchAll(AT_INTERP)) {
    // Its output becomes part of the command (a substitution): the whole command counts.
    const sub = m[1] === '`' || (m[1] === '(' && command[m.index - 1] === '$')
    let at = m.index + m[1].length + m[2].length
    let part = null
    let stdin = false
    const args = []
    for (let w = wordAt(command, at); w; w = wordAt(command, at)) {
      at = w.end
      if (w.text.startsWith('<<')) {
        const delim = w.text.slice(2).replace(/^-/, '') || wordAt(command, at)?.text
        const body = heredocBody(command, at, delim)
        part = body === null ? command : `${args.join(' ')}\n${body}`
        break
      }
      if (stdin) { args.push(w.text); continue }
      if (SCRIPT_FLAG.test(w.text) || (w.text === '-m' && wordAt(command, at)?.text === 'webbrowser')) {
        const rest = wordsAt(command, at)
        // The script's output piped on (not `||`) flows into the command too.
        part = command[rest.end] === '|' && command[rest.end + 1] !== '|' ? command : rest.text
        break
      }
      if (w.text === '-') { stdin = true; continue }
      if (!w.text.startsWith('-')) break // a script file: not inline
    }
    // `python3 -` with no here-document reads a script from somewhere the text does not show.
    if (part === null && stdin) part = command
    if (part !== null) parts.push(sub ? command : part)
  }
  for (const m of command.matchAll(PIPED)) {
    const before = command.slice(0, m.index)
    parts.push(before.includes('<<') ? command : before.split(/;|\n|&&|\|\|/).at(-1))
  }
  return parts
}

/** The command runs an inline script, and that script (or what flows into or out of it) holds a web or app address. */
export const inlineAddress = (command) => typeof command === 'string' && ADDRESS.test(command) && inlineParts(command).some((p) => ADDRESS.test(p))
/** A label or a title as an ask quotes it, never with a ` · ` in it: that would cut the sentence the record strips (server.js stepLine). */
export const quote = (s) => JSON.stringify(String(s).replace(/\s·\s/g, ' - '))
/** A shell command as an ask shows it: its first 200 characters. */
export const commandLine = (command) => `Command: ${command.length > 200 ? `${command.slice(0, 200)}…` : command}`

/** A shell command's words, quotes taken off; `sep` between two commands, `out` before a redirect's target, a here-document skipped. */
export function shellWords(command) {
  const out = []
  // The word being read and the quote it is inside, as one object: the host fence (F4) keeps `let` out of plugin modules.
  const at = { word: null, q: null }
  const end = () => { if (at.word !== null) out.push(at.word); at.word = null }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (at.q) {
      if (c === at.q) at.q = null
      else at.word.text += c === '\\' && at.q === '"' ? (command[++i] ?? '') : c
    } else if (c === '"' || c === "'") {
      at.word ??= { text: '' }
      at.word.quoted = true
      at.q = c
    } else if (c === '\\') {
      at.word ??= { text: '' }
      at.word.text += command[++i] ?? ''
    } else if (c === ' ' || c === '\t') end()
    else if (';|&()`\n'.includes(c) || (c === '$' && command[i + 1] === '(')) {
      // `&>` is a redirect, not a `&` between commands.
      if (c === '&' && command[i + 1] === '>') continue
      end()
      // `open` and `close` say where a subshell starts and ends: a `cd` inside one does not move the commands after it.
      out.push({ sep: true, ...(c === '(' || c === '$' ? { open: true } : c === ')' ? { close: true } : {}) })
      if (c === '$') i++
    } else if (c === '>') {
      // `2>` keeps no word; `>&2` duplicates a stream, it writes no file.
      if (at.word && !at.word.quoted && /^\d*$/.test(at.word.text)) at.word = null
      end()
      if (command[i + 1] === '>') i++
      if (command[i + 1] === '&') { i++; while (/\d/.test(command[i + 1] ?? '')) i++; continue }
      out.push({ out: true })
    } else if (c === '<' && command[i + 1] === '<') {
      // A here-document is the command's input, never a command: skip to its closing word.
      end()
      const m = /^<<-?\s*(["']?)([\w.-]+)\1/.exec(command.slice(i))
      const close = m ? command.indexOf(`\n${m[2]}`, i) : -1
      i = close < 0 ? command.length : close + m[2].length
    } else (at.word ??= { text: '' }).text += c
  }
  end()
  return out
}
/** P in the folder DIR: P itself when absolute or under home, DIR/P when DIR is known, else null. A variable, a glob or `-` is not followed. */
const into = (dir, p) => {
  if (typeof p !== 'string' || p === '' || p === '-' || /[$`*?]/.test(p.replace(/^\$\{?HOME\}?(?=\/|$)/, ''))) return null
  if (/^(?:\/|(?:~|\$\{?HOME\}?)(?:\/|$))/.test(p)) return p
  return dir === null ? null : posix.normalize(`${dir}/${p}`)
}
/** A word that names a file: an absolute path, one under the home folder, or one with a folder in it and no space (quoted text is not a path). */
const pathLike = (w) => !w.startsWith('-') && !/^[a-z][a-z0-9+.-]*:/i.test(w) && (/^(?:\/|~|\$\{?HOME\}?|\.\.?\/)/.test(w) || (!/\s/.test(w) && /\/./.test(w)))
const homeOf = (w) => w.replace(/^\$\{?HOME\}?(?=\/|$)/, '~')
const SQL_WRITE = /\b(insert|update|delete|drop|create|alter|replace|vacuum|attach|reindex)\b/i
/**
 * Set 2 R1: what a shell command touches, as far as its text shows: the files it writes (a redirect, tee, touch, mkdir, the target
 * of cp, mv or ln, sed -i, a sqlite3 write), deletes (rm, rmdir, unlink, trash, find -delete) and reads (any other path), the
 * addresses it opens and the hosts it reaches (a web address: scheme and host only; an app link: its action, vault and file).
 */
export function touchesOf(command) {
  const t = { writes: [], deletes: [], reads: [], opens: [], reaches: [] }
  const text = typeof command === 'string' ? command : ''
  // Run 211 T19: `cd "<folder>" && printf ... >> notes.txt` asked "writes notes.txt", a file in no folder anyone could read. A
  // relative path is named in the folder a `cd` before it moved to (an absolute or home path, or one relative to a folder known
  // so); a `cd` inside a subshell holds only to its end, and a path after an unknown `cd` stays as written.
  const segments = [{ words: [], dir: null }]
  const dirs = [null]
  for (const w of shellWords(text)) {
    if (!w.sep) { segments.at(-1).words.push(w); continue }
    const [verb, to, more] = segments.at(-1).words.filter((x) => !x.out).map((x) => x.text)
    if (verb === 'cd') dirs[dirs.length - 1] = more === undefined ? into(dirs.at(-1), to) : null
    if (w.open) dirs.push(dirs.at(-1))
    else if (w.close && dirs.length > 1) dirs.pop()
    segments.push({ words: [], dir: dirs.at(-1) })
  }
  for (const { words: seg, dir } of segments) {
    const at = (p) => into(dir, p) ?? p
    const outs = seg.flatMap((w, i) => (seg[i - 1]?.out && !w.out ? [w.text] : []))
    const words = seg.filter((w, i) => !w.out && !seg[i - 1]?.out).map((w) => w.text)
    while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || SHELL_SYNTAX.has(words[0]))) words.shift()
    t.writes.push(...outs.filter((p) => !/^\/dev\/(null|stdout|stderr)$/.test(p)).map(at))
    const [verb, ...rest] = words
    // `for x in a b; do` names loop words, not files.
    if (verb === undefined || verb === 'for' || verb === 'case') continue
    const args = rest.filter((w) => !w.startsWith('-'))
    const files = args.filter(pathLike)
    if (['tee', 'touch', 'mkdir'].includes(verb)) t.writes.push(...args.map(at))
    else if (['cp', 'mv', 'ln', 'install'].includes(verb) && args.length > 1) t.writes.push(at(args.at(-1))), t.reads.push(...args.slice(0, -1).filter(pathLike).map(at))
    else if (['rm', 'rmdir', 'unlink', 'trash', 'srm'].includes(verb)) t.deletes.push(...args.map(at))
    else if (verb === 'find' && rest.includes('-delete')) t.deletes.push(...rest.slice(0, Math.max(0, rest.findIndex((w) => /^[-(!]/.test(w)))).filter(pathLike).map(at))
    else if ((verb === 'sed' && rest.some((w) => /^-[a-zA-Z]*i/.test(w))) || (verb === 'sqlite3' && !rest.includes('-readonly') && SQL_WRITE.test(text))) t.writes.push(...files.map(at))
    else t.reads.push(...files.map(at))
  }
  for (const [url, scheme] of text.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/[^\s"'<>)\\]*/gi)) {
    let u
    try { u = new URL(url) } catch { continue }
    const params = ['vault', 'file'].filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`).join('&')
    if (/^(https?|wss?|ftp)$/i.test(scheme)) t.reaches.push(`${u.protocol}//${u.host}`)
    else t.opens.push(`${scheme.toLowerCase()}://${u.host}${params ? `?${params}` : ''}`)
  }
  const once = (list) => [...new Set(list.map(homeOf))]
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, once(v)]))
}
/** What a shell ask names behind its command: `Touches: writes "a"; deletes "b"; reads "c"; opens "d"; reaches "e"`, or null when it names nothing. */
export function touchesLine(command) {
  const parts = Object.entries(touchesOf(command)).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.map(quote).join(', ')}`)
  return parts.length ? `Touches: ${parts.join('; ')}` : null
}
// A shell command that changes something: a write verb, or output sent into a
// file. `2>&1` and `> /dev/null` are not writes. A read (ls, git log, grep, a
// loop of them) is not worth a "may not have worked": on the record all 15
// such notices about a shell command in 14 days were reads.
const SHELL_WRITE = /(?:^|[\s|;&(`])((?:rm|mv|cp|mkdir|rmdir|touch|ln|tee|chmod|chown|kill|pkill|killall|open|osascript|launchctl|brew|say|defaults\s+(?:write|delete)|sed\s+-i|(?:npm|pnpm|yarn)\s+(?:install|i|add|remove|publish|run|exec|build)|curl\b[^|;&]*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data\S*|-d|-F|-T)|git\s+(?:commit|push|pull|merge|rebase|reset|checkout|switch|restore|tag|stash|clone|am|apply|cherry-pick|revert|add|rm|mv|init|fetch|worktree\s+(?:add|remove)|branch\s+-[dDmM]))(?=$|[\s|;&)`]))|(?<![0-9&>=-])>>?(?![&=])\s*(?!\/dev\/null)[^\s&|;]/
/**
 * Commands known to only read. A command is a read only when every part of it
 * starts with one of these; anything else (`gh pr create`, `ssh`, `rsync`,
 * `make deploy`, `python3 x.py`) is checked, because a failed outward act the
 * owner never hears about is the case this exists for. Shell syntax words and
 * `VAR=x` prefixes are skipped.
 */
const SHELL_READS = new Set(['ls', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'echo', 'printf', 'pwd', 'which', 'type', 'date', 'stat', 'file', 'du', 'df', 'tree', 'jq', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'less', 'more', 'diff', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false', 'sleep', 'find', 'obsidian', 'cd', 'git'])
export const SHELL_SYNTAX = new Set(['for', 'in', 'do', 'done', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'case', 'esac', '{', '}', '!', 'time'])
const GIT_READS = new Set(['log', 'status', 'branch', 'rev-parse', 'diff', 'show', 'remote', 'config', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'reflog', 'cat-file', 'worktree', 'rev-list', 'for-each-ref', 'tag', 'stash'])

/** The verb that makes a shell command a write (`git push`, `>`, `gh`), or null for a read. */
export function shellWrite(command) {
  if (typeof command !== 'string') return null
  const m = SHELL_WRITE.exec(command)
  if (m !== null) return (m[1] ?? '>').replace(/\s+/g, ' ')
  // Quoted text is an argument, not a command; `2>&1` is a redirect, not a background `&`.
  const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ARG ').replace(/\d*>&\d+|&>/g, ' ')
  for (const part of bare.split(/\|\||&&|[|;&\n`]|\$\(|\)/)) {
    const words = part.trim().split(/\s+/).filter((w) => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    const i = words.findIndex((w) => !SHELL_SYNTAX.has(w))
    if (i < 0) continue
    const [head, sub] = [words[i], words[i + 1]]
    // `for x in a b c; do`: the loop's own words are not commands.
    if (words[0] === 'for' || words[0] === 'case') continue
    // sqlite3 reads unless the statement writes.
    if (head === 'sqlite3' && !/\b(insert|update|delete|drop|create|alter|replace|vacuum|attach|reindex)\b/i.test(command)) continue
    if (!SHELL_READS.has(head)) return head
    if (head === 'git' && sub !== undefined && !sub.startsWith('-') && !GIT_READS.has(sub)) return `git ${sub}`
    if (head === 'find' && words.some((w) => w === '-delete' || w === '-exec' || w === '-execdir')) return 'find'
  }
  return null
}
/** Per verb: the single-letter flags it may take, the flags that take a value, long-option prefixes, and whether a pattern comes first. */
const GREP = { flags: 'inrlcvwxHhoEFsq', values: ['-e', '-m', '-A', '-B', '-C'], long: ['--include=', '--exclude=', '--color='], pattern: true }
const VERBS = {
  cat: { flags: 'nbsuvet' },
  head: { values: ['-n', '-c'], numbers: true },
  tail: { flags: 'r', values: ['-n', '-c'], numbers: true },
  wc: { flags: 'lwcm' },
  ls: { flags: '1aAlhtrSdFpGRi', needsPath: true },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
}
const FIND_VALUES = new Set(['-name', '-iname', '-type', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-size', '-path', '-ipath', '-newer'])
const FIND_WORDS = new Set(['-not', '!', '-o', '-a', '-or', '-and', '(', ')', '-print', '-print0'])
/** An absolute path as the file system reads it (firmlinks and case folded), or null for `..`, a glob, `~`, a variable or a relative path. */
function normalPath(path) {
  if (!path.startsWith('/') || /[*?[\]{}$~]/.test(path) || path.split('/').includes('..')) return null
  const plain = `/${path.split('/').filter((s) => s !== '' && s !== '.').join('/')}`.toLowerCase()
  return plain.replace(/^\/system\/volumes\/data(?=\/|$)/, '').replace(/^\/volumes\/[^/]+(?=\/|$)/, '') || '/'
}
export const freePath = (path) => /^\/(?:private\/)?tmp\/gnomon[^/]*(?:\/|$)/.test(normalPath(path) ?? '')
/** A command's parts, each its words with the quotes taken off, or null when it holds anything but words, `|`, `;`, `&&`, `||`, or an unquoted glob. */
export function readParts(command) {
  const at = { q: null, word: null, parts: [[]] }
  const end = () => { if (at.word !== null) at.parts.at(-1).push(at.word); at.word = null }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (at.q === "'") { if (c === "'") at.q = null; else at.word += c; continue }
    if (c === '\\') { at.word = (at.word ?? '') + (command[++i] ?? ''); continue }
    if (c === '`' || c === '$') return null
    if (at.q === '"') { if (c === '"') at.q = null; else at.word += c; continue }
    if (c === "'" || c === '"') { at.q = c; at.word ??= ''; continue }
    if (c === ' ' || c === '\t') end()
    else if (c === '|' || c === ';' || c === '\n' || (c === '&' && command[i + 1] === '&')) { end(); at.parts.push([]); if (c === '&' || command[i + 1] === '|') i++ }
    else if ('&<>()*?[{'.includes(c)) return null
    else at.word = (at.word ?? '') + c
  }
  if (at.q) return null
  end()
  return at.parts.filter((p) => p.length > 0)
}
/** The paths one part reads, or null when the verb or any of its options is not on the list. `[]`: it reads only its input, or nothing. */
export function pathsOf([verb, ...args]) {
  if (verb === 'find') {
    const stop = args.findIndex((a) => /^[-(!]/.test(a))
    const paths = args.slice(0, stop < 0 ? undefined : stop)
    if (paths.length === 0) return null
    for (let i = paths.length; i < args.length; i++) {
      if (FIND_VALUES.has(args[i])) { if (args[i] === '-newer') paths.push(args[i + 1] ?? ''); i++ } else if (!FIND_WORDS.has(args[i])) return null
    }
    return paths
  }
  const spec = VERBS[verb]
  if (!spec) return null
  const words = []
  const seen = { pattern: false, recursive: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const letters = /^-([a-zA-Z]+)$/.exec(a)?.[1]
    if (spec.values?.includes(a)) { seen.pattern ||= a === '-e'; i++ }
    else if (spec.values?.some((v) => new RegExp(`^${v}\\+?\\d+$`).test(a)) || (spec.numbers && /^-\d+$/.test(a)) || spec.long?.some((l) => a.startsWith(l))) continue
    else if (letters && [...letters].every((l) => spec.flags?.includes(l))) seen.recursive ||= letters.includes('r')
    else if (a.startsWith('-')) return null
    else words.push(a)
  }
  if (spec.pattern && !seen.pattern && words.length === 0) return null
  const paths = spec.pattern && !seen.pattern ? words.slice(1) : words
  return (spec.needsPath || seen.recursive) && paths.length === 0 ? null : paths
}
