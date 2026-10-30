// Part 8: the component catalog the Library's model composes from, and the validation every generated
// surface must pass before it is sent.
//
// Responsibilities stay separate:
//   catalog   — what can be displayed: the OFFICIAL A2UI v0.9 basic catalog that the installed renderer
//               (@a2ui/lit 0.14.0) registers, minus components/functions that load or open URLs.
//               Built from the shipped JSON Schemas, so it can't drift from the renderer's.
//   contracts — what the application can do (src/forms.js WORKFLOWS['loan-renewal'].actions).
//   model     — what interface is useful, and how to compose it (src/loan-model.js).
//   renderer  — displays the composition (browser).
//   backend   — permissions, policy and execution (src/loan-store.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { A2UI_VERSION, BASIC_CATALOG_ID, GENERATED_COMPONENTS, GENERATED_FUNCTIONS, WORKFLOWS, addDays, checkFormPayloadPolicy } from './forms.js';

const dir = fileURLToPath(new URL('../node_modules/@a2ui/web_core/src/v0_9/schemas/', import.meta.url));
const load = (name) => JSON.parse(readFileSync(dir + name, 'utf8'));
const basic = load('catalogs/basic/catalog.json');
const RENDERER = '@a2ui/lit 0.14.0 (A2UI v0.9 basic catalog)';
export const EXCLUDED = {
  Image: 'loads a URL', Video: 'loads a URL', AudioPlayer: 'loads a URL', openUrl: 'opens a URL',
};

// ---- the official JSON Schemas (same setup as the protocol tests) -----------------------------
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, logger: false });
const realDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const TIME = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(z|[+-]\d\d(:?\d\d)?)?$/i;
ajv.addFormat('date', realDate);
ajv.addFormat('time', TIME);
ajv.addFormat('date-time', (s) => { const [d, t] = String(s).split(/t|\s/i); return realDate(d) && TIME.test(t ?? ''); });
ajv.addFormat('uri', true);
ajv.addSchema(load('common_types.json'));
ajv.addSchema(basic);
ajv.addSchema({ ...basic, $id: 'https://a2ui.org/specification/v0_9/catalog.json' }); // the generic catalog slot → basic
ajv.addSchema(load('server_to_client.json'));
ajv.addSchema(load('client_to_server.json'), 'https://a2ui.org/specification/v0_9/client_to_server.json');
const serverList = ajv.compile(load('server_to_client_list.json'));
const clientList = ajv.compile(load('client_to_server_list.json'));
export const validateServerToClientList = (messages) => (serverList(messages) ? null : serverList.errors);
export const validateClientToServerList = (messages) => (clientList(messages) ? null : clientList.errors);

// ---- the model-visible catalog ------------------------------------------------------------------
const refName = (ref) => ref.split('/').pop();
function typeOf(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((e) => JSON.stringify(e)).join(' | ');
  if (schema.allOf) return typeOf(schema.allOf.find((s) => s.$ref) ?? schema.allOf[0]);
  if (schema.oneOf) return schema.oneOf.map(typeOf).join(' | ');
  if (schema.type === 'array') return `Array<${typeOf(schema.items)}>`;
  if (schema.type === 'object' && schema.properties) return `{ ${Object.entries(schema.properties).map(([k, v]) => `${k}${schema.required?.includes(k) ? '' : '?'}: ${typeOf(v)}`).join(', ')} }`;
  return schema.type ?? 'any';
}
function describeComponent(name) {
  const own = basic.components[name].allOf.find((part) => part.properties?.component);
  const checkable = basic.components[name].allOf.some((part) => part.$ref?.endsWith('/Checkable'));
  const props = Object.entries(own.properties).filter(([k]) => k !== 'component').map(([k, v]) => ({
    name: k, type: typeOf(v), required: Boolean(own.required?.includes(k)), ...(v.default !== undefined ? { default: v.default } : {}), description: v.description ?? '',
  }));
  return { component: name, properties: props, ...(checkable ? { checks: 'optional Array<CheckRule>: validation shown on the control' } : {}) };
}
function describeFunction(name) {
  const fn = basic.functions.find?.((f) => f.properties?.call?.const === name) ?? basic.functions[name];
  return { call: name, description: fn?.description ?? '', args: typeOf(fn?.properties?.args), returns: fn?.properties?.returnType?.const ?? 'any' };
}

