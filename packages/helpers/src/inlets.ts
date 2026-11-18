import fs from 'node:fs';
import path from 'node:path';
import { getSundialHome } from './config.js';

/**
 * Inlets: any other system's events, entering the record the way a sensor's do.
 *
 * A webhook, a Shortcut, another agent, the observatory: each appends one
 * `ext:<name>` event, through `gnomon_ingest` (MCP) or `sundial ingest <type>
 * [json]`, both a queued request the running Sundial applies through
 * `appendSignal`, so it is sanitized at ingest like every sensor row. Only a
 * type the owner declared in `$SUNDIAL_HOME/inlets.json` is taken, and only
 * its declared fields, each of its declared kind:
 *
 *   { "ext:deploy": { "fields": { "service": "string", "ok": "boolean" } } }
 *
 * so a `where` on an inlet names fields that exist, and nothing the owner did
 * not ask for rides in on an outside system's say-so.
 */

export type InletField = 'string' | 'number' | 'boolean';
export type Inlets = Record<string, { fields: Record<string, InletField> }>;

export const INLET_TYPE = /^ext:[a-z-]+$/;
const FIELD = /^[A-Za-z0-9_]{1,40}$/;
const KINDS = new Set<InletField>(['string', 'number', 'boolean']);
/** An inlet's text field is a field, not a document. */
const TEXT_CHARS = 2000;

export function inletsPath(): string {
  return path.join(getSundialHome(), 'inlets.json');
}

/** The declared inlets, checked: a malformed entry or field is left out, a missing or unreadable file is none. */
export function readInlets(file = inletsPath()): Inlets {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const out: Inlets = {};
  for (const [type, decl] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    const fields = (decl as { fields?: unknown } | null)?.fields;
    if (!INLET_TYPE.test(type) || typeof fields !== 'object' || fields === null) continue;
    out[type] = { fields: Object.fromEntries(Object.entries(fields).filter(([k, v]) => FIELD.test(k) && KINDS.has(v as InletField))) as Record<string, InletField> };
  }
  return out;
}

/**
 * One inlet event's payload: its declared fields of their declared kind, the
 * rest dropped (and named, so the caller can say so). An undeclared type is
 * refused.
 */
export function inletPayload(type: string, payload: unknown, inlets: Inlets): { payload: Record<string, unknown>; dropped: string[] } | { error: string } {
  if (!INLET_TYPE.test(type)) return { error: 'an inlet type is ext:<name>, lowercase letters and dashes' };
  const decl = inlets[type];
  if (!decl) return { error: `${type} is not declared in inlets.json; declared: ${Object.keys(inlets).join(', ') || 'none'}` };
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { error: 'the payload is a JSON object' };
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    const kind = decl.fields[k];
    if (kind !== undefined && typeof v === kind && (kind !== 'number' || Number.isFinite(v))) kept[k] = kind === 'string' ? (v as string).slice(0, TEXT_CHARS) : v;
    else dropped.push(k);
  }
  return { payload: kept, dropped };
}
