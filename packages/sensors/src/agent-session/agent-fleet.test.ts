import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyTail, readAgentFleet, summarizeTail, MAX_FLEET } from './agent-fleet.js';

const rec = (type: string, ts: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, timestamp: ts, cwd: '/Users/o/p', gitBranch: 'main', entrypoint: 'cli', ...extra });
const prompt = (ts: string) => rec('user', ts, { message: { role: 'user', content: 'secret words' } });
const result = (ts: string) => rec('user', ts, { message: { content: [{ type: 'tool_result', content: 'x' }] } });
const said = (ts: string, stop: string | null) => rec('assistant', ts, { message: { stop_reason: stop, content: [{ type: 'text', text: 'secret' }] } });
const calls = (ts: string, name: string) => rec('assistant', ts, { message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input: { q: 'secret' } }] } });

describe('classifyTail', () => {
  it('an ended turn is waiting, since the answer', () => {
    expect(classifyTail([prompt('t1'), said('t2', 'tool_use'), result('t3'), said('t4', 'end_turn')])).toEqual({ cwd: '/Users/o/p', branch: 'main', state: 'waiting', since: 't4' });
  });
  it('a tool call with no result is tool, since the call', () => {
    expect(classifyTail([prompt('t1'), calls('t2', 'Bash')])?.state).toBe('tool');
  });
  it('mid-turn is working, since the owner\'s prompt — a tool result is not a prompt', () => {
    expect(classifyTail([prompt('t1'), said('t2', 'tool_use'), result('t3')])).toMatchObject({ state: 'working', since: 't1' });
  });
  it('skips sidechains and other record types, and copies no text', () => {
    const out = classifyTail([prompt('t1'), said('t2', 'end_turn'), rec('assistant', 't3', { isSidechain: true, message: { stop_reason: 'tool_use' } }), rec('attachment', 't4')]);
    expect(out?.state).toBe('waiting');
    expect(JSON.stringify(out)).not.toContain('secret');
  });
  it('a pending AskUserQuestion is a question, ExitPlanMode a plan (U3-F5)', () => {
    expect(classifyTail([prompt('t1'), calls('t2', 'AskUserQuestion')])?.state).toBe('question');
    expect(classifyTail([prompt('t1'), calls('t2', 'ExitPlanMode')])?.state).toBe('plan');
  });
  it('a turn that ended on an API error is failed, with the error type (U3-F6)', () => {
    const tail = summarizeTail([prompt('t1'), rec('assistant', 't2', { isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: 'secret' }] } })]);
    expect(tail).toMatchObject({ state: 'failed', since: 't2', error: 'rate_limit' });
  });
});

describe('summarizeTail work in progress', () => {
  it('a pending subagent call is work, not a tool waiting on anything (U3-F9)', () => {
    expect(classifyTail([prompt('t1'), calls('t2', 'Agent')])?.state).toBe('working');
  });
  it('counts the same failing call in a row, and nothing else of the input (U3-F33)', () => {
    const fail = (ts: string) => rec('user', ts, { message: { content: [{ type: 'tool_result', is_error: true, content: 'secret' }] } });
    const lines = [prompt('t0')];
    for (let i = 0; i < 4; i++) lines.push(calls(`a${i}`, 'Bash'), fail(`r${i}`));
    const tail = summarizeTail(lines);
    expect(tail?.repeats).toBe(4);
    expect(JSON.stringify(tail)).not.toContain('secret');
    expect(summarizeTail([...lines, calls('b', 'Read'), fail('rb')])?.repeats).toBeUndefined();
    expect(summarizeTail([...lines, prompt('p2')])?.repeats).toBeUndefined();
  });
});

describe('summarizeTail metadata', () => {
  it('carries title, capped last prompt, the last finished reply, cost and PR, and no other message text', () => {
    const tail = summarizeTail([
      prompt('t1'),
      said('t2', 'end_turn'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Generated', sessionId: 's' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Fix the checkout timeout', sessionId: 's' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: `make it ${'x'.repeat(300)}`, sessionId: 's' }),
      JSON.stringify({ type: 'cost-state', totalCostUSD: 1.23456, totalLinesAdded: 120, totalLinesRemoved: 30, sessionId: 's' }),
      JSON.stringify({ type: 'pr-link', prNumber: 42, prUrl: 'https://github.com/acme/puzzlebox-studio/pull/42', prRepository: 'acme/puzzlebox-studio', timestamp: 't3' }),
    ]);
    expect(tail).toMatchObject({ title: 'Fix the checkout timeout', costUsd: 1.23, lines: { added: 120, removed: 30 }, pr: { number: 42 } });
    expect(tail!.lastPrompt!.length).toBe(200);
    const { lastReply, ...rest } = tail!;
    expect(lastReply).toBe('secret');
    expect(JSON.stringify(rest)).not.toContain('secret');
  });
});