// Checked once at import: the generated sets must be real, rendered catalog entries.
const catalogNames = Object.keys(basic.components);
const catalogFunctions = (Array.isArray(basic.functions) ? basic.functions.map((f) => f.properties?.call?.const) : Object.keys(basic.functions));
for (const c of GENERATED_COMPONENTS) if (!catalogNames.includes(c)) throw new Error(`Generated component ${c} is not in the installed catalog.`);
for (const f of GENERATED_FUNCTIONS) if (!catalogFunctions.includes(f)) throw new Error(`Generated function ${f} is not in the installed catalog.`);

export const CATALOG_INFO = { catalogId: BASIC_CATALOG_ID, version: A2UI_VERSION, renderer: RENDERER, components: GENERATED_COMPONENTS, functions: GENERATED_FUNCTIONS, excluded: EXCLUDED };

// What the model gets: every allowed component with its real properties, the shared types, functions,
// composition rules and the action convention.
export function catalogForModel() {
  return {
    catalog: { id: BASIC_CATALOG_ID, a2uiVersion: A2UI_VERSION, renderer: RENDERER, notAvailable: EXCLUDED },
    sharedTypes: {
      ComponentId: 'string — unique id of a component in this surface',
      DynamicString: 'a literal string, OR { "path": "/json/pointer" } bound to the data model, OR a function call { "call", "args", "returnType": "string" }',
      DynamicNumber: 'a literal number, OR { "path" }, OR a function call returning a number',
      DynamicBoolean: 'a literal boolean, OR { "path" }, OR a function call returning a boolean',
      DynamicStringList: 'a literal array of strings, OR { "path" } to a string array in the data model',
      ChildList: 'an array of child component ids, OR { "componentId", "path" } to repeat a template for each item of a data-model list',
      Action: '{ "event": { "name": <operation>, "context": { <input>: literal or { "path" } } } } — server events only; local function actions are not allowed here',
      CheckRule: '{ "condition": DynamicBoolean, "message": string } — shown when the condition is false',
      AccessibilityAttributes: '{ "label"?: DynamicString, "description"?: DynamicString }',
      weight: 'optional number on a direct child of a Row or Column (flex-grow)',
    },
    composition: [
      'A surface is a flat array of components. Exactly one has id "root"; containers reference children by id. Every referenced id must exist.',
      'Bind inputs to the data model with { "path": "/form/<name>" }. Initial values go in the data model you return.',
      'A Button needs a "child" (usually a Text label) and an "action". Its action context binds the operation inputs: literals for facts you know (a loan id), paths for what the student chooses (a date).',
      'Text renders plain text — no Markdown. Use variant "h3"/"h4" for headings and "caption" for small print.',
      'Keep it compact: a heading, the facts that matter, the control(s) needed, and the action button(s).',
    ],
    components: GENERATED_COMPONENTS.map(describeComponent),
    functions: GENERATED_FUNCTIONS.map(describeFunction),
  };
}

// ---- validation of a generated surface ------------------------------------------------------------
const LIMITS = { bytes: 48 * 1024, components: 80, depth: 10, dataModelBytes: 16 * 1024 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const pad = (n) => String(n).padStart(2, '0');
// Calendar dates mentioned in text, as "MM-DD" (year-insensitive) — ISO dates, "Nov 14", "14 November".
export function datesIn(text) {
  const found = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.push(`${m[2]}-${m[3]}`);
  for (const m of s.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'))) found.push(`${pad(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1)}-${pad(m[2])}`);
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'gi'))) found.push(`${pad(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1)}-${pad(m[1])}`);
  // US month/day as people type it ("11/10", "11/10/2026") — not inside math ("x^1/2", "3/4x").
  for (const m of s.matchAll(/(?<![\w^.\/])(\d{1,2})\/(\d{1,2})(?:\/(?:\d{4}|\d{2}))?(?![\w\/])/g)) if (Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31) found.push(`${pad(m[1])}-${pad(m[2])}`);
  return found;
}
const md = (iso) => iso.slice(5);
// Every date the response may mention: from the backend, plus dates the student wrote themselves. Any
// day inside a loan's backend-computed renewal range counts too (e.g. "due date + two weeks"): the range
// is authoritative, and a chosen date is range-checked again at submission.
export function allowedDatesFrom({ loans, today, studentText = [] }) {
  const set = new Set([md(today)]);
  for (const l of loans) {
    for (const d of [l.dueDate, l.checkedOut, l.permittedReturnDates?.earliest, l.permittedReturnDates?.latest]) if (d) set.add(md(d));
    const r = l.permittedReturnDates;
    if (r) for (let d = r.earliest; d <= r.latest; d = addDays(d, 1)) set.add(md(d));
  }
  for (const t of studentText) for (const d of datesIn(t)) set.add(d);
  return set;
}
export const inventedDates = (text, allowed) => datesIn(text).filter((d) => !allowed.has(d));

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (k !== 'path' && k !== 'id' && k !== 'component' && k !== 'child' && k !== 'children') strings(v, out);
  return out;
}
const isPath = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.path === 'string' && Object.keys(v).length === 1;
const pointerGet = (obj, path) => path.split('/').filter(Boolean).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const childIds = (c) => [
  ...(Array.isArray(c.children) ? c.children : c.children?.componentId ? [c.children.componentId] : []),
  ...(typeof c.child === 'string' ? [c.child] : []),
  ...(Array.isArray(c.tabs) ? c.tabs.map((t) => t.child).filter(Boolean) : []),
  ...['trigger', 'content', 'entryPointChild', 'contentChild'].map((k) => c[k]).filter((v) => typeof v === 'string'),
];

