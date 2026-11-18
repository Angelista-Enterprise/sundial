// The MCP entry for every host on this Mac that takes a local server (Track B7).
//
// Plain Node, no dependencies, like `sundial` itself. One entry per host, always the stdio form:
// the host spawns `node packages/mcp/bin/sundial-mcp.js` with SUNDIAL_HOME set, and that process
// reads the record itself, so it works whether or not Sundial is running. (The HTTP transport,
// `sundial mcp --http`, is for a host that takes nothing else; nothing starts it on its own yet.)
//
// Each host keeps its own file and shape. The JSON ones are read, one key set, and written back
// with everything else kept. The TOML (Codex) and YAML (Goose) ones get one marked block, so
// a remove takes out exactly what was written and nothing the owner wrote by hand. An entry
// named `sundial` that is not ours (its args do not name this checkout) is left alone and said.
//
// Claude Code is not here: `claude mcp add` owns its config (bin/sundial, offerMcp). Claude Desktop
// takes its config file rather than a .mcpb: a bundle would have to carry the same absolute path.
import fs from 'node:fs';
import path from 'node:path';

const BEGIN = '# sundial-mcp:begin (written by `sundial mcp-hosts`; `sundial mcp-hosts --remove` takes it out)';
const END = '# sundial-mcp:end';

/** Where each host keeps its servers, under HOME, and how to tell the host is installed (its folder exists). */
export const HOSTS = {
  vscode: { title: 'VS Code', file: 'Library/Application Support/Code/User/mcp.json', installed: 'Library/Application Support/Code', kind: 'json', key: 'servers', typed: true },
  cursor: { title: 'Cursor', file: '.cursor/mcp.json', installed: '.cursor', kind: 'json', key: 'mcpServers' },
  gemini: { title: 'Gemini CLI', file: '.gemini/settings.json', installed: '.gemini', kind: 'json', key: 'mcpServers' },
  'claude-desktop': { title: 'Claude Desktop', file: 'Library/Application Support/Claude/claude_desktop_config.json', installed: 'Library/Application Support/Claude', kind: 'json', key: 'mcpServers' },
  codex: { title: 'Codex', file: '.codex/config.toml', installed: '.codex', kind: 'toml' },
  goose: { title: 'Goose', file: '.config/goose/config.yaml', installed: '.config/goose', kind: 'yaml' },
};

export const serverBin = (repo) => path.join(repo, 'packages', 'mcp', 'bin', 'sundial-mcp.js');

/** The hosts whose folder exists under `home`. */
export const installedHosts = (home) => Object.keys(HOSTS).filter((name) => fs.existsSync(path.join(home, HOSTS[name].installed)));

const q = (s) => JSON.stringify(String(s));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** Ours: an entry whose args name this checkout's server. */
const ours = (entry, bin) => Array.isArray(entry?.args) && entry.args.includes(bin);

function tomlBlock(node, bin, sundialHome) {
  return `${BEGIN}\n[mcp_servers.sundial]\ncommand = ${q(node)}\nargs = [${q(bin)}]\nenv = { SUNDIAL_HOME = ${q(sundialHome)} }\n${END}\n`;
}
function yamlBlock(node, bin, sundialHome) {
  return `  ${BEGIN}\n  sundial:\n    enabled: true\n    type: stdio\n    name: sundial\n    cmd: ${q(node)}\n    args:\n      - ${q(bin)}\n    envs:\n      SUNDIAL_HOME: ${q(sundialHome)}\n    timeout: 300\n  ${END}\n`;
}
const withoutBlock = (text) => text.replace(/^[ \t]*# sundial-mcp:begin[^\n]*\n[\s\S]*?^[ \t]*# sundial-mcp:end[^\n]*\n?/m, '');
const hasBlock = (text) => /# sundial-mcp:begin/.test(text);

/**
 * Writes one host's entry. Returns what happened, for the CLI to say:
 * `{ did: 'added' | 'kept' | 'skipped', file, why? }`.
 */
export function installHost(name, { home, repo, sundialHome, node = process.execPath }) {
  const host = HOSTS[name];
  if (!host) throw new Error(`No such host: ${name}. Hosts: ${Object.keys(HOSTS).join(', ')}`);
  const file = path.join(home, host.file);
  const bin = serverBin(repo);
  if (host.kind === 'json') {
    const config = readJson(file);
    const servers = (config[host.key] ??= {});
    if (servers.sundial && !ours(servers.sundial, bin)) return { did: 'skipped', file, why: 'an entry named sundial that is not this checkout\'s is already there' };
    const entry = { ...(host.typed ? { type: 'stdio' } : {}), command: node, args: [bin], env: { SUNDIAL_HOME: sundialHome } };
    const kept = JSON.stringify(servers.sundial) === JSON.stringify(entry);
    servers.sundial = entry;
    write(file, `${JSON.stringify(config, null, 2)}\n`);
    return { did: kept ? 'kept' : 'added', file };
  }
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const bare = withoutBlock(text);
  if (host.kind === 'toml') {
    if (/^\s*\[mcp_servers\.sundial\]/m.test(bare)) return { did: 'skipped', file, why: 'a [mcp_servers.sundial] table that is not ours is already there' };
    const block = tomlBlock(node, bin, sundialHome);
    const next = `${bare.trimEnd()}${bare.trim() ? '\n\n' : ''}${block}`;
    const kept = text === next;
    if (!kept) write(file, next);
    return { did: kept ? 'kept' : 'added', file };
  }
  // yaml
  if (/^  sundial:\s*$/m.test(bare)) return { did: 'skipped', file, why: 'an extensions.sundial that is not ours is already there' };
  const block = yamlBlock(node, bin, sundialHome);
  const match = bare.match(/^extensions:[ \t]*\n/m);
  const next = match ? `${bare.slice(0, match.index + match[0].length)}${block}${bare.slice(match.index + match[0].length)}` : `${bare.trimEnd()}${bare.trim() ? '\n\n' : ''}extensions:\n${block}`;
  const kept = text === next;
  if (!kept) write(file, next);
  return { did: kept ? 'kept' : 'added', file };
}

/** Takes one host's entry out, only when it is ours. `{ did: 'removed' | 'none' | 'skipped', file, why? }`. */
export function removeHost(name, { home, repo }) {
  const host = HOSTS[name];
  if (!host) throw new Error(`No such host: ${name}. Hosts: ${Object.keys(HOSTS).join(', ')}`);
  const file = path.join(home, host.file);
  if (!fs.existsSync(file)) return { did: 'none', file };
  const bin = serverBin(repo);
  if (host.kind === 'json') {
    const config = readJson(file);
    const servers = config[host.key];
    if (!servers?.sundial) return { did: 'none', file };
    if (!ours(servers.sundial, bin)) return { did: 'skipped', file, why: 'the sundial entry there is not this checkout\'s' };
    delete servers.sundial;
    write(file, `${JSON.stringify(config, null, 2)}\n`);
    return { did: 'removed', file };
  }
  const text = fs.readFileSync(file, 'utf8');
  if (!hasBlock(text)) return { did: 'none', file };
  if (!withoutBlock(text).includes(bin) && !text.includes(bin)) return { did: 'skipped', file, why: 'the marked block there names another checkout' };
  // What was written was the block and the blank line before it; both go. A Goose file left with a
  // bare `extensions:` and nothing under it is still valid YAML, and is left.
  const bare = withoutBlock(text).replace(/\n{3,}/g, '\n\n').trimEnd();
  write(file, bare === '' ? '' : `${bare}\n`);
  return { did: 'removed', file };
}
