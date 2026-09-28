// show_surface — the one tool that draws an interactive surface in the owner's
// chat (gnomon_redesign/handoff, §6). One tool, one `kind` discriminator, one
// payload per kind; the model picks the shape and supplies the data, the
// client owns the drawing (plugins/sundial-theme/shell/surfaces.js renders each
// kind; the frame reaches it through the session log, not through a tool seat).
//
// Like gnomon_show_view it is readOnly: false — it moves the owner's window —
// so it lives OUTSIDE ASK_TOOL_REGISTRY on purpose and is never advertised
// over MCP. dsh's chat is the owner's own surface, which is the only place
// this tool exists.
//
// The envelope rules (from the handoff, enforced here so a malformed surface
// dies at the tool boundary instead of drawing wrong):
//   - every series/column value set carries its mark
//     (observed · derived · inferred · absent · verified)
//   - null is "not observed", never zero — the renderer draws an em dash
//   - a payload the validator rejects returns { drawn: false, reason } so the
//     model can re-shape it, the same contract gnomon_assert uses.
//
// Named exports only.
import { defineTool } from '@deepseek-ai/dsh-tools';

export const SURFACE_TOOL_NAME = 'show_surface';

/**
 * The kinds the client can draw today.
 *
 * The handoff catalogue specs sixteen. Most of them are not Gnomon's, and its
 * own closing note says so: five are smart-home controls (radial-dial,
 * colour-picker, entity-grid, gauge-row, camera) that "need a bridge that does
 * not exist yet", three are web and media surfaces that need a fetch-and-
 * snapshot path, and board is state the owner holds rather than a reading of
 * the record. What is left — the five it calls out as reading the record as it
 * stands — is chart, grid, graph-neighborhood, flow, and form.
 *
 * Four of those five are here. `form` is deliberately absent: it is the shape
 * of a question Gnomon ASKS, which belongs with gnomon_ask_owner and not with a
 * tool whose whole contract is one-way.
 *
 * `gauge-row` survives from the home five, reinterpreted. A row of sensor dials
 * is not Gnomon's data; a row of the day's own readings against what is typical
 * for the owner is exactly Gnomon's data, and nothing else here draws one number
 * against its own baseline.
 */
export const SURFACE_KINDS = ['chart', 'grid', 'graph-neighborhood', 'flow', 'gauge-row', 'canvas'];

/** A canvas payload's html is bounded; a page is not a surface. */
export const MAX_CANVAS_HTML_CHARS = 24_000;
export const CANVAS_MIN_HEIGHT = 120;
export const CANVAS_MAX_HEIGHT = 900;

/**
 * What a canvas may not contain. The client draws it in an iframe with
 * `sandbox` (no scripts) and a CSP of `default-src 'none'`, so these are belt
 * to that braces: a rejected payload tells the model WHY, where a silently
 * blocked script would just look like a broken drawing. Nothing may run and
 * nothing may leave the machine — the same posture every other read path keeps.
 */
