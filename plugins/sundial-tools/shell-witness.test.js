// The shell witness: dsh's own `bash` calls become hook-file entries, so an
// agent's commands reach the same `shell:command` record a typed command does.
import { describe, it, expect, vi } from 'vitest';
import { createShellWitness, extractExitCode, extractShellCommand, SHELL_TOOL_NAMES } from './shell-witness.js';

const ok = (value) => ({ isError: false, value, content: [] });
const failed = () => ({ isError: true, error: { code: 'TOOL_TIMEOUT' }, content: [] });

function witnessWith(overrides = {}) {
  const append = vi.fn(() => true);
  const witness = createShellWitness({ getDefaultCwd: () => '/workspace', append, ...overrides });
  return { append, witness };
}

describe('extractShellCommand', () => {
  it('reads the command and explicit workdir off a bash call', () => {
    expect(extractShellCommand({ name: 'bash', arguments: { command: 'npm test', workdir: '/repo' } }, '/workspace')).toEqual({
      command: 'npm test',
      cwd: '/repo',
      background: false,
    });
  });

  it('falls back to the session cwd when the call omits workdir — cwd is how a command gets attributed later', () => {
    expect(extractShellCommand({ name: 'bash', arguments: { command: 'ls' } }, '/workspace')?.cwd).toBe('/workspace');
  });

  it('flags a backgrounded call', () => {
    expect(extractShellCommand({ name: 'bash', arguments: { command: 'sleep 60', run_in_background: true } })?.background).toBe(true);
  });

  it('ignores tools that are not shells', () => {
    expect(extractShellCommand({ name: 'read', arguments: { command: 'not a shell' } })).toBeNull();
    expect(extractShellCommand({ name: 'grep', arguments: { pattern: 'x' } })).toBeNull();
  });

  it('ignores gnomon_run_shell — it writes its own entry, with a real exit code and duration', () => {
    expect(SHELL_TOOL_NAMES.has('gnomon_run_shell')).toBe(false);
    expect(extractShellCommand({ name: 'gnomon_run_shell', arguments: { command: 'ls' } })).toBeNull();
  });

  it('ignores a call with no command, or malformed arguments', () => {
    expect(extractShellCommand({ name: 'bash', arguments: { command: '  ' } })).toBeNull();
    expect(extractShellCommand({ name: 'bash', arguments: null })).toBeNull();
    expect(extractShellCommand(null)).toBeNull();
  });
});

describe('extractExitCode', () => {
  it('reads the exit code off a successful result', () => {
    expect(extractExitCode(ok({ exitCode: 0 }))).toBe(0);
    expect(extractExitCode(ok({ exit_code: 127 }))).toBe(127);
  });

  it('keeps a NON-ZERO exit — the command ran, it just failed', () => {
    expect(extractExitCode(ok({ exitCode: 1 }))).toBe(1);
  });

  it('returns null for a failed tool call rather than inventing a code', () => {
    expect(extractExitCode(failed())).toBeNull();
  });

  it('returns null when the value carries no code', () => {
    expect(extractExitCode(ok({ stdout: 'hi' }))).toBeNull();
    expect(extractExitCode(ok('plain text'))).toBeNull();
  });
});

describe('createShellWitness', () => {
  it('records a bash call with its command, cwd and exit code', () => {
    const { append, witness } = witnessWith();
    witness({ name: 'bash', arguments: { command: 'npm test', workdir: '/repo' } }, ok({ exitCode: 0 }));

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith({ command: 'npm test', cwd: '/repo', exitCode: 0 });
  });

  it('records a command that failed, so "did that work?" is answerable', () => {
    const { append, witness } = witnessWith();
    witness({ name: 'bash', arguments: { command: 'exit 3' } }, ok({ exitCode: 3 }));
    expect(append.mock.calls[0][0].exitCode).toBe(3);
  });

  it('records a backgrounded command with no exit code — it has not finished', () => {
    const { append, witness } = witnessWith();
    witness({ name: 'bash', arguments: { command: 'sleep 60', run_in_background: true } }, ok({ jobId: 'bash-1', exitCode: 0 }));
    expect(append.mock.calls[0][0]).toEqual({ command: 'sleep 60', cwd: '/workspace', exitCode: null });
  });

  it('records the command even when the tool call itself errored — it still ran', () => {
    const { append, witness } = witnessWith();
    witness({ name: 'bash', arguments: { command: 'sleep 999' } }, failed());
    expect(append).toHaveBeenCalledWith({ command: 'sleep 999', cwd: '/workspace', exitCode: null });
  });

  it('writes nothing for a non-shell tool', () => {
    const { append, witness } = witnessWith();
    witness({ name: 'read', arguments: { path: '/etc/hosts' } }, ok({ text: 'x' }));
    expect(append).not.toHaveBeenCalled();
  });

  it('is contained: a throwing cwd resolver must not break the tool pipeline', () => {
    const { append, witness } = witnessWith({
      getDefaultCwd: () => {
        throw new Error('no cwd');
      },
    });
    expect(() => witness({ name: 'bash', arguments: { command: 'ls' } }, ok({ exitCode: 0 }))).not.toThrow();
    expect(append).not.toHaveBeenCalled();
  });
});
