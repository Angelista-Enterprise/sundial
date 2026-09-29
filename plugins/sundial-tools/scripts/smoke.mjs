// Smoke: the sundial-tools plugin against the REAL harness record.
//
// The live db (~/.sundial/sundial.db) belongs to the running dsh
// process, so this script NEVER opens it: it copies db+wal+shm to a /tmp
// scratch dir first (some read paths bump last_accessed_at, so even "reads"
// need a copy) and points @sundial/db there. Run from the plugin dir:
//
//   node scripts/smoke.mjs
//
// It fakes a Cordis ctx carrying the three services, applies the plugin,
// converts all 13 tools, validates every parameter schema with dsh's own
// assertSupportedJsonSchema/validateArgs, and executes
// gnomon_current_context + gnomon_today_summary against the record.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 1. scratch copy of the real record (read-only posture toward the original) ──
const SOURCE = path.join(process.env.SUNDIAL_HOME || path.join(os.homedir(), '.sundial'), 'sundial.db');
if (!fs.existsSync(SOURCE)) {
  console.error(`no harness db at ${SOURCE} — nothing to smoke against`);
  process.exit(1);
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-tools-smoke-'));
const dbPath = path.join(scratch, 'sundial.db');
fs.copyFileSync(SOURCE, dbPath);
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(`${SOURCE}${suffix}`)) fs.copyFileSync(`${SOURCE}${suffix}`, `${dbPath}${suffix}`);
}
process.env.DATABASE_URL = `file:${dbPath}`;
console.log(`scratch copy: ${dbPath}`);

// Imported AFTER DATABASE_URL is pinned — getDb() is first-call-wins.
const { getDb } = await import('@sundial/db/index.js');
const gnomonDbQueries = await import('@sundial/db/index.js');
const gnomonMemory = await import('@sundial/memory/index.js');
const { assertSupportedJsonSchema, validateArgs } = await import('@deepseek-ai/dsh-tools');
const { ASK_TOOL_REGISTRY } = await import('@sundial/kernel/tools/index.js');
const { toolDefinitions } = await import('@sundial/kernel/tools/registry.js');
const { apply, toDshTool, toParameterSchemaSpec } = await import('../index.js');

const db = getDb(`file:${dbPath}`);

// ── 2. fake ctx: the three services + registry/listener sinks ──
const registered = [];
const listeners = [];
const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  on: (event, listener) => listeners.push([event, listener]),
  gnomonKernel: {
    // No live kernel in this process; the snapshot-reading tools go to the db.
    getState: () => null,
    appendSignal: async (type, payload) => console.log(`  (appendSignal ${type} ${JSON.stringify(payload)})`),
  },
  gnomonDb: { db, dbPath, queries: gnomonDbQueries },
  gnomonMemory,
};
apply(ctx);
console.log(`apply(): registered ${registered.length} tools, ${listeners.length} listener(s) [${listeners.map(([e]) => e).join(', ')}]`);

// ── 3. all 13 through the converter + dsh's own validators ──
const VALID_ARGS = {
  gnomon_moment_detail: { momentId: 'smoke' },
  gnomon_project_status: { projectId: '/tmp/smoke' },
  gnomon_entity_history: { name: 'smoke' },
  gnomon_semantic_search: { query: 'smoke' },
  gnomon_compose_figure: { kind: 'census' },
};
let failures = 0;
for (const tool of ASK_TOOL_REGISTRY) {
  try {
    const definition = toDshTool(tool);
    assertSupportedJsonSchema(definition.parameters);
    assertSupportedJsonSchema(definition.output.schema);
    const spec = toParameterSchemaSpec(toolDefinitions([tool])[0].parameters);
    const violations = validateArgs(spec, VALID_ARGS[tool.name] ?? {});
    if (violations.length > 0) throw new Error(`validateArgs: ${violations.join('; ')}`);
    console.log(`ok   ${tool.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${tool.name}: ${error.message}`);
  }
}

// ── 4. execute the two context tools against the real record ──
function rowish(value) {
  const text = JSON.stringify(value, null, 1);
  return text.length > 1200 ? `${text.slice(0, 1200)}\n … (${text.length} chars total)` : text;
}
const byName = new Map(registered.map((definition) => [definition.name, definition]));

console.log('\n== gnomon_current_context ==');
console.log(rowish(await byName.get('gnomon_current_context').execute({}, undefined)));

console.log('\n== gnomon_today_summary ==');
const today = await byName.get('gnomon_today_summary').execute({}, undefined);
console.log(`${today.length} moment(s) today`);
for (const moment of today.slice(0, 8)) {
  console.log(`  ${moment.startTime}  ${String(moment.processName).padEnd(20)} ${Math.round(moment.durationMs / 60000)}m`);
}

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
