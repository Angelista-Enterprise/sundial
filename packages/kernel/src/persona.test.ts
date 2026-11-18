import { describe, expect, it } from 'vitest';
import { GNOMON_IDENTITY, HARNESS_NOTE, renderPersona, renderReplyRules, runtimeToolNote, TONE_LINE } from './persona.js';
import { REPLY_RULES } from './turn-brief.js';

const DSH_ONLY = /show_surface|ask_user_question|todo_write|gnomon_start_job|gnomon_propose|the shell|the board|dsh harness|\{\{model\}\}/;

describe('renderPersona per access', () => {
  it('opens with the identity in both renderings, and keeps the pinned harness note only in the api text', () => {
    const api = renderPersona('api');
    const runtime = renderPersona('runtime', 'claude-cli');
    expect(api.startsWith(GNOMON_IDENTITY)).toBe(true);
    expect(runtime.startsWith(GNOMON_IDENTITY)).toBe(true);
    expect(api.endsWith(`\n\n${HARNESS_NOTE}`)).toBe(true);
    expect(api).toMatch(DSH_ONLY);
    expect(runtime).not.toMatch(DSH_ONLY);
    expect(runtime).toContain('A message marked as a Gnomon notice');
  });

  it("names Sundial's tools the way each runtime does, or says how when the runtime is not known", () => {
    expect(renderPersona('runtime', 'claude-cli')).toContain('The mcp__sundial__gnomon_* tools are your record');
    expect(renderPersona('runtime', 'copilot-sdk')).toContain('sundial-gnomon_assert');
    expect(renderPersona('runtime')).toContain(runtimeToolNote());
    expect(runtimeToolNote()).toContain('mcp__sundial__gnomon_* or sundial-gnomon_*');
    expect(renderPersona('runtime', 'claude-cli')).not.toContain(runtimeToolNote('claude-cli'));
  });

  it('renders the reply rules the same way: the api rules are the brief\'s, a runtime gets no dsh tool', () => {
    expect(renderReplyRules('api')).toBe(REPLY_RULES);
    expect(REPLY_RULES).toContain('todo_write');
    expect(renderReplyRules('runtime')).toContain("Say sent, done, saved, deleted or discarded only when a tool result in this turn shows it (an earlier turn's act is not this turn's)");
    expect(renderReplyRules('runtime')).toContain('comes from a look or a result in this task');
    expect(renderReplyRules('runtime')).not.toMatch(DSH_ONLY);
    expect(renderReplyRules('runtime')).toContain('the app is as you found it');
    expect(renderReplyRules('runtime')).toContain('never answer from another app instead');
  });

  it('runs 199-202: a plain value is not code-formatted, and a done act is one plain sentence, in both renderings', () => {
    for (const rules of [REPLY_RULES, renderReplyRules('runtime')]) expect(rules).toContain('Write a plain value plainly, never in code format, and a finished act as one plain sentence ("Sent to test@example.com.").');
  });

  it("carries one short tone line for a spoken or summoned turn, in both renderings: the owner's own thing, never an invented one", () => {
    for (const rules of [REPLY_RULES, renderReplyRules('runtime')]) expect(rules.split(TONE_LINE)).toHaveLength(2);
    expect(TONE_LINE.length).toBeLessThanOrEqual(160);
    expect(TONE_LINE).toMatch(/spoke aloud or called you up/);
    expect(TONE_LINE).toMatch(/never one it does not/);
  });
});
