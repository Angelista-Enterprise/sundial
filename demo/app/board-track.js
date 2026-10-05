import { localDate } from '@sundial/helpers/local-day.js';
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
/** A card's filters: string values only, a handful at most; nothing left is null (cleared). */
export function cleanFilters(v) {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return null;
    const out = {};
    for (const [k, raw] of Object.entries(v).slice(0, 6)) {
        const value = typeof raw === 'number' ? String(raw) : str(raw);
        if (value !== null)
            out[k] = value.slice(0, 120);
    }
    return Object.keys(out).length > 0 ? out : null;
}
/** Card sizes when the placer gave none, and the smallest each kind still works at, in world units. */
export const DEFAULT_SIZE = {
    today: [960, 620],
    // The four below were drawn by the client and sized by `FALLBACK_SIZE` — the
    // record could place them but did not NAME them, so nothing downstream could
    // enumerate what a board may hold. `CARD_KINDS` (below) is that list now, and
    // a kind absent from it is a kind with no reader. Each is at or under
    // `SIZE_FLOOR`, so naming them here changes no card's size.
    dial: [960, 620],
    lens: [720, 520],
    settings: [560, 620],
    threads: [420, 560],
    // The conversation, a card since 2026-09-23 (it was the side panel).
    chat: [720, 800],
    explore: [760, 560],
    note: [320, 200],
    shelf: [480, 380],
    entity: [640, 520],
    moment: [560, 480],
    surface: [720, 520],
    figure: [720, 520],
    work: [560, 480],
    web: [720, 560],
    // Same 800 as the floor: a row is as tall as its tallest card, so one
    // 860 card used to push every card in its row past the screen at 1:1.
    kanban: [1640, 800],
    play: [960, 620],
    rhythm: [1120, 800],
    voice: [1120, 800],
    engine: [1120, 800],
    browser: [1120, 800],
};
export const MIN_SIZE = {
    today: [900, 560],
    threads: [360, 420],
    chat: [420, 480],
    explore: [600, 440],
    note: [240, 140],
    shelf: [420, 300],
    entity: [480, 380],
    moment: [440, 360],
    surface: [560, 400],
    figure: [560, 400],
    work: [360, 240],
    web: [400, 300],
    kanban: [1200, 600],
};
/**
 * Every kind of card the board can hold — the one list, and the contract that
 * keeps the client and the tools from drifting apart.
 *
 * The drift it exists to stop was real and silent in both directions: the
 * client grew a `dial` card that `gnomon_look` had never heard of, and
 * `gnomon_look` answered for a `today` id that the client draws under five
 * other names. Neither side could see the other's list, so neither noticed.
 *
 * A card's kind is `board:place`'s `kind`, or the part of its id before the
 * colon (`entity:Pat` → `entity`). Adding a kind means adding it HERE, and
 * the reader test in `plugins/sundial-tools` then fails until it can be read.
 */
export const CARD_KINDS = Object.keys(DEFAULT_SIZE);
const FALLBACK_SIZE = [640, 480];
const FALLBACK_MIN = [160, 100];
/** Between cards and between rows: an editor's seam, not a whiteboard's. */
export const GAP = 12;
/** The tool says `instrument`; the client's ids say `inst:`. One name inside. */
export const normKind = (kind) => (kind === 'instrument' ? 'inst' : kind);
/**
 * The floor every card gets: 70% × 80% of a reference 1600×1000 screen. A card
 * born smaller than this frames to a box with no room to read in, which is the
 * "cut off at 109%" of 2026-09-16.
 *
 * ponytail: one floor, not eighteen hand-edited pairs. A kind already bigger
 * keeps its own size. A note is the one exception — it is a sticky, not a panel.
 */
const SIZE_FLOOR = [1120, 800];
export function defaultSize(kind) {
    const [w, h] = DEFAULT_SIZE[kind] ?? FALLBACK_SIZE;
    if (kind === 'note')
        return [w, h];
    return [Math.max(w, SIZE_FLOOR[0]), Math.max(h, SIZE_FLOOR[1])];
}
export function minSize(kind) {
    return MIN_SIZE[kind] ?? FALLBACK_MIN;
}
/**
 * A lens card's text is its whole spec as JSON. Only the title is worth
 * lifting out, so the shelf can be listed without every reader parsing specs.
 */
