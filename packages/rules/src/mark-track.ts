// Plan 15 steps 6, 7 and 8: Gnomon points at a named thing on the real screen, walks the owner through a task one
// ring at a time, and hears how its one act on a control went. The model never sees pixels: names and roles only.
import { deriveId } from '@sundial/helpers/derive-id.js';
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import { taskOf } from '@sundial/helpers/task-of.js';
import type { Effect, GuideStep, KernelState, Rule, ScreenMark } from '@sundial/kernel/types.js';

export const MAX_MARKS = 12;
export const MAX_GUIDE_STEPS = 7;
export const JUDGE_FIRST = 20;
const MAX_TALLY = 50;
export const MAX_CHATS = 20;
const MAX_APPS = 8;
const SHAPES = new Set(['ring', 'underline', 'bracket', 'step', 'label']);

type Marks = NonNullable<KernelState['marks']>;
const EMPTY: Marks = { now: [], guide: null, guideTally: {} };

const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, n) : undefined);
export const LABEL_MAX = 60;
/** A label the owner reads: cut at a word, with an ellipsis, never mid-word. */
export function clip(v: unknown, n = LABEL_MAX): string | undefined {
  const s = str(v, 1000);
  if (!s || s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** A target the app can find: a ref from a look (doc 16: `{look, ref}`, or `e7@3c4d`, a ref with the last four of the last look's id), or an app and at least a role, a label or a text. A ref with no look, or the tag of an older one, is no target. */
export function targetOf(v: unknown, lastLook?: Marks['lastLook']): ScreenMark['target'] | null {
  const t = (v ?? {}) as Record<string, unknown>;
  const app = str(t.app, 80) ?? str(t.processName, 80);
  const [ref, tag] = (str(t.ref, 20) ?? '').split('@');
  const look = str(t.look, 80) ?? (tag && lastLook && !lastLook.refused && lastLook.id.slice(-4) === tag ? lastLook.id : undefined);
  const target = ref && look ? { app: app ?? lastLook?.app ?? '', look, ref } : { app: app ?? '', window: str(t.window, 120) ?? str(t.windowTitle, 120), role: str(t.role, 40), label: str(t.label, 120), text: str(t.text, 120) };
  if (!('ref' in target) && (!app || (!target.role && !target.label && !target.text))) return null;
  return Object.fromEntries(Object.entries(target).filter(([, x]) => x !== undefined)) as ScreenMark['target'];
}

/** How a guide shows this time: the first time a ring and its line, the second a ring alone, then only an offer. */
export const guideShows = (times: number): 'ring-line' | 'ring' | null => (times === 0 ? 'ring-line' : times === 1 ? 'ring' : null);

function stepMark(taskKey: string, step: GuideStep, n: number, of: number, shows: 'ring-line' | 'ring'): ScreenMark {
  return { id: `guide:${taskKey}:${n}`, target: step.target, shape: 'ring', ...(shows === 'ring-line' ? { label: clip(step.line) } : {}), step: n + 1, of, guide: taskKey };
}

/** The newest `n` entries of a record kept in insertion order, with `key` moved to the end. */
const newest = <T>(rec: Record<string, T> | undefined, key: string, value: T | undefined, n: number): Record<string, T> =>
  Object.fromEntries([...Object.entries(rec ?? {}).filter(([k]) => k !== key), ...(value === undefined ? [] : [[key, value] as [string, T]])].slice(-n));

/** Single writer of `state.marks`. */
export const markTrack: Rule = (state, event) => {
  const marks = state.marks ?? EMPTY;
  const p = event.payload as Record<string, unknown>;
  const effects: Effect[] = [];
  let next: Marks = marks;
  const show = (now: ScreenMark[]) => {
    // A placed id is only true while its mark is up: a guide's step ids come back the next time.
    next = { ...next, now, ...(next.placed ? { placed: next.placed.filter((id) => now.some((m) => m.id === id)) } : {}) };
    effects.push({ type: 'Mark', marks: now, ...((next.judged ?? 0) < JUDGE_FIRST && now.some((m) => !m.guide && !m.id.startsWith('ask:')) ? { judge: true } : {}) });
  };
  const endGuide = (reason: string) => {
    const guide = next.guide;
    if (!guide) return;
    next = { ...next, guide: null };
    show(next.now.filter((m) => m.guide !== guide.taskKey));
    if (reason === 'done') effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'mark-track', guide.taskKey), type: 'guide:ended', ts: event.ts, payload: { taskKey: guide.taskKey, reason } } });
  };

  switch (event.type) {
    case 'screen:mark': {
      if (p.clear === true) {
        show(typeof p.id === 'string' ? next.now.filter((m) => m.id !== p.id) : next.now.filter((m) => m.guide));
        break;
      }
      const target = targetOf(p.target, next.lastLook);
      const shape = typeof p.shape === 'string' && SHAPES.has(p.shape) ? (p.shape as ScreenMark['shape']) : 'ring';
      if (!target) break;
      const id = str(p.id, 80) ?? event.id;
      const mark: ScreenMark = { id, target, shape, ...(clip(p.label) ? { label: clip(p.label) } : {}), ...(typeof p.step === 'number' ? { step: Math.max(1, Math.min(99, Math.round(p.step))) } : {}) };
      show([...next.now.filter((m) => m.id !== id), mark].slice(-MAX_MARKS));
      break;
    }
    case 'screen:mark-cleared':
      if (typeof p.id === 'string' && next.now.some((m) => m.id === p.id)) next = { ...next, now: next.now.filter((m) => m.id !== p.id) };
      break;
    case 'screen:mark-placed':
      // How the app found it (`ax` or `text`) stays in the log; the state holds which ones it found.
      if (typeof p.id === 'string') next = { ...next, placed: [...(next.placed ?? []).filter((id) => id !== p.id), p.id].slice(-MAX_MARKS) };
      break;
    case 'screen:mark-judged':
      next = { ...next, judged: (next.judged ?? 0) + 1 };
      break;
    case 'guide:started': {
      const taskKey = str(p.taskKey, 80);
      const steps = (Array.isArray(p.steps) ? p.steps : []).slice(0, MAX_GUIDE_STEPS).flatMap((s): GuideStep[] => {
        const target = targetOf((s as { target?: unknown })?.target, next.lastLook);
        const line = str((s as { line?: unknown })?.line, 120);
        return target && line ? [{ target, line }] : [];
      });
      if (!taskKey || steps.length === 0) break;
      if (next.guide) endGuide('replaced');
      const times = next.guideTally[taskKey] ?? 0;
      const tally = Object.fromEntries([...Object.entries(next.guideTally).filter(([k]) => k !== taskKey), [taskKey, times + 1]].slice(-MAX_TALLY));
      const shows = guideShows(times);
      next = { ...next, guideTally: tally, guide: { taskKey, step: 0, total: steps.length, steps, ...(shows ? { shown: shows } : {}) } };
      if (shows) show([...next.now.filter((m) => !m.guide), stepMark(taskKey, steps[0], 0, steps.length, shows)].slice(-MAX_MARKS));
      break;
    }
    case 'guide:step': {
      const guide = next.guide;
      if (!guide || p.taskKey !== guide.taskKey) break;
      const step = guide.step + 1;
      if (step >= guide.total) {
        endGuide('done');
        break;
      }
      next = { ...next, guide: { ...guide, step } };
      if (guide.shown && guide.steps) show([...next.now.filter((m) => m.guide !== guide.taskKey), stepMark(guide.taskKey, guide.steps[step], step, guide.total, guide.shown)].slice(-MAX_MARKS));
      break;
    }
    case 'guide:ended':
      if (next.guide && p.taskKey === next.guide.taskKey) endGuide(typeof p.reason === 'string' ? p.reason : 'ended');
      break;
    case 'screen:acted':
      // The app's answer to one act; the tool that asked waits on it. The audit row is the tool's (action:performed).
      if (typeof p.id === 'string' && (p.outcome === 'performed' || p.outcome === 'refused')) {
        // Run 230: Swift sends replacedChars 0 for a set-value into an empty field (AXValue ""; a placeholder is its own attribute).
        // Nothing was replaced, so the tool must not undo it as the owner's text.
        // `own`: the field held Gnomon's own text from its last set-value, unchanged (Sundial.app compares): not the owner's, never undone.
        // A refusal's menu words (a menu's items, up to 61; the paths of two items alike) ride in the target, redacted with it.
        const said = (p.target as { screenText?: unknown } | undefined)?.screenText;
        const names = Array.isArray(said) ? said.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 61).map((x) => x.slice(0, 160)) : [];
        next = { ...next, lastAct: { id: p.id, at: event.ts, outcome: p.outcome, ...(typeof p.replacedChars === 'number' && p.replacedChars > 0 ? { replaced: true } : {}), ...(p.own === true ? { own: true } : {}), ...(typeof p.reason === 'string' ? { reason: p.reason } : {}), ...(targetOf(p.target) ? { target: targetOf(p.target)! } : {}), ...(names.length ? { names } : {}) } };
      }
      break;
    case 'screen:printed': {
      // Round 2: a look an answer printed in a chat. A bare ref is read against it; cmd+q quits an app printed there lately.
      const [session, look, app] = [String(p.session ?? ''), str(p.look, 80), str(p.app, 80)];
      if (!look || !app) break;
      const was = next.chats?.[session];
      const tag = str(p.tag, 8);
      const chat = { ...was, look: { id: look, ...(tag ? { tag } : {}), app, at: event.ts, act: str(p.act, 80) ?? null }, apps: newest(was?.apps, app, event.ts, MAX_APPS), app: { app, at: event.ts } };
      next = { ...next, chats: newest(next.chats, session, chat, MAX_CHATS) };
      break;
    }
    case 'screen:step': {
      // Round 2: what a step leaves for the next call: its chat's app, the app it quit, a Send's proof.
      // Run 145: the step's act id, so the gate reads where its after-look (the act result's `focus:` line) left the keyboard.
      const [session, app, id] = [String(p.session ?? ''), str(p.processName, 80), str(p.id, 80)];
      if (!app) break;
      const was = next.chats?.[session];
      // A set-value that went through names its thing (never its value): the field may hold Gnomon's own text, so the tool lets a second set-value go and Sundial.app decides.
      // S5R1 (Fable M2): with the chat's task then and the length it set, so the tool can tell it went stale; a set-value refused (undone) drops it.
      const name = p.verb === 'set-value' && p.ok === true && Array.isArray(p.screenText) ? str(p.screenText[0], 120) : undefined;
      const task = taskOf(state, session)?.id;
      const set = name ? { set: { app, name, ...(str(p.role, 40) ? { role: str(p.role, 40) } : {}), at: event.ts, ...(task ? { task } : {}), ...(typeof p.typed === 'number' ? { chars: p.typed } : {}) } } : p.verb === 'set-value' ? { set: undefined } : {};
      next = { ...next, chats: newest(next.chats, session, { ...was, app: { app, at: event.ts }, ...(id ? { step: { id, app, at: event.ts } } : {}), ...(p.quit === true ? { quit: { app, at: event.ts } } : {}), ...set }, MAX_CHATS) };
      if (p.proof !== 'confirmed' && p.proof !== 'unconfirmed') break;
      next = { ...next, unsent: newest(next.unsent, app, p.proof === 'unconfirmed' ? event.ts : undefined, MAX_APPS), ...(next.lastAct && next.lastAct.id === p.id ? { lastAct: { ...next.lastAct, proof: p.proof } } : {}) };
      break;
    }
    case 'screen:looked': {
      // A pointer only: the elements stay in the log row, where screen_look reads them. A private app's look is a refusal.
      const id = str(p.id, 80);
      if (!id) break;
      const hid = [p.processName, p.windowTitle].some((x) => typeof x === 'string' && isRedactedPlaceholder(x));
      const [window, after, refused, tag] = [str(p.windowTitle, 120), str(p.after, 80), str(p.refused, 80) ?? (hid ? 'private app' : undefined), str(p.tag, 8)];
      // `tag`: the app run's, on every label of the look (e7@ab12): a thing keeps its label across the run's looks.
      next = { ...next, lastLook: { id, app: str(p.processName, 80) ?? '', n: typeof p.n === 'number' ? p.n : Array.isArray(p.elements) ? p.elements.length : 0, at: event.ts, ...(window ? { window } : {}), ...(after ? { after } : {}), ...(refused ? { refused } : {}), ...(tag ? { tag } : {}) } };
      break;
    }
  }
  return next === marks && effects.length === 0 ? { state, effects } : { state: { ...state, marks: next }, effects };
};
