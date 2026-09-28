// Gnomon parameter schemas (zod → JSON Schema via `toolDefinitions`) → dsh
// ValueSchemaSpec / ParameterSchemaSpec.
//
// dsh enforces a deliberate JSON Schema SUBSET (see dsh-tools/json-schema):
// one scalar `type`, `properties`/`required`/boolean `additionalProperties`,
// `items`, type-correct `enum`/`const`, exact-one `oneOf` — and nothing else.
// Gnomon's zod shapes emit three keywords outside that subset:
//
//   - `exclusiveMinimum` (every z.number().positive())
//   - `maximum`          (every .max(N) row limit)
//   - `maxLength`        (gnomon_show_view's `because` chip text)
//
// Dropping those silently would delete the one place the model is told "limit
// is at most 200", so each dropped constraint is folded into the property's
// description instead — the model still reads it, dsh just does not enforce
// it. Gnomon's own zod validation still runs inside execute (see
// to-dsh-tool.js), so an out-of-range value is REJECTED exactly as before;
// the model gets zod's message as a tool error and retries.
//
// Named exports only.

/** Constraint keywords outside dsh's subset, rendered into prose. Ordered for stable output. */
const CONSTRAINT_RENDERERS = [
  ['exclusiveMinimum', (v) => `> ${v}`],
  ['minimum', (v) => `>= ${v}`],
  ['exclusiveMaximum', (v) => `< ${v}`],
  ['maximum', (v) => `<= ${v}`],
  ['minLength', (v) => `min length ${v}`],
  ['maxLength', (v) => `max length ${v}`],
  ['pattern', (v) => `pattern ${v}`],
  ['format', (v) => `format ${v}`],
  ['minItems', (v) => `min items ${v}`],
  ['maxItems', (v) => `max items ${v}`],
  ['multipleOf', (v) => `multiple of ${v}`],
];

/** The scalar types dsh's subset shares with JSON Schema. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/**
 * One JSON Schema node (as zod 4's `z.toJSONSchema` emits it) → one dsh
 * `ValueSchemaSpec`. Unsupported constraint keywords are folded into the
 * description; a node with no usable `type` becomes `{ type: 'json' }`
 * (dsh's unconstrained-JSON author node).
 */
export function toValueSchemaSpec(node) {
  if (node === undefined || node === null || node === true) return { type: 'json' };

  const spec = {};
  if (typeof node.title === 'string') spec.title = node.title;
  if (node.default !== undefined) spec.default = node.default;
  if (node.examples !== undefined) spec.examples = node.examples;

  const notes = [];
  for (const [keyword, render] of CONSTRAINT_RENDERERS) {
    if (node[keyword] !== undefined) notes.push(render(node[keyword]));
  }
  const description = [typeof node.description === 'string' ? node.description : null, notes.length > 0 ? `(${notes.join(', ')})` : null]
    .filter(Boolean)
    .join(' ');
  if (description.length > 0) spec.description = description;

  // zod emits unions as `anyOf`; dsh's subset only has exact-one `oneOf`.
  // Gnomon's registry has no unions today, so this path is future-proofing:
  // a 1-branch union collapses, >=2 branches map across.
  const branches = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : null;
  if (branches !== null) {
    if (branches.length === 1) return { ...toValueSchemaSpec(branches[0]), ...spec };
    spec.oneOf = branches.map((branch) => toValueSchemaSpec(branch));
    return spec;
  }

  if (SCALAR_TYPES.has(node.type)) {
    spec.type = node.type;
    if (Array.isArray(node.enum)) spec.enum = node.enum;
    if (node.const !== undefined) spec.const = node.const;
    return spec;
  }

  if (node.type === 'array') {
    spec.type = 'array';
    if (node.items !== undefined) spec.items = toValueSchemaSpec(node.items);
    return spec;
  }

  if (node.type === 'object') {
    spec.type = 'object';
    if (node.properties !== undefined) {
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const properties = {};
      for (const [key, child] of Object.entries(node.properties)) {
        const prop = toValueSchemaSpec(child);
        if (required.has(key)) prop.required = true;
        properties[key] = prop;
      }
      spec.properties = properties;
    }
    // dsh REQUIRES explicit openness on every object node, so a nested object
    // never inherits JSON Schema's silent open default. Closed unless the
    // source schema explicitly said open.
    spec.additionalProperties = node.additionalProperties === true;
    return spec;
  }

  // No recognised `type` (annotation-only node): unconstrained JSON.
  spec.type = 'json';
  return spec;
}

/**
 * A gnomon tool's object-rooted parameters JSON Schema (what
 * `toolDefinitions()` puts on the wire for the OpenAI format) → dsh's
 * implicit-object-root `ParameterSchemaSpec` map.
 *
 * The `$schema` marker and the object root itself are dropped — dsh's
 * parameter map IS the object root — and requiredness moves from the parent's
 * `required` array onto per-property `required: true` annotations.
 */
export function toParameterSchemaSpec(parametersJsonSchema) {
  if (parametersJsonSchema === undefined || parametersJsonSchema === null) return {};
  if (parametersJsonSchema.type !== undefined && parametersJsonSchema.type !== 'object') {
    throw new Error(`toParameterSchemaSpec: parameters root must be an object schema, got type=${String(parametersJsonSchema.type)}`);
  }
  const required = new Set(Array.isArray(parametersJsonSchema.required) ? parametersJsonSchema.required : []);
  const out = {};
  for (const [key, node] of Object.entries(parametersJsonSchema.properties ?? {})) {
    const prop = toValueSchemaSpec(node);
    if (required.has(key)) prop.required = true;
    out[key] = prop;
  }
  return out;
}