export function lensTitle(text) {
    try {
        const spec = JSON.parse(text);
        const title = spec?.title;
        return typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 120) : null;
    }
    catch {
        return null;
    }
}
/**
 * The shelf, after any board change: every lens card on the board is on it, and
 * nothing is ever taken off.
 *
 * WHY IT SWEEPS THE CARDS rather than keying off `board:place`. A shelf that
 * only fills going forward is empty after boot for every lens placed before it
 * existed — the snapshot replay starts from a state that has no `lenses` and
 * never re-reads the old placements. Reading the cards makes the field a pure
 * function of the board plus what was already shelved, so the first change
 * after boot backfills whatever is up, and a replay lands in the same place.
 *
 * Nothing removes an entry. `board:remove` and `board:clear` throw away a CARD;
 * the question it encoded is not the owner's to lose by tidying.
 */
function shelve(cards, shelf, at) {
    let next = shelf;
    for (const card of Object.values(cards)) {
        if (card.kind !== 'lens' || card.text === null)
            continue;
        const held = next[card.id];
        if (held?.spec === card.text)
            continue;
        if (next === shelf)
            next = { ...shelf };
        next[card.id] = { title: lensTitle(card.text) ?? held?.title ?? card.id, spec: card.text, at: held?.at ?? at };
    }
    return next;
}
/** Room above a row's cards for the row's name. */
export const ROW_PAD = 18;
/**
 * The board tiles like niri: every section is a ROW, rows stack top to bottom,
 * and inside a row the cards stand left to right at their own widths and one
 * shared height (the tallest card's). A card belongs to the row whose band
 * holds its centre — else the nearest — so a drop between rows still lands,
 * and a card dragged into another row joins it where its x says. Rows never
 * overlap and cards never overlap, so nothing here needs a free-spot search.
 * Idempotent: tiling a tiled board changes nothing.
 */
/**
 * The rows that still hold a card, by the same head rule `tile` uses.
 *
 * Rows have no names any more, so an empty one is not an empty workspace — it
 * is a band of nothing you scroll through on the way to the next card.
 */
export function prune(cards, sections) {
    const rows = Object.entries(sections);
    if (rows.length === 0)
        return sections;
    const used = new Set();
    for (const c of Object.values(cards)) {
        const cy = c.y + Math.min(c.h / 2, ROW_PAD);
        let best = rows[0][0];
        let bestD = Infinity;
        for (const [id, s] of rows) {
            const d = cy < s.y ? s.y - cy : cy > s.y + s.h ? cy - (s.y + s.h) : 0;
            if (d < bestD) {
                bestD = d;
                best = id;
            }
        }
        used.add(best);
    }
    return Object.fromEntries(rows.filter(([id]) => used.has(id)));
}
/**
 * The events that can leave a row empty, and so the only ones that prune.
 *
 * NOT `board:place`, and not `board:section`. A fresh board writes its five
 * rows and then fills them, one post at a time: pruning on the placements
 * meant the first card to land took every row it was not in with it, and the
 * board came up as one row holding everything.
 */
/**
 * The spans the board offers, as days back from today, inclusive of today.
 *
 * One table, because the chip, the reader and every route have to agree on what
 * "7d" means. `day` is not here: it is whatever single date the ruler names, and
 * a custom span carries its own `from`/`to`.
 */
export const BOARD_SPANS = { today: 1, '7d': 7, '14d': 14, '30d': 30, '90d': 90 };
/** `2026-09-18` for an instant, in the owner's own day. */
const dayOf = (iso, timeZone) => localDate(iso, timeZone);
/** N days before a `YYYY-MM-DD`, as another one. Dates, so no clock arithmetic and no DST to get wrong. */
function daysBefore(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
    at.setUTCDate(at.getUTCDate() - n);
    return at.toISOString().slice(0, 10);
}
/**
 * What a `board:span` payload means, as two inclusive owner-local dates.
 *
 * A named preset is resolved against TODAY rather than stored as two fixed
 * dates, so "the last 7 days" is still the last 7 days tomorrow morning. An
 * explicit `from`/`to` is taken as given and labelled `custom`; the ruler's
 * single day arrives as `from === to` and keeps the label `day`.
 */
export function resolveSpan(p, today) {
    const label = typeof p.label === 'string' ? p.label.trim() : '';
    const from = typeof p.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.from) ? p.from : null;
    const to = typeof p.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.to) ? p.to : null;
    if (from !== null && to !== null)
        return from <= to ? { from, to, label: label || 'custom' } : { from: to, to: from, label: label || 'custom' };
    // One date given: that day alone. This is the ruler.
    if (from !== null)
        return { from, to: from, label: label || 'day' };
    if (to !== null)
        return { from: to, to, label: label || 'day' };
    const back = BOARD_SPANS[label];
    if (back === undefined)
        return null;
    return { from: daysBefore(today, back - 1), to: today, label };
}
/**
 * A stored span as it reads on `today`. A named preset is resolved again, so a
 * board set to "today" last night shows this morning and not yesterday; `day`
 * and `custom` keep the dates they were given. Every reader of `board.span`
 * goes through this (the client has the same table in `shell/span.js`).
 */