// Wrap the model's components and data model into the A2UI messages for one surface.
export function wrapSurface(surfaceId, components, dataModel) {
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: BASIC_CATALOG_ID, sendDataModel: false } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: '/', value: dataModel } },
  ];
}

// Validate model output. loans: the borrower's authoritative loan views. Returns { ok, errors, renewable }
// where renewable maps each loan a renew button targets to the version it was generated against.
export function validateGeneratedUi({ components, dataModel, loans, allowedDates }) {
  const errors = [];
  const err = (m) => { if (errors.length < 20) errors.push(m); };
  if (!Array.isArray(components) || !components.length) return { ok: false, errors: ['components must be a non-empty array.'] };
  if (!dataModel || typeof dataModel !== 'object' || Array.isArray(dataModel)) return { ok: false, errors: ['data model must be a JSON object.'] };
  if (JSON.stringify(dataModel).length > LIMITS.dataModelBytes) err('The data model is too large.');
  if (components.length > LIMITS.components) err(`Too many components (${components.length}; max ${LIMITS.components}).`);

  // 1. The official protocol + catalog schemas.
  const messages = wrapSurface('generated-check', components, dataModel);
  if (JSON.stringify(messages).length > LIMITS.bytes) err('The surface is too large.');
  for (const e of validateServerToClientList(messages) ?? []) {
    if (e.keyword === 'if' || e.keyword === 'oneOf' && e.instancePath.includes('/components/')) continue; // reported more precisely below
    err(`Schema: ${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : e.params?.unevaluatedProperty ? ` (${e.params.unevaluatedProperty})` : ''}`);
  }
  // 2. Only the generated component/function sets; server-event actions only.
  const policy = checkFormPayloadPolicy(messages, { workflowId: 'loan-renewal' });
  if (policy) err(policy);

  // 3. Structure: unique ids, one root, references exist, bounded depth.
  const byId = new Map();
  for (const c of components) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string') { err('Every component needs a string id.'); continue; }
    if (byId.has(c.id)) err(`Duplicate component id "${c.id}".`);
    byId.set(c.id, c);
  }
  if (!byId.has('root')) err('One component must have id "root".');
  for (const c of byId.values()) for (const id of childIds(c)) if (!byId.has(id)) err(`"${c.id}" references missing component "${id}".`);
  const depth = (id, seen = new Set()) => {
    if (seen.has(id)) return Infinity;
    const c = byId.get(id);
    if (!c) return 0;
    const next = new Set(seen).add(id);
    return 1 + Math.max(0, ...childIds(c).map((k) => depth(k, next)));
  };
  const d = byId.has('root') ? depth('root') : 0;
  if (d === Infinity) err('Components reference each other in a cycle.');
  else if (d > LIMITS.depth) err(`Nesting is too deep (${d}; max ${LIMITS.depth}).`);

  // 4. Actions: registered operations, exact inputs, and the backend's facts.
  const contracts = WORKFLOWS['loan-renewal'].actions;
  const loanById = new Map(loans.map((l) => [l.loanId, l]));
  const actionPaths = new Set();
  const renewable = {};
  for (const c of byId.values()) {
    if (c.component !== 'Button') continue;
    const ev = c.action?.event;
    if (!ev) { err(`Button "${c.id}" must send a server event.`); continue; }
    const contract = contracts[ev.name];
    if (!contract) { err(`Button "${c.id}" calls "${ev.name}", which is not a registered operation (${Object.keys(contracts).join(', ')}).`); continue; }
    const ctx = ev.context ?? {};
    const keys = Object.keys(ctx);
    const missing = (contract.required ?? []).filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !contract.fields.includes(k));
    if (missing.length || extra.length) err(`Button "${c.id}" (${ev.name}) must send exactly: ${contract.fields.join(', ') || 'no inputs'}${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; unexpected ${extra.join(', ')}` : ''}.`);
    for (const v of Object.values(ctx)) if (isPath(v)) actionPaths.add(v.path);
    if (ev.name !== 'renewLoan') continue;
    const loan = typeof ctx.loanId === 'string' ? loanById.get(ctx.loanId) : null;
    if (typeof ctx.loanId !== 'string') { err(`Button "${c.id}": loanId must be the literal id of the loan it renews.`); continue; }
    if (!loan) { err(`Button "${c.id}": "${ctx.loanId}" is not one of this student's loans.`); continue; }
    if (!loan.eligible) { err(`Button "${c.id}": ${loan.loanId} is not eligible for renewal (${loan.eligibilityReason}) — explain that instead of offering a renew action.`); continue; }
    if (!isPath(ctx.returnDate)) { err(`Button "${c.id}": returnDate must be bound with { "path" } to a DateTimeInput.`); continue; }
    const picker = [...byId.values()].find((x) => x.component === 'DateTimeInput' && isPath(x.value) && x.value.path === ctx.returnDate.path);
    if (!picker) { err(`Button "${c.id}": returnDate path ${ctx.returnDate.path} must be the value of a DateTimeInput.`); continue; }
    if (picker.enableDate !== true || picker.enableTime === true) err(`DateTimeInput "${picker.id}" must pick a date only (enableDate: true, no time).`);
    const literal = (v) => (isPath(v) ? pointerGet(dataModel, v.path) : v);
    const range = loan.permittedReturnDates;
    if (literal(picker.min) !== range.earliest || literal(picker.max) !== range.latest) err(`DateTimeInput "${picker.id}" must allow exactly the backend's permitted dates for ${loan.loanId}: min "${range.earliest}", max "${range.latest}".`);
    const initial = pointerGet(dataModel, ctx.returnDate.path);
    if (initial !== undefined && initial !== '' && (typeof initial !== 'string' || initial < range.earliest || initial > range.latest)) err(`Initial value at ${ctx.returnDate.path} must be empty or a permitted date.`);
    renewable[loan.loanId] = loan.version;
  }
  // 5. Facts are not editable, and precise values never come from a slider or free text.
  const dueDates = new Set(loans.map((l) => l.dueDate));
  for (const c of byId.values()) {
    if (!['TextField', 'Slider', 'CheckBox', 'ChoicePicker', 'DateTimeInput'].includes(c.component) || !isPath(c.value)) continue;
    if (c.value.path.startsWith('/library')) err(`${c.component} "${c.id}" edits authoritative library data at ${c.value.path}; show facts read-only.`);
    const initial = pointerGet(dataModel, c.value.path);
    if (typeof initial === 'string' && [...dueDates].some((d) => initial.startsWith(d))) err(`${c.component} "${c.id}" starts with a due date the backend owns (${initial}); show due dates as read-only text.`);
    if (c.component === 'DateTimeInput') continue;
    if (actionPaths.has(c.value.path) && c.component !== 'ChoicePicker') err(`${c.component} "${c.id}" supplies an operation input; use a DateTimeInput for a date and a literal for a loan id.`);
  }
  // 6. No dates the backend (or the student) didn't supply.
  const invented = [...new Set(strings({ components, dataModel }).flatMap((s) => inventedDates(s, allowedDates)))];
  if (invented.length) err(`These dates don't come from the loan data or the student: ${invented.join(', ')} (MM-DD). Use the authoritative dates.`);
  if (strings(components).some((s) => /\*\*|^#{1,6}\s/m.test(s))) err('Text renders plain text; remove Markdown (**, #).');
  return { ok: errors.length === 0, errors, renewable };
}
