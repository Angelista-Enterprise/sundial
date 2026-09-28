import { describe, expect, it } from 'vitest';
import { rejectCanvasHtml, rejectSurfacePayload, showSurfaceTool, SURFACE_KINDS, SURFACE_TOOL_NAME } from './show-surface.js';

const CHART = {
  x: ['2026-08-10', '2026-08-11'],
  series: [{ name: 'Deep focus', unit: 'min', mark: 'derived', values: [64, null] }],
};
const GRID = {
  columns: [
    { key: 'time', label: 'Time' },
    { key: 'minutes', label: 'Minutes', type: 'number', align: 'right' },
  ],
  rows: [{ time: 'Wed 08:40', minutes: 105 }],
};

const NEIGHBORHOOD = {
  center: { name: 'overture' },
  edges: [
    { toName: 'Pat', predicate: 'worked-on-by' },
    { toName: 'Svelte', predicate: 'uses', inferred: true },
    { toName: 'acme', predicate: 'belonged-to', superseded: true },
  ],
};
const FLOW = {
  nodes: [
    { id: 'signal', label: 'signal', kind: 'source' },
    { id: 'reducer', label: 'reduce()', kind: 'pure' },
    { id: 'effect', label: 'effect executor', kind: 'io' },
  ],
  edges: [
    ['signal', 'reducer'],
    ['reducer', 'effect'],
  ],
};
const GAUGES = {
  readings: [
    { label: 'Focus', value: 41, unit: '%', max: 100, typical: 58, mark: 'derived' },
    { label: 'Context switches', value: 214, typical: 130, mark: 'observed' },
    { label: 'Keystroke hours', value: null, mark: 'absent', note: 'Input Monitoring is off' },
  ],
};

describe('rejectSurfacePayload', () => {
  it('accepts a well-formed chart', () => {
    expect(rejectSurfacePayload('chart', CHART)).toBeNull();
  });

  it('accepts a well-formed grid', () => {
    expect(rejectSurfacePayload('grid', GRID)).toBeNull();
  });

  it('accepts a well-formed neighborhood, flow and gauge row', () => {
    expect(rejectSurfacePayload('graph-neighborhood', NEIGHBORHOOD)).toBeNull();
    expect(rejectSurfacePayload('flow', FLOW)).toBeNull();
    expect(rejectSurfacePayload('gauge-row', GAUGES)).toBeNull();
  });

  // The neighborhood payload is the same shape composeFigure already emits, so
  // the client draws the model's graph and Gnomon's own through one renderer.
  it('takes the graph-neighborhood figure composeFigure produces, unchanged', () => {
    expect(rejectSurfacePayload('graph-neighborhood', { kind: 'graph-neighborhood', ...NEIGHBORHOOD })).toBeNull();
  });

  it('accepts a single-step flow, whose edge list is legitimately empty', () => {
    expect(rejectSurfacePayload('flow', { nodes: [{ id: 'a', label: 'one step' }], edges: [] })).toBeNull();
  });

  it.each([
    ['a neighborhood with no center', 'graph-neighborhood', { edges: NEIGHBORHOOD.edges }, 'needs a center'],
    ['a neighborhood with no edges', 'graph-neighborhood', { center: { name: 'x' }, edges: [] }, 'one dot'],
    ['an unnamed edge', 'graph-neighborhood', { center: { name: 'x' }, edges: [{ predicate: 'uses' }] }, 'needs a toName'],
    ['a non-boolean mark', 'graph-neighborhood', { center: { name: 'x' }, edges: [{ toName: 'y', inferred: 'maybe' }] }, 'true or false'],
    ['no nodes', 'flow', { nodes: [], edges: [] }, 'needs a nodes array'],
    ['a duplicate node id', 'flow', { nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], edges: [] }, 'share the id'],
    ['an unlabelled node', 'flow', { nodes: [{ id: 'a' }], edges: [] }, 'needs a label'],
    ['a malformed edge', 'flow', { nodes: [{ id: 'a', label: 'A' }], edges: [['a']] }, '[from, to] pair'],
    // The failure that matters: an edge naming a node that was never sent draws
    // an arrow into nothing, which reads as a missing step rather than a bug.
    ['an edge into nowhere', 'flow', { nodes: [{ id: 'a', label: 'A' }], edges: [['a', 'ghost']] }, 'not one of the nodes'],
    ['no readings', 'gauge-row', { readings: [] }, 'needs a readings array'],
    ['seven readings', 'gauge-row', { readings: Array.from({ length: 7 }, (_, i) => ({ label: `r${i}`, value: 1, mark: 'observed' })) }, 'is a grid'],
    ['a reading with no mark', 'gauge-row', { readings: [{ label: 'Focus', value: 41 }] }, 'needs a mark'],
    ['a string value', 'gauge-row', { readings: [{ label: 'Focus', value: 'high', mark: 'observed' }] }, 'never zero'],
    ['a value past its own max', 'gauge-row', { readings: [{ label: 'Focus', value: 140, max: 100, mark: 'derived' }] }, 'raise the max'],
    ['a non-numeric baseline', 'gauge-row', { readings: [{ label: 'Focus', value: 4, typical: 'usual', mark: 'derived' }] }, 'must be a number'],
  ])('rejects %s', (_name, kind, payload, fragment) => {
    expect(rejectSurfacePayload(kind, payload)).toContain(fragment);
  });

  it.each([
    ['no payload object', 'chart', null, 'payload must be a JSON object'],
    ['empty x', 'chart', { ...CHART, x: [] }, 'non-empty x axis'],
    ['no series', 'chart', { x: CHART.x, series: [] }, 'at least one series'],
    ['length mismatch', 'chart', { x: CHART.x, series: [{ name: 's', mark: 'observed', values: [1] }] }, 'must match'],
    ['missing mark', 'chart', { x: CHART.x, series: [{ name: 's', values: [1, 2] }] }, 'needs a mark'],
    ['string value', 'chart', { x: CHART.x, series: [{ name: 's', mark: 'observed', values: [1, 'two'] }] }, 'numbers or null'],
    ['no columns', 'grid', { columns: [], rows: [{}] }, 'columns array'],
    ['column without label', 'grid', { columns: [{ key: 'k' }], rows: [{}] }, 'needs a label'],
    ['empty rows', 'grid', { ...GRID, rows: [] }, 'empty frame'],
    ['unknown kind', 'sparkline', {}, 'unknown kind'],
  ])('rejects %s', (_name, kind, payload, fragment) => {
    expect(rejectSurfacePayload(kind, payload)).toContain(fragment);
  });
});

