import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentTurnSensor, decodeDashedPath, readClaude, readCodex, readCopilot, readCursor, readGemini, QUIET_MS, TURN_CHARS, type FileCtx } from './agent-turns.js';

const ctx = (): FileCtx => ({ sid: 'f0000000-0000-0000-0000-000000000001', cwd: null });
const cc = (type: string, extra: Record<string, unknown> = {}) => ({ type, timestamp: '2026-10-05T09:00:00.000Z', sessionId: 'a1b2c3d4-0000', cwd: '/Users/mira/puzzlebox-studio', gitBranch: 'BOX-484-fix', ...extra });

describe('readClaude', () => {
  it('keeps a typed prompt and the reply that ended the turn, with cwd and branch', () => {
    const c = ctx();
    expect(readClaude(cc('user', { message: { content: 'push before standup' } }), c)).toEqual([{ role: 'prompt', text: 'push before standup', at: '2026-10-05T09:00:00.000Z' }]);
    expect(readClaude(cc('assistant', { message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Pushed.' }] } }), c)).toMatchObject([{ role: 'reply', text: 'Pushed.' }]);
    expect(c).toMatchObject({ sid: 'a1b2c3d4-0000', cwd: '/Users/mira/puzzlebox-studio', branch: 'BOX-484-fix' });
  });
  it('drops mid-turn text, tool calls and results, thinking, injected blocks and meta records', () => {
    const c = ctx();
    const none = [
      cc('assistant', { message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', name: 'Bash', input: { command: 'cat .env' } }] } }),
      cc('user', { message: { content: [{ type: 'tool_result', content: 'DB_PASSWORD=hunter2' }] } }),
      cc('assistant', { message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hm' }] } }),
      cc('user', { message: { content: '<command-name>/clear</command-name>' } }),
      cc('user', { isMeta: true, message: { content: 'Caveat: local command' } }),
      cc('user', { isSidechain: true, message: { content: 'a subagent prompt' } }),
      cc('user', { message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } }),
    ];
    expect(none.flatMap((r) => readClaude(r, c))).toEqual([]);
  });
  it('a rejected tool use names the tool and keeps the reason the owner typed', () => {
    const c = ctx();
    readClaude(cc('assistant', { message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }), c);
    const out = readClaude(cc('user', { message: { content: [{ type: 'tool_result', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected. the user said:\nno, keep the old name" }] } }), c);
    expect(out).toMatchObject([{ role: 'rejected', tool: 'Edit', text: 'no, keep the old name' }]);
    expect(readClaude(cc('user', { message: { content: '[Request interrupted by user]' } }), c)).toMatchObject([{ role: 'rejected', text: '' }]);
  });
});

describe('the other agents', () => {
  it('codex: session_meta sets the context, task_complete is the final reply', () => {
    const c = ctx();
    expect(readCodex({ type: 'session_meta', payload: { id: 'c0dex-1', cwd: '/Users/mira/p', git: { branch: 'main' } } }, c)).toEqual([]);
    expect(c).toMatchObject({ sid: 'c0dex-1', cwd: '/Users/mira/p', branch: 'main' });
    expect(readCodex({ timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'make f01.txt' } }, c)).toMatchObject([{ role: 'prompt', text: 'make f01.txt' }]);
    expect(readCodex({ type: 'event_msg', payload: { type: 'agent_message', message: 'I will…' } }, c)).toMatchObject([{ role: 'reply', held: true }]);
    expect(readCodex({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done.' } }, c)).toMatchObject([{ role: 'reply', text: 'Done.' }]);
    expect(readCodex({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }, c)).toMatchObject([{ role: 'rejected' }]);
  });
  it('gemini: a prompt upserted twice is logged once; a gemini message is held', () => {
    const c = ctx();
    const p = { id: 'm1', type: 'user', content: [{ text: 'explain the failure' }] };
    expect(readGemini(p, c)).toMatchObject([{ role: 'prompt', text: 'explain the failure' }]);
    expect(readGemini(p, c)).toEqual([]);
    expect(readGemini({ id: 'm2', type: 'gemini', content: 'The fixture is stale.' }, c)).toMatchObject([{ role: 'reply', held: true }]);
  });
  it('copilot: strips the injected clock, skips a subagent', () => {
    const c = ctx();
    readCopilot({ type: 'session.start', data: { sessionId: 's1', context: { cwd: '/Users/mira/p', branch: 'dev' } } }, c);
    expect(c).toMatchObject({ sid: 's1', cwd: '/Users/mira/p', branch: 'dev' });
    expect(readCopilot({ type: 'user.message', data: { content: '<current_datetime>now</current_datetime>rename it' } }, c)).toMatchObject([{ role: 'prompt', text: 'rename it' }]);
    expect(readCopilot({ type: 'assistant.message', data: { content: 'sub', parentToolCallId: 'x' } }, c)).toEqual([]);
    expect(readCopilot({ type: 'assistant.message', data: { content: 'Renamed.', toolRequests: [] } }, c)).toMatchObject([{ role: 'reply', held: true }]);
  });
  it('cursor: the words inside <user_query>, never the attached files', () => {
    const out = readCursor({ role: 'user', message: { content: [{ type: 'text', text: '<image_files>a.png</image_files>\n<user_query>\nwhy is BOX-484 red\n</user_query>' }] } }, ctx());
    expect(out).toMatchObject([{ role: 'prompt', text: '\nwhy is BOX-484 red\n' }]);
    expect(readCursor({ role: 'assistant', message: { content: [{ type: 'text', text: 'The test.' }] } }, ctx())).toMatchObject([{ role: 'reply', held: true }]);
  });
  it('decodes a dashed folder name against the disk, keeping the hyphens that were there', () => {
    const real = new Set(['/Users', '/Users/mira', '/Users/mira/puzzlebox-studio', '/Users/mira/puzzlebox-studio/web-app']);
    expect(decodeDashedPath('Users-mira-puzzlebox-studio-web-app', (p) => real.has(p))).toBe('/Users/mira/puzzlebox-studio/web-app');
    expect(decodeDashedPath('empty-window', () => false)).toBeNull();
  });
});

describe('AgentTurnSensor', () => {
  let home: string;
  let daemon: string;
  const T0 = Date.now();
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
  const claudeFile = () => path.join(home, '.claude', 'projects', '-Users-mira-p', 'a1b2c3d4-0000.jsonl');
  const sensor = (now = T0) => new AgentTurnSensor({ home, cursorPath: path.join(daemon, 'agent-turns.json'), opencodeDb: path.join(home, 'none.db'), now });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'turns-'));
    daemon = path.join(home, '.daemon');
    fs.mkdirSync(daemon);
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('reads a live session\'s history once on its first run, then every new turn, across a restart', async () => {
    fs.writeFileSync(claudeFile(), line(cc('user', { message: { content: 'old history' } })));
    const s = sensor(T0 + 1000);
    expect((await s.poll(T0 + 1000)).map((e) => e.payload.text)).toEqual(['old history']);
    fs.appendFileSync(claudeFile(), line(cc('user', { message: { content: 'fix the DNS root cause' } })));
    const got = await s.poll(T0 + 20_000);
    expect(got.map((e) => [e.type, e.payload.role, e.payload.text, e.payload.session, e.payload.cwd, e.payload.branch])).toEqual([['agent:turn', 'prompt', 'fix the DNS root cause', 'a1b2c3d4', '/Users/mira/puzzlebox-studio', 'BOX-484-fix']]);
    // Down for a while: a turn written meanwhile is read by the next sensor.
    fs.appendFileSync(claudeFile(), line(cc('assistant', { message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Found it.' }] } })));
    expect((await sensor(T0 + 60_000).poll(T0 + 60_000)).map((e) => e.payload.text)).toEqual(['Found it.']);
  });

  it('a cursor from before the backfill: reads each file\'s turns from before the cursor was made, once, and none twice', async () => {
    const cursorPath = path.join(daemon, 'agent-turns.json');
    const old = { ...cc('user', { message: { content: 'the first prompt' } }), timestamp: new Date(T0 - 3_600_000).toISOString() };
    const logged = { ...cc('user', { message: { content: 'already logged' } }), timestamp: new Date(T0 + 3_600_000).toISOString() };
    fs.writeFileSync(claudeFile(), line(old) + line(logged));
    fs.writeFileSync(cursorPath, JSON.stringify({ savedAt: T0, files: { [claudeFile()]: { offset: fs.statSync(claudeFile()).size } } }));
    const s = new AgentTurnSensor({ home, cursorPath, opencodeDb: path.join(home, 'none.db') });
    expect((await s.poll(Date.now() + 20_000)).map((e) => e.payload.text)).toEqual(['the first prompt']);
    expect(await s.poll(Date.now() + 40_000)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(cursorPath, 'utf8'))).toMatchObject({ v: 2 });
  });

  it('a live session quiet for hours is backfilled from the registry once, then tailed with no turn twice', async () => {
    const old = { ...cc('user', { message: { content: 'the ask from this morning' } }), timestamp: new Date(T0 - 8 * 3_600_000).toISOString() };
    fs.writeFileSync(claudeFile(), line(old));
    const eightHoursAgo = (T0 - 8 * 3_600_000) / 1000;
    fs.utimesSync(claudeFile(), eightHoursAgo, eightHoursAgo);
    fs.mkdirSync(path.join(home, '.claude', 'sessions'));
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '123.json'), JSON.stringify({ sessionId: 'a1b2c3d4-0000', pid: 123 }));
    const s = sensor(T0);
    expect((await s.poll(T0)).map((e) => e.payload.text)).toEqual(['the ask from this morning']);
    fs.appendFileSync(claudeFile(), line({ ...cc('user', { message: { content: 'back at it' } }), timestamp: new Date().toISOString() }));
    expect((await s.poll(T0 + 20_000)).map((e) => e.payload.text)).toEqual(['back at it']);
  });

  it('reads a session created after the cursor from its start, and caps the text', async () => {
    const s = sensor(T0 - 5000);
    await s.poll(T0 - 5000);
    fs.writeFileSync(claudeFile(), line(cc('user', { message: { content: 'x'.repeat(TURN_CHARS + 50) } })));
    const [e] = await s.poll(T0 + 20_000);
    expect(e?.payload.text.length).toBe(TURN_CHARS);
  });

  it('skips a record bigger than one read without losing the lines after it', async () => {
    const s = sensor(T0 - 5000);
    await s.poll(T0 - 5000);
    fs.writeFileSync(claudeFile(), `${JSON.stringify({ type: 'user', blob: 'y'.repeat(9 * 1024 * 1024) })}\n${line(cc('user', { message: { content: 'after the blob' } }))}`);
    const texts: string[] = [];
    for (let i = 1; i <= 3; i++) texts.push(...(await s.poll(T0 + i * 20_000)).map((e) => e.payload.text));
    expect(texts).toEqual(['after the blob']);
  });

  it('logs a held reply when the owner prompts again, or once the session is quiet', async () => {
    const dir = path.join(home, '.cursor', 'projects', 'empty-window', 'agent-transcripts', 'cur-1');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'cur-1.jsonl');
    const s = sensor(T0 - 5000);
    await s.poll(T0 - 5000);
    fs.writeFileSync(file, line({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>hi</user_query>' }] } }) + line({ role: 'assistant', message: { content: [{ type: 'text', text: 'looking' }] } }) + line({ role: 'assistant', message: { content: [{ type: 'text', text: 'Fixed.' }] } }));
    const now = Date.now();
    expect((await s.poll(now + 20_000)).map((e) => [e.payload.agent, e.payload.role, e.payload.text])).toEqual([['cursor', 'prompt', 'hi']]);
    expect((await s.poll(now + QUIET_MS + 40_000)).map((e) => [e.payload.role, e.payload.text])).toEqual([['reply', 'Fixed.']]);
  });

  it('is silent when switched off', async () => {
    const s = new AgentTurnSensor({ enabled: false, home, cursorPath: path.join(daemon, 'agent-turns.json') });
    fs.writeFileSync(claudeFile(), line(cc('user', { message: { content: 'anything' } })));
    expect(await s.poll()).toEqual([]);
  });
});
