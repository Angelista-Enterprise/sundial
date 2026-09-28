import { describe, expect, it } from 'vitest';
import { isOwnerMessage, liveFrames, parseLoose, replayFrames, streamFrames, textOf, titleFrom } from './frames.js';

// One `agent/assistant-stream` chunk publication, the shape dsh 0.1.5 emits.
const chunk = (c) => ({ type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 0, chunk: c });
const said = (text, source) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], ...(source ? { source } : {}) } });
// dsh's own title, latest-wins and log-only — never on the model surface.
const titled = (title) => ({ type: 'session/title', data: { title, messageSeqs: [], source: 'provider' } });
// dsh appends this only after a `present` call succeeded.
const presented = (files, callId = 'c9') => ({ type: 'deliverables/presented', data: { turn: 1, callId, files } });
const answered = (text) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } });
const called = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args ?? {}) } });
const returned = (callId, extra = {}) => ({
  type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', toolCallId: callId, content: [] }] }, ...extra },
});

describe('textOf', () => {
  it('joins the text blocks and ignores everything else', () => {
    expect(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('ab');
  });

  it('takes a plain string, and is empty rather than undefined on nothing', () => {
    expect(textOf({ content: 'hello' })).toBe('hello');
    expect(textOf(undefined)).toBe('');
  });
});

// A notice, a skill, an injected place caption — all real, all model-visible,
// none of them words the owner typed. Drawing them as the owner's own turn puts
// sentences in their mouth.
describe('isOwnerMessage', () => {
  it('accepts a bare or human-sourced message', () => {
    expect(isOwnerMessage({})).toBe(true);
    expect(isOwnerMessage({ source: { kind: 'user' } })).toBe(true);
  });

  it('rejects injected plugin context', () => {
    expect(isOwnerMessage({ source: { kind: 'plugin', plugin: 'sundial-proactive' } })).toBe(false);
  });
});

describe('liveFrames', () => {
  it('streams assistant text one delta at a time', () => {
    expect(streamFrames(chunk({ type: 'text-delta', text: 'Four ' }))).toEqual([{ type: 'text', delta: 'Four ' }]);
  });

  it('announces reasoning without ever forwarding its text', () => {
    const frames = streamFrames(chunk({ type: 'reasoning-delta', text: 'the owner probably means...' }));
    expect(frames).toEqual([{ type: 'thinking' }]);
    expect(JSON.stringify(frames)).not.toContain('owner probably');
  });

  it('echoes the owner from the LOG, so a second window watching sees it too', () => {
    expect(liveFrames(said('what did I do today?'))).toEqual([{ type: 'user', text: 'what did I do today?' }]);
    expect(liveFrames(said('Gnomon noticed something', { kind: 'plugin', plugin: 'sundial-proactive' }))).toEqual([]);
  });

  it('turns a show_surface call into a surface and anything else into a work row', () => {
    const args = { kind: 'chart', title: 'Deep focus', payload: { x: ['Mon'], series: [] } };
    expect(liveFrames(called('c1', 'show_surface', args))).toEqual([
      { type: 'surface', callId: 'c1', kind: 'chart', title: 'Deep focus', because: null, args },
    ]);
    expect(liveFrames(called('c2', 'gnomon_day_pack'))).toEqual([{ type: 'tool', callId: 'c2', name: 'gnomon_day_pack', args: {} }]);
  });

  it('survives a surface call whose arguments never finished as JSON', () => {
    const [frame] = liveFrames({ type: 'tool/call', data: { callId: 'c1', name: 'show_surface', arguments: '{"kind":"cha' } });
    expect(frame).toMatchObject({ type: 'surface', kind: '', title: 'Untitled surface', args: {} });
  });

  // The call id is on the result BLOCK, never on the event. Reading the event's
  // own field matched every row against the empty string, so none of them closed.
  it('closes a work row against the call id carried by the result block', () => {
    expect(liveFrames(returned('c2'))).toEqual([{ type: 'tool-done', callId: 'c2', failed: false, text: '' }]);
    expect(liveFrames(returned('c2', { error: { name: 'E', code: 'X' } }))).toEqual([{ type: 'tool-done', callId: 'c2', failed: true, text: '' }]);
  });

  it('carries the whole plan on todo/write, normalizing a status it does not know', () => {
    const event = { type: 'todo/write', data: { todos: [{ content: 'Read the record', status: 'completed' }, { content: 'Search', status: 'in_progress' }, { content: 'Shelve', status: 'odd' }, 'junk'] } };
    const expected = [{ type: 'todo', todos: [{ content: 'Read the record', status: 'completed' }, { content: 'Search', status: 'in_progress' }, { content: 'Shelve', status: 'pending' }] }];
    expect(liveFrames(event)).toEqual(expected);
    expect(replayFrames([event])).toEqual(expected);
  });

  it('ends on turn/end and ignores the log-only events', () => {
    expect(liveFrames({ type: 'turn/end', data: { turn: 1, reason: 'complete' } })).toEqual([{ type: 'done', reason: 'complete' }]);
    expect(liveFrames({ type: 'request/header', data: {} })).toEqual([]);
    expect(streamFrames(chunk({ type: 'usage', usage: {} }))).toEqual([]);
  });
});

describe('deliverables', () => {
  const file = { path: '/tmp/today.csv', description: 'Tracked minutes.' };

  it('draws the durable handover in both projections, named by its basename', () => {
    const expected = [{ type: 'deliverable', callId: 'c9', files: [{ path: '/tmp/today.csv', name: 'today.csv', description: 'Tracked minutes.' }] }];
    expect(liveFrames(presented([file]))).toEqual(expected);
    expect(replayFrames([presented([file])])).toEqual(expected);
  });

  it('drops a path it cannot offer rather than drawing a link to nothing', () => {
    const [frame] = liveFrames(presented([{ path: '  ' }, { path: '/tmp/ok.txt' }, null, { description: 'no path' }]));
    expect(frame.files).toEqual([{ path: '/tmp/ok.txt', name: 'ok.txt', description: null }]);
  });

  it('has no description when the model gave none, and survives a trailing slash', () => {
    const [frame] = liveFrames(presented([{ path: '/tmp/dir/', description: '   ' }]));
    expect(frame.files).toEqual([{ path: '/tmp/dir/', name: 'dir', description: null }]);
  });
});

describe('replayFrames', () => {
  it('redraws a whole turn in log order, from assembled text rather than deltas', () => {
    expect(
      replayFrames([
        { type: 'turn/start', data: { turn: 1 } },
        said('how long on sundial?'),
        { type: 'step/start', data: { turn: 1, step: 1 } },
        called('c1', 'gnomon_day_pack'),
        returned('c1'),
        answered('Two hours and eleven minutes.'),
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]),
    ).toEqual([
      { type: 'turn', turn: 1 },
      { type: 'user', text: 'how long on sundial?' },
      { type: 'tool', callId: 'c1', name: 'gnomon_day_pack', args: {} },
      { type: 'tool-done', callId: 'c1', failed: false, text: '' },
      { type: 'say', text: 'Two hours and eleven minutes.' },
      // Replay carries the ending too. It used to drop `turn/end` outright, so
      // reloading a transcript quietly turned a stopped or failed turn into one
      // that looked like it had finished.
      { type: 'done', reason: 'complete' },
    ]);
  });

  // dsh's TurnEndReason is a tagged object. Reading it as a string reported
  // every turn as `complete`, which made the client's own "ended without an
  // answer" branch unreachable and a turn the owner stopped indistinguishable
  // from one that ran to the end.
  describe('how a turn ended', () => {
    const ended = (reason) => liveFrames({ type: 'turn/end', data: { turn: 1, reason } });

    it('reads a completed turn', () => {
      expect(ended({ kind: 'completed' })).toEqual([{ type: 'done', reason: 'complete' }]);
    });

    it('names the owner when the owner stopped it', () => {
      expect(ended({ kind: 'aborted', reason: { kind: 'user' } })).toEqual([{ type: 'done', reason: 'aborted', by: 'user' }]);
    });

    it('keeps a machine abort distinct from the owner pressing Stop', () => {
      expect(ended({ kind: 'aborted', reason: { kind: 'disposed' } })).toEqual([{ type: 'done', reason: 'aborted', by: 'disposed' }]);
    });

    it('carries the provider\'s own message on a failure', () => {
      expect(ended({ kind: 'error', error: { message: 'model not served', code: 'X' } })).toEqual([{ type: 'done', reason: 'error', message: 'model not served' }]);
    });

    it('passes through the endings that need no unpacking, and tolerates a bare string', () => {
      expect(ended({ kind: 'max-tokens' })).toEqual([{ type: 'done', reason: 'max-tokens' }]);
      expect(ended('complete')).toEqual([{ type: 'done', reason: 'complete' }]);
      expect(ended(undefined)).toEqual([{ type: 'done', reason: 'complete' }]);
    });
  });

  // A step that did its talking with a tool has no prose, and an empty
  // paragraph in a transcript reads as a failure rather than as a working step.
  it('drops an assistant step that produced no words', () => {
    expect(replayFrames([answered('   '), called('c1', 'gnomon_day_pack')])).toEqual([{ type: 'tool', callId: 'c1', name: 'gnomon_day_pack', args: {} }]);
  });

  it('replays a surface as a surface, so history draws the same as the live turn', () => {
    const args = { kind: 'grid', title: 'Commits', payload: { columns: [], rows: [] } };
    expect(replayFrames([called('c9', 'show_surface', args)])).toEqual([
      { type: 'surface', callId: 'c9', kind: 'grid', title: 'Commits', because: null, args },
    ]);
  });

  it('keeps injected context out of the transcript', () => {
    expect(replayFrames([said('Gnomon noticed something', { kind: 'plugin', plugin: 'sundial-proactive' })])).toEqual([]);
  });

  it('is empty, not a throw, on nothing', () => {
    expect(replayFrames(undefined)).toEqual([]);
  });
});

describe('titleFrom', () => {
  it('prefers a real title over anything it could derive', () => {
    expect(titleFrom([said('hello')], "Today's attribution")).toBe("Today's attribution");
  });

  it("reads dsh's own title out of the log, so one pass answers the whole question", () => {
    const events = [titled('First guess'), said('how long on sundial?'), titled('Time on sundial')];
    // Latest-wins, and it beats the owner's opening line.
    expect(titleFrom(events, '')).toBe('Time on sundial');
  });

  it('ignores a logged title that normalizes to nothing', () => {
    expect(titleFrom([titled('   '), said('how long on sundial?')], '')).toBe('how long on sundial?');
  });

  it("falls back to the owner's first words — a list of session-<uuid> is unnavigable", () => {
    expect(titleFrom([said('Gnomon noticed', { kind: 'plugin' }), said('  how   long on sundial?  ')], '  ')).toBe('how long on sundial?');
  });

  it('truncates a long opening line rather than letting it run the sidebar', () => {
    const title = titleFrom([said('x'.repeat(200))]);
    expect(title).toHaveLength(72);
    expect(title.endsWith('…')).toBe(true);
  });

  it('gives back an empty string when it genuinely cannot name the session', () => {
    expect(titleFrom([], undefined)).toBe('');
  });
});

describe('parseLoose', () => {
  it('passes an object through, parses a string, and is null on neither', () => {
    expect(parseLoose({ a: 1 })).toEqual({ a: 1 });
    expect(parseLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseLoose('not json')).toBeNull();
    expect(parseLoose(undefined)).toBeNull();
  });
});
