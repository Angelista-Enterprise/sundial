// A tool call's arguments, made to fit the tool's own schema where the model's
// intent is not in doubt.
//
// Measured on the demo record (2026-10-02): the chat model sent `{"weeks": "2"}`,
// `{"limit": "30"}`, `{"expandable": "true"}` and `{"queries": "[\"a\", \"b\"]"}`.
// dsh rejects each one as INVALID_ARGS, the owner sees "Looked at 13 things ·
// 4 failed", and the model spends a step retrying the same call. A value is
// changed only when it does not fit its declared type AND its text reads as
// exactly that type; everything else reaches dsh's validation unchanged, so a
// real mistake still fails the way it always did.
//
// Named exports only.

const INTEGER = /^-?\d+$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function parsed(text, test) {
  try {
    const value = JSON.parse(text);
    return test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One value against one JSON Schema node. Returns the SAME value when nothing changed. */
export function coerceValue(schema, value) {
  if (!schema || typeof schema !== 'object' || value === null || value === undefined) return value;
  const text = typeof value === 'string' ? value.trim() : null;
  switch (schema.type) {
    case 'integer':
      return text !== null && INTEGER.test(text) ? Number(text) : value;
    case 'number':
      return text !== null && NUMBER.test(text) ? Number(text) : value;
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : value;
    case 'array': {
      const list = Array.isArray(value) ? value : text?.startsWith('[') ? parsed(text, Array.isArray) : undefined;
      if (list === undefined) return value;
      const items = list.map((item) => coerceValue(schema.items, item));
      return list === value && items.every((item, i) => item === list[i]) ? value : items;
    }
    case 'object': {
      const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
      const object = isObject(value) ? value : text?.startsWith('{') ? parsed(text, isObject) : undefined;
      if (object === undefined) return value;
      let changed = object !== value;
      const out = {};
      for (const [key, inner] of Object.entries(object)) {
        out[key] = coerceValue(schema.properties?.[key], inner);
        if (out[key] !== inner) changed = true;
      }
      return changed ? out : value;
    }
    default:
      return value;
  }
}

/** A call's whole argument object against its tool's parameter schema. */
export function coerceArgs(parameters, args) {
  return coerceValue(parameters ?? null, args);
}