const CANVAS_FORBIDDEN = [
  [/<\s*script\b/i, 'no <script>'],
  [/<\s*(iframe|object|embed|frame|frameset|link|meta|base|form|input|button|textarea|select)\b/i, 'no frames, embeds, forms, <link>, <meta> or <base>'],
  [/\bon[a-z]+\s*=/i, 'no on*= handlers'],
  [/javascript\s*:/i, 'no javascript: URLs'],
  [/\b(src|href|xlink:href|action|poster|background)\s*=\s*["']?\s*(https?:)?\/\//i, 'no external loads — inline everything, data: URIs are fine'],
  [/url\(\s*["']?\s*(https?:)?\/\//i, 'no external url() in styles'],
  [/@import\b/i, 'no @import'],
];

/** Why a canvas html is refused, or null when it is clean. */
export function rejectCanvasHtml(html) {
  if (typeof html !== 'string' || html.trim() === '') return 'canvas needs html: a string of HTML and inline SVG/CSS';
  if (html.length > MAX_CANVAS_HTML_CHARS) return `canvas html is ${html.length} chars; the cap is ${MAX_CANVAS_HTML_CHARS}`;
  for (const [pattern, reason] of CANVAS_FORBIDDEN) if (pattern.test(html)) return `canvas: ${reason}`;
  return null;
}

const MARKS = ['observed', 'derived', 'inferred', 'absent', 'verified'];

/**
 * The wire sometimes hands a json-typed argument over as its raw string —
 * provider adapters differ. Accept both; reject only what neither form is.
 */
export function normalizeSurfacePayload(payload) {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/** Validate one payload against its kind. Returns null when valid, else the reason. */
export function rejectSurfacePayload(kind, payload) {
  if (typeof payload !== 'object' || payload === null) return 'payload must be a JSON object (it arrived as a non-object — send the object itself, not prose)';
  if (kind === 'chart') {
    if (!Array.isArray(payload.x) || payload.x.length === 0) return 'chart payload needs a non-empty x axis array';
    if (!Array.isArray(payload.series) || payload.series.length === 0) return 'chart payload needs at least one series';
    for (const series of payload.series) {
      if (typeof series?.name !== 'string' || series.name === '') return 'every series needs a name';
      if (!Array.isArray(series.values)) return `series "${series.name}" needs a values array`;
      if (series.values.length !== payload.x.length)
        return `series "${series.name}" has ${series.values.length} values for ${payload.x.length} x entries — they must match`;
      if (!MARKS.includes(series.mark)) return `series "${series.name}" needs a mark: one of ${MARKS.join(', ')}`;
      for (const value of series.values) {
        if (value !== null && typeof value !== 'number') return `series "${series.name}" values must be numbers or null (null = not observed, never zero)`;
      }
    }
    return null;
  }
  if (kind === 'grid') {
    if (!Array.isArray(payload.columns) || payload.columns.length === 0) return 'grid payload needs a columns array';
    for (const column of payload.columns) {
      if (typeof column?.key !== 'string' || column.key === '') return 'every column needs a key';
      if (typeof column?.label !== 'string' || column.label === '') return `column "${column.key}" needs a label`;
    }
    if (!Array.isArray(payload.rows)) return 'grid payload needs a rows array';
    if (payload.rows.length === 0) return 'a grid with no rows says nothing — say so in prose instead of drawing an empty frame';
    return null;
  }
  if (kind === 'graph-neighborhood') {
    // Deliberately the same shape `composeFigure({kind:'graph-neighborhood'})`
    // produces, so the client draws both through one renderer. A second layout
    // for the same picture would drift the moment either changed.
    if (typeof payload.center?.name !== 'string' || payload.center.name === '') return 'a neighborhood needs a center: { name }';
    if (!Array.isArray(payload.edges) || payload.edges.length === 0)
      return 'a neighborhood with no edges is one dot — say the entity is isolated in prose instead of drawing it';
    for (const edge of payload.edges) {
      if (typeof edge?.toName !== 'string' || edge.toName === '') return 'every edge needs a toName';
      // `inferred` and `superseded` ARE the mark here: the renderer dashes an
      // inferred edge and greys a superseded one. Both default to false, so an
      // edge that says nothing is claiming to be current and observed — which is
      // a claim, and has to be a deliberate one.
      if (edge.inferred !== undefined && typeof edge.inferred !== 'boolean') return `edge to "${edge.toName}": inferred must be true or false`;
      if (edge.superseded !== undefined && typeof edge.superseded !== 'boolean') return `edge to "${edge.toName}": superseded must be true or false`;
    }
    return null;
  }
  if (kind === 'flow') {
    if (!Array.isArray(payload.nodes) || payload.nodes.length === 0) return 'flow payload needs a nodes array';
    const ids = new Set();
    for (const node of payload.nodes) {
      if (typeof node?.id !== 'string' || node.id === '') return 'every node needs an id';
      if (ids.has(node.id)) return `two nodes share the id "${node.id}"`;
      ids.add(node.id);
      if (typeof node?.label !== 'string' || node.label === '') return `node "${node.id}" needs a label`;
    }
    if (!Array.isArray(payload.edges)) return 'flow payload needs an edges array (use [] for a single step)';
    for (const edge of payload.edges) {
      if (!Array.isArray(edge) || edge.length !== 2) return 'every flow edge is a [from, to] pair of node ids';
      for (const end of edge) {
        if (!ids.has(end)) return `flow edge names "${end}", which is not one of the nodes`;
      }
    }
    return null;
  }
  if (kind === 'gauge-row') {
    if (!Array.isArray(payload.readings) || payload.readings.length === 0) return 'gauge-row payload needs a readings array';
    if (payload.readings.length > 6) return 'more than six readings is a grid, not a row — use kind "grid"';
    for (const reading of payload.readings) {
      if (typeof reading?.label !== 'string' || reading.label === '') return 'every reading needs a label';
      if (typeof reading.value !== 'number' && reading.value !== null)
        return `reading "${reading.label}" needs a number, or null for not observed (never zero)`;
      if (!MARKS.includes(reading.mark)) return `reading "${reading.label}" needs a mark: one of ${MARKS.join(', ')}`;
      // The baseline is what makes a single number mean anything. It is
      // optional because it is not always known — but a gauge without one is
      // just a number, and the renderer says as much rather than inventing a
      // scale.
      if (reading.typical !== undefined && reading.typical !== null && typeof reading.typical !== 'number')
        return `reading "${reading.label}": typical must be a number or null`;
      if (reading.max !== undefined && typeof reading.max !== 'number') return `reading "${reading.label}": max must be a number`;
      if (typeof reading.max === 'number' && typeof reading.value === 'number' && reading.value > reading.max)
        return `reading "${reading.label}" is ${reading.value} against a max of ${reading.max} — raise the max or drop it`;
    }
    return null;
  }
  if (kind === 'canvas') {
    const reason = rejectCanvasHtml(payload.html);
    if (reason) return reason;
    if (payload.height !== undefined && (typeof payload.height !== 'number' || payload.height < CANVAS_MIN_HEIGHT || payload.height > CANVAS_MAX_HEIGHT)) {
      return `canvas height must be a number between ${CANVAS_MIN_HEIGHT} and ${CANVAS_MAX_HEIGHT}`;
    }
    return null;
  }
  return `unknown kind "${kind}" — the client draws: ${SURFACE_KINDS.join(', ')}`;
}

/** The registry-ready dsh ToolDefinition. */
export function showSurfaceTool() {
  return defineTool({
    name: SURFACE_TOOL_NAME,
    description: [
      'Draw one interactive surface in the chat instead of restating numbers in prose. Draw one when seeing the',
      'shape says something the sentence cannot (a comparison, a distribution, a table the owner will sort);',
      'do NOT draw one when a sentence carries it, when the data is absent (say so instead), or as a second',
      'surface in the same answer — one per turn.',
      'Marks are required wherever a number is: observed|derived|inferred|absent|verified. null means "not',
      'observed", never zero. kinds:',
      '"chart" — a comparison or a trend over time. payload: { x: string[], series: [{ name, unit?, mark,',
      'values: (number|null)[] }], note? }.',
      '"grid" — a table of anything the answer is a list OF: people and how you know them, places and when you',
      'were there, files, commits, meetings, sessions, open threads, whatever the owner asked for. Reach for it',
      'whenever the answer has more than about four rows or more than one column per row — a list that long is a',
      'table read aloud, and the owner cannot scan or sort it in prose. payload: { columns: [{ key, label, type?,',
      'align? }], rows: object[], note? }; give `type: "number"` to anything numeric so it right-aligns and sorts',
      'as a number. The owner sorts by clicking a column, so send every row once rather than a "top five".',
      '"graph-neighborhood" — what one entity is connected to. payload: { center: { name }, edges: [{ toName,',
      'predicate?, inferred?, superseded? }] }; leave inferred/superseded off only for a current, observed link.',
      '"flow" — a pipeline or a sequence of steps, when the SHAPE is the point. payload: { nodes: [{ id, label,',
      'kind? }], edges: [[fromId, toId], …], note? }.',
      '"gauge-row" — up to six of today\'s readings each against what is typical for this owner. payload:',
      '{ readings: [{ label, value, unit?, max?, typical?, mark, note? }] }; use it when the question is "is that',
      'a lot?", which no single number answers.',
      '"canvas" — anything the other kinds cannot hold: a diagram, a sketch of a layout, a timeline drawn by hand,',
      'a card, a poem set in type, a mock of a screen. payload: { html: string, height?: number }. Plain HTML with',
      'inline SVG and inline CSS ONLY — no scripts, no forms, no external images, fonts or links (data: URIs are',
      'fine); it is drawn in a sandbox that runs nothing and loads nothing. Use it to EXPRESS, not to smuggle a',
      'chart the chart kind draws better. Keep it under 24k characters.',
      'If the payload is rejected the reason comes back — re-shape and retry.',
    ].join(' '),
    parameters: {
      kind: { type: 'string', required: true, enum: SURFACE_KINDS, description: 'The surface to draw.' },
      title: { type: 'string', required: true, description: 'Short title shown on the surface frame, e.g. "Deep focus, seven days".' },
      because: { type: 'string', description: 'Why this is being shown, in the owner\'s words (keep it under 120 characters), e.g. "you asked where the week went".' },
      expandable: { type: 'boolean', description: 'Offer the full-canvas open. Default true.' },
      payload: { type: 'json', required: true, description: 'The kind-shaped data (see the tool description).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          drawn: { type: 'boolean' },
          kind: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.drawn
            ? `Drew ${value.kind} surface "${value.title}". The owner sees it rendered in the chat — do not restate its numbers in prose.`
            : `Not drawn: ${value.reason}`,
        },
      ],
    },
    // It moves the owner's window: never safe to run inside a parallel group.
    isConcurrencySafe: () => false,
    async execute(args) {
      const kind = String(args.kind);
      const title = String(args.title ?? '').trim();
      if (!title) return { drawn: false, reason: 'a surface needs a title' };
      const reason = rejectSurfacePayload(kind, normalizeSurfacePayload(args.payload));
      if (reason) return { drawn: false, reason };
      // The drawing itself happens client-side from this call's own args —
      // the result only confirms the envelope was sound.
      return { drawn: true, kind, title };
    },
  });
}