export function liveSpan(span, today) {
    if (!span)
        return null;
    const back = BOARD_SPANS[span.label];
    return back === undefined ? span : { ...span, from: daysBefore(today, back - 1), to: today };
}
const PRUNES = new Set(['board:move', 'board:remove', 'board:clear', 'board:load']);
export function tile(cards, sections) {
    const rows = Object.entries(sections).sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x);
    // No sections yet: one nameless row, kept out of the result.
    if (rows.length === 0)
        rows.push(['', { label: '', x: 0, y: 0, w: 0, h: 0, anchor: null, at: '' }]);
    const members = new Map(rows.map(([id]) => [id, []]));
    for (const c of Object.values(cards)) {
        // The HEAD decides the row, not the centre: a tall card moved into a short
        // (or empty) row would otherwise have its centre still inside the row it left.
        const cy = c.y + Math.min(c.h / 2, ROW_PAD);
        let best = rows[0][0];
        let bestD = Infinity;
        for (const [id, s] of rows) {
            const d = cy < s.y ? s.y - cy : cy > s.y + s.h ? cy - (s.y + s.h) : 0;
            if (d < bestD) {
                bestD = d;
                best = id;
            }
        }
        members.get(best).push(c);
    }
    const outCards = {};
    const outSections = {};
    const x0 = rows[0][1].x;
    let y = rows[0][1].y;
    for (const [id, s] of rows) {
        const list = members.get(id).sort((a, b) => a.x - b.x || a.at.localeCompare(b.at));
        const rowH = list.reduce((m, c) => Math.max(m, c.h), 0);
        let x = x0 + GAP;
        for (const c of list) {
            outCards[c.id] = { ...c, x, y: y + ROW_PAD, h: rowH };
            x += c.w + GAP;
        }
        // The band is the name and the cards; the GAP between rows is the only seam.
        const h = Math.max(200, rowH + ROW_PAD);
        if (id !== '')
            outSections[id] = { ...s, x: x0, y, w: Math.max(400, x - x0), h };
        y += h + GAP;
    }
    return { cards: outCards, sections: outSections };
}
export const boardTrack = (state, event) => {
    if (!event.type.startsWith('board:'))
        return { state, effects: [] };
    const p = event.payload;
    const board = state.board;
    const at = event.ts;
    // Every change that lands also lands in `recent`: what was done, to what, by whom.
    const move = { type: event.type.slice(6), id: str(p.id) ?? str(p.name) ?? null, by: p.by === 'gnomon' ? 'gnomon' : 'owner', at, because: str(p.because) };
    const done = (next) => {
        const merged = { ...board, ...next };
        if (next.sections !== undefined || next.cards !== undefined) {
            if (PRUNES.has(event.type))
                merged.sections = prune(merged.cards, merged.sections);
        }
        const tiled = next.cards !== undefined || next.sections !== undefined ? tile(merged.cards, merged.sections) : {};
        return { state: { ...state, board: { ...merged, ...tiled, lenses: shelve(merged.cards, merged.lenses, at), recent: [...(board.recent ?? []), move].slice(-8), updatedAt: at } }, effects: [] };
    };
    const weightOf = (v) => (v === 'light' ? 'light' : 'heavy');
    switch (event.type) {
        case 'board:place': {
            const id = str(p.id);
            if (id === null)
                return { state, effects: [] };
            const prior = board.cards[id];
            const kind = normKind(str(p.kind) ?? prior?.kind ?? id.split(':')[0] ?? 'pane');
            const [dw, dh] = defaultSize(kind);
            const [mw, mh] = minSize(kind);
            // A card coming back wears the size the owner last gave it (this card,
            // else this kind) over any placer's default; a card still on the board
            // takes an explicit size as before.
            const kept = prior ? undefined : (board.sizes?.[id] ?? board.sizes?.[kind]);
            const w = Math.max(mw, kept?.[0] ?? num(p.w, prior?.w ?? dw));
            const h = Math.max(mh, kept?.[1] ?? num(p.h, prior?.h ?? dh));
            // Where it goes: where it already was; else the wish (x, y — or beside
            // the card named by `near`); resolved to the nearest free spot, so a
            // new card never lands on another one.
            let x = prior?.x;
            let y = prior?.y;
            if (x === undefined || y === undefined || p.x !== undefined || p.y !== undefined || p.near !== undefined) {
                const anchor = typeof p.near === 'string' ? board.cards[p.near] : undefined;
                const section = typeof p.near === 'string' && !anchor ? board.sections[p.near] : undefined;
                // Beside a card; or inside a section, below its anchor if it has one.
                const sAnchor = section?.anchor ? board.cards[section.anchor] : undefined;
                // +1, not +GAP: strictly between the anchor and whatever stands next to
                // it, so the tiling puts the new card right after the anchor.
                x = num(p.x, anchor ? anchor.x + anchor.w + 1 : section ? (sAnchor ? sAnchor.x + sAnchor.w + 1 : section.x + GAP) : (x ?? 0));
                y = num(p.y, anchor ? anchor.y : section ? (sAnchor ? sAnchor.y : section.y + ROW_PAD) : (y ?? 0));
            }
            const card = {
                id,
                kind,
                x,
                y,
                w,
                h,
                z: Math.min(0, num(p.z, prior?.z ?? 0)),
                pinned: typeof p.pinned === 'boolean' ? p.pinned : (prior?.pinned ?? false),
                text: p.text === undefined ? (prior?.text ?? null) : str(p.text),
                comment: p.comment === undefined ? (prior?.comment ?? null) : str(p.comment),
                filters: p.filters === undefined ? (prior?.filters ?? null) : cleanFilters(p.filters),
                // Whoever put it down first: Gnomon setting a filter on the owner's card
                // does not make it Gnomon's to tidy away.
                by: prior?.by ?? (p.by === 'gnomon' ? 'gnomon' : 'owner'),
                at,
            };
            return done({ cards: { ...board.cards, [id]: card } });
        }
        case 'board:move': {
            const id = str(p.id);
            const prior = id === null ? undefined : board.cards[id];
            if (id === null || prior === undefined)
                return { state, effects: [] };
            const [mw, mh] = minSize(prior.kind);
            const card = {
                ...prior,
                x: num(p.x, prior.x),
                y: num(p.y, prior.y),
                w: Math.max(mw, num(p.w, prior.w)),
                h: Math.max(mh, num(p.h, prior.h)),
                z: Math.min(0, num(p.z, prior.z)),
                // The remark rides a move as it rides a place. It did not, once: the
                // 2026-09-17 board audit wrote all 35 of its verdicts with a move and
                // a `comment`, the field fell off here, and the tool still answered
                // success — a whole evening of the owner's words, gone with a receipt.
                // Geometry and remark are both "any subset" of a card; neither is the
                // other's business.
                comment: p.comment === undefined ? prior.comment : str(p.comment),
                at,
            };
            // The owner's resize (grip or ⌥R) is remembered past the card's life.
            const resized = move.by === 'owner' && (p.w !== undefined || p.h !== undefined);
            if (!resized)
                return done({ cards: { ...board.cards, [id]: card } });
            const size = [card.w, card.h];
            return done({ cards: { ...board.cards, [id]: card }, sizes: { ...board.sizes, [id]: size, [card.kind]: size } });
        }
        case 'board:remove': {
            const id = str(p.id);
            const prior = id === null ? undefined : board.cards[id];
            if (id === null || prior === undefined)
                return { state, effects: [] };
            const { [id]: _gone, ...cards } = board.cards;
            return done({ cards });
        }
        case 'board:focus': {
            const ids = Array.isArray(p.ids) ? p.ids.filter((m) => typeof m === 'string') : [];
            return done({ focus: ids.length ? { ids, text: str(p.text), mark: str(p.mark), at } : null });
        }
        case 'board:notice': {
            const text = str(p.text);
            if (text === null)
                return { state, effects: [] };
            // Three replies at most. A row is one line high; a fourth button is a
            // card's worth of choice, and that is what the Ask layer is for.
            const actions = (Array.isArray(p.actions) ? p.actions : [])
                .map((a) => (a !== null && typeof a === 'object' ? a : {}))
                .map((a) => ({ label: str(a.label), say: str(a.say) }))
                .filter((a) => a.label !== null && a.say !== null)
                .slice(0, 3);
            // A question that vanishes has not been asked, so one with replies stands
            // until it is answered unless the caller insists on a clock.
            const kind = p.kind === 'ask' || actions.length > 0 ? 'ask' : 'say';
            const ms = typeof p.ms === 'number' && Number.isFinite(p.ms) && p.ms >= 0 ? Math.min(60_000, Math.round(p.ms)) : kind === 'ask' ? 0 : 5000;
            return done({ notice: { text, kind, ms, actions, at } });
        }
        case 'board:walk': {
            const raw = Array.isArray(p.steps) ? p.steps : [];
            const steps = raw
                .map((s) => (s && typeof s === 'object' ? s : {}))
                .map((s) => ({ ids: Array.isArray(s.ids) ? s.ids.filter((m) => typeof m === 'string') : [], text: str(s.text) ?? '', weight: weightOf(s.weight) }))
                .filter((s) => s.ids.length > 0 || s.text !== '');
            const autoAdvanceMs = typeof p.autoAdvanceMs === 'number' && Number.isFinite(p.autoAdvanceMs) && p.autoAdvanceMs > 0 ? p.autoAdvanceMs : null;
            return done({ walk: steps.length ? { steps, cursor: 0, autoAdvanceMs, at } : null });
        }
        case 'board:step': {
            const ids = Array.isArray(p.ids) ? p.ids.filter((m) => typeof m === 'string') : [];
            const text = str(p.text) ?? '';
            if (ids.length === 0 && text === '')
                return { state, effects: [] };
            const prior = board.walk;
            return done({ walk: { steps: [...(prior?.steps ?? []), { ids, text, weight: weightOf(p.weight) }], cursor: prior?.cursor ?? 0, autoAdvanceMs: prior?.autoAdvanceMs ?? null, at } });
        }
        case 'board:continue': {
            if (board.walk === null)
                return { state, effects: [] };
            return done({ walk: { ...board.walk, cursor: board.walk.steps.length } });
        }
        case 'board:plan': {
            const STATUS = new Set(['pending', 'in_progress', 'completed', 'skipped']);
            const raw = Array.isArray(p.steps) ? p.steps : [];
            const steps = raw
                .map((s) => (s && typeof s === 'object' ? s : {}))
                .filter((s) => typeof s.content === 'string' && s.content.trim() !== '')
                .map((s) => ({ content: s.content.trim(), status: (STATUS.has(s.status) ? s.status : 'pending') }));
            return done({ plan: steps.length ? { steps, at } : null });
        }
        case 'board:span': {
            // Resolved here, not in the client: a reader answering about a card the
            // owner wound back to Tuesday must answer about Tuesday, and it reads the
            // record, not the browser. A payload naming no span at all clears it back
            // to today rather than leaving the board somewhere nobody chose.
            const span = resolveSpan(p, dayOf(at, state.config.timezone));
            return done({ span: span === null ? null : { ...span, at } });
        }
        case 'board:section': {
            const id = str(p.id);
            if (id === null)
                return { state, effects: [] };
            const prior = board.sections[id];
            const section = {
                label: str(p.label) ?? prior?.label ?? id,
                x: num(p.x, prior?.x ?? 0),
                y: num(p.y, prior?.y ?? 0),
                w: Math.max(400, num(p.w, prior?.w ?? 1200)),
                h: Math.max(300, num(p.h, prior?.h ?? 800)),
                anchor: p.anchor === undefined ? (prior?.anchor ?? null) : str(p.anchor),
                at,
            };
            return done({ sections: { ...board.sections, [id]: section } });
        }
        case 'board:unsection': {
            const id = str(p.id);
            if (id === null || !(id in board.sections))
                return { state, effects: [] };
            const { [id]: _gone, ...sections } = board.sections;
            return done({ sections });
        }
        case 'board:clear':
            return done({ cards: {}, walk: null, plan: null });
        case 'board:arrange':
            return done({ cards: board.cards });
        case 'board:save': {
            const name = str(p.name);
            if (name === null)
                return { state, effects: [] };
            const cards = Object.values(board.cards);
            return done({ scenes: { ...board.scenes, [name]: { cards, savedAt: at } } });
        }
        case 'board:load': {
            const name = str(p.name);
            const scene = name === null ? undefined : board.scenes[name];
            if (scene === undefined)
                return { state, effects: [] };
            const cards = {};
            for (const c of scene.cards)
                cards[c.id] = { ...c, at };
            return done({ cards, focus: { ids: scene.cards.map((c) => c.id), text: null, at } });
        }
        default:
            return { state, effects: [] };
    }
};
//# sourceMappingURL=board-track.js.map