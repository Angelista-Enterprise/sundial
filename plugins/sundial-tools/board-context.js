// The board in the chat's context, and the board as a tool reads it back.
//
// lane Q (Q12): the board used to ride WHOLE in the runtime context — every
// card, where it sits, the recent moves, the plan. dsh re-sends the joined
// context as a new user message whenever any part of it changes, and the board
// changes while Gnomon works on it, so one owner message carried two to three
// copies of the whole context in its history. Now the context says only what
// changes rarely (the board staging setting, the span, how to stage); the cards come
// back from `gnomon_look` with id "board", and at the end of every
// `gnomon_board` result.
//
// Named exports only.
import { describeCard } from '../sundial-theme/shell/cards.js';
import { liveSpan } from '@sundial/rules/board-track.js';

/** A preset span ("today", "7d") read against today, so a board kept past midnight does not describe yesterday (hardening L1). */
const spanOf = (board, today) => (today ? liveSpan(board?.span, today) : board?.span)

/** The pseudo card id `gnomon_look` answers with the whole board. */
export const BOARD_LOOK_ID = 'board';

/** Every card on the board, what it is and where it sits; null without a board. */
export function boardSummary(board, today) {
  if (!board) return null;
  const cards = Object.values(board.cards);
  if (cards.length === 0) return 'The board is empty apart from the defaults (today, session).';
  // WHEN the board is looking, before WHAT is on it: every card below is
  // showing this span, and a reading described without it is wrong about time.
  const live = spanOf(board, today);
  const span = live
    ? [`The board is looking at ${live.from === live.to ? live.from : `${live.from} to ${live.to}`} (${live.label}). Every card shows that span; change it with \`gnomon_board\` action span, and do that rather than explaining that a card shows today.`]
    : ['The board is looking at today.'];
  // What each card IS, from the catalog, before where it sits: an id and a
  // position was all this said, and the agent guessed the rest from the name.
  const lines = cards.map((c) => `- ${describeCard(c.id, c)}${c.text ? ` Its text: “${c.text.slice(0, 80)}”.` : ''}${c.comment ? ` [the owner's remark: ${c.comment.slice(0, 160)}]` : ''} (${c.pinned ? 'pinned, ' : ''}at ${Math.round(c.x)}, ${Math.round(c.y)}, ${Math.round(c.w)}×${Math.round(c.h)}, placed by ${c.by})`);
  const scenes = Object.keys(board.scenes);
  const sections = Object.entries(board.sections ?? {}).map(([id, s]) => `- section ${id} “${s.label}” at (${s.x}, ${s.y}) ${s.w}×${s.h}${s.anchor ? `, anchored by ${s.anchor}` : ''}`);
  const hhmm = (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const recent = (board.recent ?? []).map((r) => `${hhmm(r.at)} ${r.by} ${r.type}${r.id ? ` ${r.id}` : ''}`);
  const plan = board.plan ? [`The owner edited your plan at ${hhmm(board.plan.at)} — follow it or say why not; your next todo_write replaces it:`, ...board.plan.steps.map((s, i) => `  ${i + 1}. ${s.status === 'skipped' ? '(skipped) ' : s.status === 'completed' ? '(done) ' : ''}${s.content}`)] : [];
  return [...span, ...(sections.length ? ['Sections (regions; `near: <section id>` places inside one):', ...sections] : []), `Cards on the board:`, ...lines, scenes.length ? `Saved scenes: ${scenes.join(', ')}` : '', ...(recent.length ? ['Recent moves, oldest first:', ...recent.map((r) => `- ${r}`)] : []), ...plan].filter(Boolean).join('\n');
}

export const BOARD_COACHING = [
  // The staging rules (P2.4), each from a failure on the record: the Ledger
  // described two wrong ways without a look; a walk stepped to a lens that
  // showed nothing; a ledger answer redrawn as a grid beside the Ledger card;
  // notes the owner swept within a minute; steps of 40–70 words.
  'How to stage. Every card listed here says what it answers and what it shows; that is how you pick one. Before you describe a card or step to it, read it with gnomon_look and say only what the reading holds — never what its name suggests.',
  'If a card on the board already answers, point at it: link it in your words as [its title](board:<id>), or focus it with mark (the row to light) or filters (the day, tab or query to show), and answer in one line from its reading. Never redraw a card\'s numbers in a surface, a figure or a note.',
  'Place a card only when the owner asked for what it shows and no card on the board answers, set to the point with filters rather than described; when you speak unprompted, link instead of placing. Never write your own explanation into a note card — point at the card that holds the evidence.',
  'A question asked in words is answered in words first; the board is for when the owner asks to be SHOWN. To show a story across three or more cards — a comparison, several days — narrate with gnomon_board action step, one call per step; each returns when the owner presses Next, so read their recent moves before the next. Each step lands on a card whose data carries the point, and reads as speech: one thing to notice, about 20 words, at most one number, and where to look — "Your morning went to PR review in Arc; see how little typing there is." Never totals, never "Step 2 —" (the chat numbers them), and never the next part before the step returns.',
  'When the owner points ("this pane"), read it with gnomon_look first. When a walk ends, remove the cards you placed for it.',
].join(' ');

/** When the board is looking: every card shows that span. */
function spanLine(board, today) {
  const live = spanOf(board, today);
  return live
    ? `The board is looking at ${live.from === live.to ? live.from : `${live.from} to ${live.to}`} (${live.label}). Every card shows that span; change it with \`gnomon_board\` action span, and do that rather than explaining that a card shows today.`
    : 'The board is looking at today.';
}

/**
 * What each card IS, and nothing about where it sits: this changes when a card
 * is placed or removed, never when one moves, is focused or is stepped to.
 */
function cardList(board) {
  const cards = Object.values(board.cards ?? {});
  if (cards.length === 0) return 'The board is empty apart from the defaults (today, session).';
  return cards.map((c) => `- ${describeCard(c.id, c)}${c.text ? ` Its text: “${c.text.slice(0, 80)}”.` : ''}${c.comment ? ` [the owner's remark: ${c.comment.slice(0, 160)}]` : ''}`).join('\n');
}

/** The owner's edit of Gnomon's plan, which is an instruction for as long as it stands. */
function planLines(board) {
  if (!board.plan) return [];
  const hhmm = (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return [`The owner edited your plan at ${hhmm(board.plan.at)} — follow it or say why not; your next todo_write replaces it:`, ...board.plan.steps.map((s, i) => `  ${i + 1}. ${s.status === 'skipped' ? '(skipped) ' : s.status === 'completed' ? '(done) ' : ''}${s.content}`)];
}

/**
 * The `gnomon:board` runtime context: what changes rarely — the board's
 * staging setting, where the staging rules are (gnomon_board's own description), the span, what each card is, the owner's plan edit.
 * Where cards sit, the sections, the scenes and the recent moves come back
 * from `gnomon_look` id "board" and after every `gnomon_board` call. Empty
 * until there is a board, as before.
 */
export function boardContextText(state, today) {
  const board = state?.board;
  if (!board) return '';
  const autonomy = state?.settings?.autonomy ?? 'act';
  return [
    // The board's own staging setting, not `state.autonomy` (what each capability has earned): named so the two cannot be read as one.
    `Board staging: "${autonomy}"${autonomy === 'act' ? '' : ' — gnomon_board and gnomon_lens place will refuse; describe what you would have shown instead'}.`,
    'To show something on it, read gnomon_board with gnomon_tools first: its description says how to stage.',
    spanLine(board, today),
    `The cards on the board (read one with gnomon_look; "this pane" means one of these; gnomon_look with id "${BOARD_LOOK_ID}" adds where each sits and the recent moves, and every gnomon_board result ends with that):`,
    cardList(board),
    ...planLines(board),
  ].join('\n');
}