describe('readAgentFleet', () => {
  let root: string;
  const NOW = Date.parse('2026-09-28T12:00:00.000Z');
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const transcript = (dir: string, sessionId: string, lines: string[], mtimeAgoMin = 0) => {
    fs.mkdirSync(path.join(root, 'projects', dir), { recursive: true });
    const file = path.join(root, 'projects', dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const t = (NOW - mtimeAgoMin * 60_000) / 1000;
    fs.utimesSync(file, t, t);
  };
  const registry = (pid: number, r: Record<string, unknown>) => {
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sessions', `${pid}.json`), JSON.stringify({ pid, cwd: '/Users/o/p', kind: 'interactive', entrypoint: 'claude-desktop', pidDomain: process.platform, ...r }));
  };
  const job = (id: string, j: Record<string, unknown>) => {
    fs.mkdirSync(path.join(root, 'jobs', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'jobs', id, 'state.json'), JSON.stringify({ cwd: '/Users/o/q', backend: 'daemon', template: 'bg', ...j }));
  };
  const alive = (...pids: number[]) => ({ pidAlive: (pid: number) => pids.includes(pid) });

  it('without a registry: windows transcripts by their last message, not their mtime (U3-F2)', () => {
    transcript('a', 'abcdef123456', [prompt(ago(10)), said(ago(9), 'end_turn')]);
    transcript('h', 'hand', [rec('assistant', ago(1), { cwd: '/Users/o/.sundial/.daemon/hands', message: { stop_reason: 'end_turn' } })]);
    // A month-old wait whose file was touched now by an appended cost-state record.
    transcript('o', 'oldold00', [prompt(ago(60 * 24 * 30)), said(ago(60 * 24 * 30), 'end_turn'), JSON.stringify({ type: 'cost-state', totalCostUSD: 1 })]);
    expect(readAgentFleet(NOW, root)).toEqual({ sessions: [{ id: 'abcdef12', sid: 'abcdef123456', cwd: '/Users/o/p', branch: 'main', state: 'waiting', since: ago(9), source: 'transcript', origin: 'cli', lastReply: 'secret' }], truncated: 0 });
  });

  it('the registry decides liveness and state: a dead pid is dropped, waitingFor names the wait (U3-F4)', () => {
    registry(101, { sessionId: 'live0001-aaaa', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - 120_000, name: 'Fix the checkout timeout' });
    registry(102, { sessionId: 'dead0002-bbbb', status: 'idle', statusUpdatedAt: NOW - 60_000 });
    registry(103, { sessionId: 'busy0003-cccc', status: 'busy', statusUpdatedAt: NOW - 30_000 });
    // Background subagents: the transcript says done, the registry says busy (U3-F9).
    transcript('p', 'busy0003-cccc', [prompt(ago(2)), said(ago(1), 'end_turn')]);
    const { sessions } = readAgentFleet(NOW, root, alive(101, 103));
    expect(sessions.map((s) => [s.id, s.state, s.source, s.origin])).toEqual([
      ['busy0003', 'working', 'registry', 'desktop'],
      ['live0001', 'permission', 'registry', 'desktop'],
    ]);
    expect(sessions[1]).toMatchObject({ since: ago(2), title: 'Fix the checkout timeout' });
  });

  it('a busy session long on one tool call is reported as tool; a short call stays working (U3-F32)', () => {
    registry(1, { sessionId: 'long0001', status: 'busy', statusUpdatedAt: NOW - 20 * 60_000 });
    transcript('a', 'long0001', [prompt(ago(20)), calls(ago(18), 'Bash')]);
    registry(2, { sessionId: 'shrt0002', status: 'busy', statusUpdatedAt: NOW - 20 * 60_000 });
    transcript('b', 'shrt0002', [prompt(ago(20)), calls(ago(1), 'Bash')]);
    const byId = Object.fromEntries(readAgentFleet(NOW, root, alive(1, 2)).sessions.map((s) => [s.id, s]));
    expect(byId.long0001).toMatchObject({ state: 'tool', since: ago(18), source: 'registry' });
    expect(byId.shrt0002.state).toBe('working');
  });

  it('a pid from another pid domain counts while its entry is fresh', () => {
    registry(1, { sessionId: 'vm000001', status: 'idle', pidDomain: 'vm', updatedAt: NOW - 60_000 });
    registry(2, { sessionId: 'vm000002', status: 'idle', pidDomain: 'vm', updatedAt: NOW - 7 * 3600_000 });
    expect(readAgentFleet(NOW, root, alive()).sessions.map((s) => s.id)).toEqual(['vm000001']);
  });

  it('with a registry, a transcript-only session that finished is gone; one mid-turn a moment ago stays', () => {
    registry(101, { sessionId: 'live0001', status: 'idle', statusUpdatedAt: NOW });
    transcript('a', 'quit0001', [prompt(ago(20)), said(ago(19), 'end_turn')]);
    transcript('b', 'run00002', [prompt(ago(3)), calls(ago(2), 'Bash')]);
    transcript('c', 'cold0003', [prompt(ago(90)), calls(ago(80), 'Bash')]);
    expect(readAgentFleet(NOW, root, alive(101)).sessions.map((s) => s.id)).toEqual(['live0001', 'run00002']);
  });

  it('a session that ended in the window with a cost or a PR is reported as ended, not as live (use case 19)', () => {
    registry(101, { sessionId: 'live0001', status: 'idle', statusUpdatedAt: NOW });
    const cost = JSON.stringify({ type: 'cost-state', totalCostUSD: 2.5, totalLinesAdded: 10, totalLinesRemoved: 2 });
    const pr = JSON.stringify({ type: 'pr-link', prNumber: 42, prUrl: 'https://github.com/acme/puzzlebox-studio/pull/42' });
    transcript('a', 'done0001', [prompt(ago(50)), said(ago(40), 'end_turn'), cost, pr]);
    transcript('b', 'done0002', [prompt(ago(50)), said(ago(40), 'end_turn')]);
    transcript('c', 'olddone3', [prompt(ago(60 * 24 * 3)), said(ago(60 * 24 * 3), 'end_turn'), cost]);
    const out = readAgentFleet(NOW, root, alive(101));
    expect(out.sessions.map((s) => s.id)).toEqual(['live0001']);
    expect(out.ended).toEqual([{ id: 'done0001', sid: 'done0001', cwd: '/Users/o/p', branch: 'main', lastAt: ago(40), costUsd: 2.5, lines: { added: 10, removed: 2 }, pr: { number: 42, url: 'https://github.com/acme/puzzlebox-studio/pull/42' } }]);
  });

  it('the transcript refines the registry: input needed behind ExitPlanMode is a plan, idle after an API error is failed', () => {
    registry(1, { sessionId: 'plan0001', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW });
    transcript('a', 'plan0001', [prompt(ago(5)), calls(ago(4), 'ExitPlanMode')]);
    registry(2, { sessionId: 'fail0002', status: 'idle', statusUpdatedAt: NOW });
    transcript('b', 'fail0002', [prompt(ago(5)), rec('assistant', ago(4), { isApiErrorMessage: true, error: 'server_error' })]);
    registry(3, { sessionId: 'askd0003', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW });
    const byId = Object.fromEntries(readAgentFleet(NOW, root, alive(1, 2, 3)).sessions.map((s) => [s.id, s]));
    expect(byId.plan0001).toMatchObject({ state: 'plan', since: ago(4) });
    expect(byId.fail0002).toMatchObject({ state: 'failed', error: 'server_error' });
    expect(byId.askd0003.state).toBe('question');
  });

  it('background jobs join the fleet; a stale or stopped one does not (U3-F7)', () => {
    job('j1', { sessionId: 'job00001', state: 'blocked', detail: 'Waiting for permission', updatedAt: ago(10), name: 'Nightly refactor' });
    job('j2', { sessionId: 'job00002', state: 'blocked', updatedAt: ago(60 * 24 * 100) });
    job('j3', { sessionId: 'job00003', state: 'stopped', updatedAt: ago(1) });
    registry(7, { sessionId: 'job00004', status: 'busy', statusUpdatedAt: NOW });
    job('j4', { sessionId: 'job00004', state: 'working', updatedAt: ago(1) });
    const { sessions } = readAgentFleet(NOW, root, alive(7));
    expect(sessions.map((s) => [s.id, s.state, s.source, s.origin])).toEqual([
      ['job00004', 'working', 'registry', 'bg'],
      ['job00001', 'permission', 'job', 'bg'],
    ]);
    expect(sessions[1].title).toBe('Nightly refactor');
  });

  it('the cap applies after stale sessions are dropped, and says how many it cut (U3-F3)', () => {
    for (let i = 0; i < 20; i++) transcript(`s${i}`, `stale${String(i).padStart(3, '0')}`, [prompt(ago(60 * 24 * 40)), said(ago(60 * 24 * 40), 'end_turn')]);
    for (let i = 0; i < MAX_FLEET + 2; i++) registry(200 + i, { sessionId: `live${String(i).padStart(4, '0')}`, status: 'idle', statusUpdatedAt: NOW - i * 1000 });
    const { sessions, truncated } = readAgentFleet(NOW, root, { pidAlive: () => true });
    expect(sessions).toHaveLength(MAX_FLEET);
    expect(sessions.every((s) => s.id.startsWith('live'))).toBe(true);
    expect(truncated).toBe(2);
  });
});