describe('showSurfaceTool', () => {
  const definition = showSurfaceTool();

  it('is named for the toolview key the theme client registers', () => {
    expect(definition.name).toBe(SURFACE_TOOL_NAME);
  });

  it('is never concurrency-safe — it moves the owner\'s window', () => {
    expect(definition.isConcurrencySafe()).toBe(false);
  });

  it('confirms a sound envelope without echoing the payload', async () => {
    const value = await definition.execute({ kind: 'chart', title: 'Deep focus, seven days', payload: CHART });
    expect(value).toEqual({ drawn: true, kind: 'chart', title: 'Deep focus, seven days' });
  });

  it('returns the rejection reason so the model can re-shape', async () => {
    const value = await definition.execute({ kind: 'grid', title: 'Moments', payload: { columns: GRID.columns, rows: [] } });
    expect(value.drawn).toBe(false);
    expect(value.reason).toContain('empty frame');
  });

  it('accepts a payload that arrives as its JSON string (provider adapters differ)', async () => {
    const value = await definition.execute({ kind: 'chart', title: 'Deep focus', payload: JSON.stringify(CHART) });
    expect(value.drawn).toBe(true);
  });

  it('rejects a blank title', async () => {
    const value = await definition.execute({ kind: 'chart', title: '  ', payload: CHART });
    expect(value).toEqual({ drawn: false, reason: 'a surface needs a title' });
  });

  it('advertises every drawable kind in the schema enum', () => {
    const schema = definition.parameters?.properties?.kind ?? definition.parameters?.kind;
    expect(JSON.stringify(schema)).toContain(JSON.stringify(SURFACE_KINDS).slice(1, -1));
  });
});

describe('canvas', () => {
  it('is a kind, and accepts plain HTML with inline SVG and CSS', () => {
    expect(SURFACE_KINDS).toContain('canvas');
    expect(rejectSurfacePayload('canvas', { html: '<h1 style="color:navy">A week</h1><svg viewBox="0 0 10 10"><rect width="4" height="4" fill="#123"/></svg>', height: 240 })).toBeNull();
    expect(rejectSurfacePayload('canvas', { html: '<img src="data:image/png;base64,AAAA">' })).toBeNull();
  });

  it('refuses anything that could run or leave the machine, and says why', () => {
    expect(rejectCanvasHtml('<script>alert(1)</script>')).toMatch(/no <script>/);
    expect(rejectCanvasHtml('<div onclick="x()">hi</div>')).toMatch(/on\*= handlers/);
    expect(rejectCanvasHtml('<a href="javascript:void(0)">x</a>')).toMatch(/javascript:/);
    expect(rejectCanvasHtml('<img src="https://example.com/a.png">')).toMatch(/external loads/);
    expect(rejectCanvasHtml('<img src="//example.com/a.png">')).toMatch(/external loads/);
    expect(rejectCanvasHtml('<div style="background:url(https://x/y.png)">')).toMatch(/external url/);
    expect(rejectCanvasHtml('<style>@import url(x.css)</style>')).toMatch(/@import/);
    expect(rejectCanvasHtml('<iframe src="about:blank">')).toMatch(/no frames/);
    expect(rejectCanvasHtml('<form><input></form>')).toMatch(/no frames, embeds, forms/);
    expect(rejectCanvasHtml('')).toMatch(/needs html/);
    expect(rejectCanvasHtml('x'.repeat(24_001))).toMatch(/cap is 24000/);
  });

  it('bounds the height', () => {
    expect(rejectSurfacePayload('canvas', { html: '<p>x</p>', height: 20 })).toMatch(/height/);
    expect(rejectSurfacePayload('canvas', { html: '<p>x</p>', height: 2000 })).toMatch(/height/);
  });
});
