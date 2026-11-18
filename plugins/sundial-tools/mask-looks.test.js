import { describe, expect, it } from 'vitest';
import { KEPT_WHOLE, looksLikeScreen, maskOldLooks, maskOldLooksGuard } from './mask-looks.js';

const look = (n) => `Notes, window "Lunch" (look-0000000${n}): 42 things, the keyboard is in e7@000${n}.\n${Array.from({ length: 50 }, (_, i) => `e${i} button "thing ${i}" [press]`).join('\n')}`;
const result = (text) => ({ role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] });
const said = (text) => ({ role: 'assistant', content: [{ type: 'reasoning', text }, { type: 'tool-call', name: 'screen_look', arguments: '{}' }] });

describe('maskOldLooks (prompts ran 8.5k to 42k tokens, mostly screens that had changed)', () => {
  it('knows a screen from any other result', () => {
    expect(looksLikeScreen(look(1))).toBe(true);
    expect(looksLikeScreen('exit 0\nline 6')).toBe(false);
    expect(looksLikeScreen(`a short one (look-00000001): 2 things`)).toBe(false);
  });

  it('keeps the newest looks whole and gives the older ones one line, touching nothing else', () => {
    const messages = [said('first'), result(look(1)), said('second'), result(look(2)), said('third'), result(look(3)), result('exit 0\nline 6')];
    const out = maskOldLooks(messages, KEPT_WHOLE);
    const text = (i) => out[i].content[0].content[0].text;
    // The oldest look is one head line plus a note; the two newest are untouched.
    expect(text(1)).toMatch(/\(look-00000001\): 42 things[\s\S]*51 lines of it are not shown/);
    expect(text(1).split('\n')).toHaveLength(2);
    expect(text(3)).toBe(look(2));
    expect(text(5)).toBe(look(3));
    // Reasoning, the calls and a shell result are left exactly as they were.
    expect(out[0]).toBe(messages[0]);
    expect(text(6)).toBe('exit 0\nline 6');
  });

  it('returns the very same array when there is nothing old to mask', () => {
    const messages = [said('a'), result(look(1))];
    expect(maskOldLooks(messages, KEPT_WHOLE)).toBe(messages);
    expect(maskOldLooks([], KEPT_WHOLE)).toEqual([]);
  });
});

describe('the guard (run 17: it masked nothing in 43 calls)', () => {
  const on = { config: { experiments: { maskOldLooks: true } } };
  const messages = [said('a'), result(look(1)), result(look(2)), result(look(3))];
  const ran = async (state, options) => {
    const seen = [];
    const next = async function* (passed) { seen.push(passed); yield 'done'; };
    for await (const _ of maskOldLooksGuard({ getState: () => state })(options, next));
    return seen[0];
  };

  it('masks a chat call that names no purpose at all, which is how the chat calls arrive', async () => {
    const out = await ran(on, { messages });
    expect(out.messages[1].content[0].content[0].text).toMatch(/lines of it are not shown/);
  });

  it('leaves every other purpose alone, and does nothing while the switch is off', async () => {
    expect((await ran(on, { purpose: 'vision', messages })).messages).toBe(messages);
    expect((await ran({ config: { experiments: {} } }, { messages })).messages).toBe(messages);
  });
});
