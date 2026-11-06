// Second video review, group B: roster data minimisation (#5), honest count answers (#6) and the roster-read audit
// purpose (#7). Code-only checks (no model; the records stand-in runs in its labelled mock mode).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  PRIVATE_FIELD_TEXT, ROSTER_QUERY_FIELDS, checkRosterQuery, createRosterDesk, criterionCountText, criterionListText, criterionText,
  criterionYesNoText, privateFieldAsked, rosterAllowedValues, rosterFact, rosterFilter,
} from '../src/professor-roster.js';
import { mockRosterQuery, ROSTER_QUERY_SYSTEM } from '../src/professor-model.js';
import { maskId, maskPrivateFields } from '../src/student-records-mcp.js';
import { minimalRoster } from '../src/chrs-agent.js';
import { createStudentRecordsStore } from '../src/student-records-store.js';
import { signRosterLookup, signStaff, verifyRosterLookupSignature, verifyStaffSignature } from '../src/hub-link.js';
import { LOOKUP_ROSTER_PURPOSES, ROSTER_PURPOSES, STAFF_ROSTER_PURPOSES, staffRequestFields } from '../src/staff.js';
import { topologyLabel as labelEvent } from '../src/topology.js';
import { startStudentRecords } from './support/harness.js';

const FULL = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster;
const ROWS = FULL.rows;
const MIN = minimalRoster(maskPrivateFields(FULL));
const ALLOWED = rosterAllowedValues(MIN.rows);
const SECRET = /csu\.fullerton\.example|888\d{6}|pronouns|they\/them|she\/her|he\/him/;

// ---- #5: data minimisation -----------------------------------------------------------------------------------------------
test('#5 maskId keeps the last 4 digits only; anything without 4 digits shows nothing', () => {
  assert.equal(maskId('888997694'), '•••••7694');
  assert.equal(maskId(888329571), '•••••9571');
  assert.equal(maskId('888-32-9571'), '•••••9571');
  assert.equal(maskId('123'), '');
  assert.equal(maskId(''), '');
  assert.equal(maskId(undefined), '');
  assert.equal(maskId('abcd'), '');
});

test('#5 the records server masks at the source: no pronouns, IDs masked, the email only when asked for', () => {
  const plain = maskPrivateFields(FULL);
  assert.equal(plain.rows.length, 25);
  assert.equal(plain.class.code, FULL.class.code);
  for (const r of plain.rows) {
    assert.equal(r.email, undefined);
    assert.equal(r.pronouns, undefined);
    assert.equal(r.id, undefined);
    assert.match(r.maskedId, /^•{5}\d{4}$/);
  }
  assert.ok(!SECRET.test(JSON.stringify(plain)), 'nothing private');
  const withEmail = maskPrivateFields(FULL, { includeEmail: true });
  assert.ok(withEmail.rows.every((r) => /@csu\.fullerton\.example$/.test(r.email) && r.pronouns === undefined && r.id === undefined));
  assert.equal(FULL.rows[0].pronouns !== undefined, true, 'the store itself is untouched');
});

test('#5 the Campus Agent whitelists what leaves it, whatever the records server sent', () => {
  const leaky = { class: FULL.class, rows: ROWS.map((r) => ({ ...r, ssn: '123-45-6789', notes: 'x' })) }; // a full, unmasked row
  const out = minimalRoster(leaky);
  assert.equal(out.rows.length, 25);
  for (const r of out.rows) assert.deepEqual(Object.keys(r).sort(), ['degree', 'level', 'maskedId', 'name', 'plan', 'program', 'studentId', 'units']);
  assert.equal(out.rows.find((r) => r.studentId === 'student-alex').maskedId, '•••••9571', 'masked from the full id');
  assert.ok(!SECRET.test(JSON.stringify(out)) && !/123-45-6789/.test(JSON.stringify(out)));
  // A maskedId that isn't a mask (a full ID smuggled in that field) is re-masked from the id, or dropped.
  const smuggled = minimalRoster({ class: {}, rows: [{ studentId: 's', maskedId: '888997694', id: '888997694' }, { studentId: 't', maskedId: 'alex@x' }] });
  assert.deepEqual(smuggled.rows.map((r) => r.maskedId), ['•••••7694', '']);
});

test('#5 over MCP: get_class_roster returns masked rows; includeEmail adds only the email', async (t) => {
  const token = `tok-${randomUUID()}`;
  const sr = await startStudentRecords({ STUDENT_RECORDS_TOKEN: token, STUDENT_RECORDS_MODE: 'mock' });
  t.after(() => sr.proc.kill());
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${sr.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const args = { courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' };
  const plain = (await client.callTool({ name: 'get_class_roster', arguments: args })).structuredContent.roster;
  assert.equal(plain.rows.length, 25);
  assert.ok(!SECRET.test(JSON.stringify(plain)), 'no email, full ID or pronouns by default');
  assert.ok(plain.rows.every((r) => /^•{5}\d{4}$/.test(r.maskedId)));
  const mail = (await client.callTool({ name: 'get_class_roster', arguments: { ...args, includeEmail: true } })).structuredContent.roster;
  assert.ok(mail.rows.every((r) => r.email && r.pronouns === undefined && r.id === undefined));
  const bad = await client.callTool({ name: 'get_class_roster', arguments: { ...args, includeEmail: 'yes' } });
  assert.equal(bad.isError, true, 'includeEmail is a boolean only');
});

test('#5 questions about a field that is not shown get one honest sentence — and no roster read', async () => {
  const cases = [
    ["what is Mariana Aguilar's email?", 'email'], ["what's the email address of Sam Student?", 'email'], ["Lily Chen's e-mail", 'email'],
    ["what is Diego Castillo's student ID?", 'id'], ["what's Omar's CWID?", 'id'], ['what is the student number of Kevin Huang', 'id'],
    ["what are Jordan Davis's pronouns?", 'pronouns'], ['what are the pronouns of Lily Chen?', 'pronouns'],
  ];
  const desk = createRosterDesk({ hubLink: { sendSigned: async () => { throw new Error('no roster read for a private field'); } }, conversationId: () => 'c' });
  for (const [text, field] of cases) {
    const f = rosterFact(text);
    assert.deepEqual([f?.kind, f?.field], ['detail', field], text);
    const r = await desk.fact({ operationId: `op-${randomUUID()}`, hub: null, fact: f });
    assert.equal(r.reply, PRIVATE_FIELD_TEXT[field], text);
    assert.equal(r.action, 'roster_fact');
  }
  assert.equal(desk.state(), null, 'no card');
  assert.match(PRIVATE_FIELD_TEXT.email, /^Student emails aren't shown here, to keep student records private\. Notices you send reach every student, by email if they aren't online\.$/);
});

test('#5 privateFieldAsked: pronoun / email / ID questions, never ordinary roster questions', async () => {
  for (const [t, f] of [['who uses they/them pronouns?', 'pronouns'], ['which students use she / her?', 'pronouns'], ['list the emails of my seniors', 'email'], ['what are my students\' email addresses?', 'email'], ['show the student IDs of my juniors', 'id'], ['which CWIDs start with 8885?', 'id'], ['what is the ID of the student who is a senior?', 'id']]) assert.equal(privateFieldAsked(t), f, t);
  for (const t of ['who are my seniors?', 'how many marketing majors do I have?', 'anyone not a business major?', 'does anyone take fewer than 12 units?', 'is there anyone in my class majoring in finance?', 'which students are identified as juniors?']) assert.equal(privateFieldAsked(t), null, t);
  const desk = createRosterDesk({ hubLink: { sendSigned: async () => { throw new Error('no read'); } }, conversationId: () => 'c', readQuery: async () => { throw new Error('no model'); } });
  const events = [];
  const r = await desk.question({ operationId: 'op-p', hub: null, question: 'who uses they/them pronouns?', emitRun: (type, data) => events.push([type, data]) });
  assert.equal(r.reply, PRIVATE_FIELD_TEXT.pronouns);
  assert.deepEqual(events, [['roster_query', { status: 'private_field' }]]);
});

test('#5 the roster query has no pronouns field: not in the fields, the allowed values, the mock, the prompt schema or the checker', () => {
  assert.deepEqual(ROSTER_QUERY_FIELDS, ['level', 'plan', 'program', 'units', 'name']);
  assert.deepEqual(Object.keys(rosterAllowedValues(ROWS)).sort(), ['level', 'plan', 'program', 'units'], 'even from full rows');
  assert.equal(checkRosterQuery({ kind: 'list', filters: [{ field: 'pronouns', op: 'is', value: 'they/them' }], match: 'all' }, { ...ALLOWED, pronouns: ['they/them'] }, 'who uses they/them?'), null);
  assert.equal(checkRosterQuery({ kind: 'list', filters: [{ field: 'email', op: 'contains', value: 'csu' }], match: 'all' }, ALLOWED, 'q'), null);
  for (const q of ['who uses they/them pronouns?', 'anyone with she/her pronouns who is a senior?']) assert.ok(!mockRosterQuery(q, { ...ALLOWED, pronouns: ['they/them', 'she/her'] }).filters.some((f) => f.field === 'pronouns'), q);
  assert.match(ROSTER_QUERY_SYSTEM, /no pronouns, email or ID field/);
});

test('#5 the roster card shows Name, masked ID, Academic Level, Program and Plan, Units — no Email, no Pronouns; the new footer', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { document } = dom.window;
  const g = globalThis;
  const saved = { document: g.document };
  g.document = document;
  after(() => { g.document = saved.document; });
  const { createRosterUi, FOOTER, ROSTER_COLUMNS } = await import('../public/roster-ui.js');
  const el = (tag, props = {}, ...children) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'dataset') Object.assign(n.dataset, v); else n[k] = v; } n.append(...children.filter((c) => c !== null && c !== undefined)); return n; };
  const bubble = () => el('li', {}, el('p', { className: 'msg-text' }));
  // The page receives a leaky row too (email, pronouns, a full id in maskedId): none of it is drawn.
  const rows = [...MIN.rows, { studentId: 'student-x', name: 'Leak,Lee', maskedId: '888000111', email: 'lee@csu.fullerton.example', pronouns: 'they/them', level: 'Senior' }];
  const view = { rosterId: 'ro-1', at: 'now', roster: { class: FULL.class, rows }, online: [], highlight: [] };
  const ui = createRosterUi({ el, api: async () => ({ ok: true, json: view }), bubble, isShowing: () => true });
  const li = ui.entry({ id: 'e1', at: 'now', roster: { rosterId: 'ro-1', count: 26 } });
  await new Promise((r) => setTimeout(r, 20));
  const heads = [...li.querySelectorAll('table.roster thead th')].map((th) => th.textContent);
  assert.deepEqual(heads, ['', 'Name', 'ID', 'Academic Level', 'Program and Plan', 'Units']);
  assert.deepEqual(ROSTER_COLUMNS, heads);
  const first = [...li.querySelectorAll('table.roster tbody tr')[0].children].map((td) => td.textContent);
  assert.deepEqual(first.slice(0, 4), ['1', 'Aguilar,Mariana', '•••••7694', 'Junior']);
  assert.equal(first[5], '3.00');
  const text = li.textContent;
  assert.ok(!SECRET.test(text) && !text.includes('888000111'), 'nothing private on the card');
  assert.equal(li.querySelector('.roster-foot').textContent, 'Fictional demo records. Only what you need is shown; IDs are masked. Every roster lookup is logged. Student records are private (FERPA).');
  assert.equal(FOOTER, li.querySelector('.roster-foot').textContent);
});

// ---- #6: honest count answers ---------------------------------------------------------------------------------------------
const Q = (filters, match = 'all') => ({ kind: 'count', match, filters, allowed: ALLOWED });
const LEVEL = (v, op = 'is') => ({ field: 'level', op, value: v });
const PLAN = (v, op = 'contains') => ({ field: 'plan', op, value: v });
test('#6 count answers restate what was counted (singular and plural)', () => {
  assert.equal(criterionCountText(Q([LEVEL('Senior')]), 16, 25), '16 of your 25 students are seniors.');
  assert.equal(criterionCountText(Q([LEVEL('Senior')]), 1, 25), '1 of your 25 students is a senior.');
  assert.equal(criterionCountText(Q([PLAN('marketing')]), 3, 25), '3 of your 25 students are Marketing majors.', 'spelled as the roster spells it');
  assert.equal(criterionCountText(Q([PLAN('Business', 'not_contains')]), 2, 25), "2 of your 25 students aren't Business majors.");
  assert.equal(criterionCountText(Q([PLAN('Accounting')]), 1, 25), '1 of your 25 students is an Accounting major.');
  assert.equal(criterionCountText(Q([LEVEL('Senior'), PLAN('Marketing')]), 4, 25), '4 of your 25 students are seniors and Marketing majors.');
  assert.equal(criterionCountText(Q([{ field: 'units', op: 'lt', value: 12 }]), 5, 25), '5 of your 25 students have fewer than 12 units.');
  assert.equal(criterionCountText(Q([{ field: 'units', op: 'gt', value: 2.5 }]), 25, 25), '25 of your 25 students have more than 2.5 units.');
  assert.equal(criterionCountText(Q([{ field: 'units', op: 'eq', value: 1 }]), 1, 25), '1 of your 25 students has exactly 1 unit.');
  assert.equal(criterionCountText(Q([LEVEL('Junior'), LEVEL('Senior')], 'any'), 20, 25), '20 of your 25 students are juniors or seniors.');
  assert.equal(criterionCountText(Q([LEVEL('Junior', 'is_not'), LEVEL('Senior', 'is_not')]), 2, 25), "2 of your 25 students aren't juniors or seniors.");
  assert.equal(criterionCountText(Q([LEVEL('Senior'), { field: 'units', op: 'lt', value: 12 }]), 3, 25), '3 of your 25 students are seniors and have fewer than 12 units.');
});

test('#6 zero answers: positive criteria in words; a negative one says the criterion (never a double negative)', () => {
  assert.equal(criterionCountText(Q([LEVEL('Senior')]), 0, 25), 'None of your 25 students are seniors.');
  assert.equal(criterionCountText(Q([LEVEL('Freshman')]), 0, 25), 'None of your 25 students are freshmen.');
  assert.equal(criterionCountText(Q([PLAN('Business', 'not_contains')]), 0, 25), "None of your 25 students match: Plan doesn't contain “Business”.");
  assert.equal(criterionYesNoText(Q([PLAN('Finance')]), 0, 25), 'No — none of your 25 students are Finance majors.');
  assert.equal(criterionListText(Q([{ field: 'units', op: 'lt', value: 3 }]), 0, 25), 'None of your 25 students have fewer than 3 units.');
});

test('#6 list and yes/no forms: the group noun when there is one, else the sentence; rows are highlighted', () => {
  assert.equal(criterionListText(Q([LEVEL('Senior')]), 16, 25), '16 seniors are highlighted on your roster below.');
  assert.equal(criterionListText(Q([LEVEL('Senior')]), 1, 25), '1 senior is highlighted on your roster below.');
  assert.equal(criterionListText(Q([PLAN('Marketing')]), 3, 25), '3 Marketing majors are highlighted on your roster below.');
  assert.equal(criterionListText(Q([LEVEL('Senior'), PLAN('Marketing')]), 4, 25), '4 seniors majoring in Marketing are highlighted on your roster below.');
  assert.equal(criterionListText(Q([PLAN('Business', 'not_contains')]), 4, 25), "4 of your 25 students aren't Business majors — they're highlighted on your roster below.");
  assert.equal(criterionYesNoText(Q([PLAN('Marketing')]), 3, 25), "Yes — 3 of your 25 students are Marketing majors; they're highlighted on your roster below.");
  assert.equal(criterionYesNoText(Q([LEVEL('Senior')]), 1, 25), "Yes — 1 of your 25 students is a senior; they're highlighted on your roster below.");
});

test('#6 what has no clean phrase falls back to the criterion code built (field, op, value) — never model words', () => {
  const program = Q([{ field: 'program', op: 'is', value: 'undergraduate program' }]);
  assert.equal(criterionText(program), 'Program is “Undergraduate Program”', 'the roster’s own spelling');
  assert.equal(criterionCountText(program, 25, 25), '25 of your 25 students match: Program is “Undergraduate Program”.');
  assert.equal(criterionCountText(program, 1, 25), '1 of your 25 students matches: Program is “Undergraduate Program”.');
  const name = Q([{ field: 'name', op: 'contains', value: 'chen' }]);
  assert.equal(criterionYesNoText(name, 1, 25), "Yes — 1 of your 25 students matches: Name contains “Chen”; they're highlighted on your roster below.");
  const anyNeg = Q([LEVEL('Junior', 'is_not'), PLAN('Marketing', 'not_contains')], 'any');
  assert.equal(criterionCountText(anyNeg, 22, 25), "22 of your 25 students match: Academic Level is not “Junior” or Plan doesn't contain “Marketing”.");
  const four = Q([LEVEL('Senior'), PLAN('Marketing'), PLAN('Admin'), { field: 'units', op: 'lt', value: 4 }]);
  assert.match(criterionCountText(four, 2, 25), /^2 of your 25 students match: Academic Level is “Senior” and Plan contains “Marketing” and Plan contains “Admin” and Units is less than 4\.$/);
  const unknownLevel = Q([LEVEL('Graduate')]);
  assert.equal(criterionCountText(unknownLevel, 0, 25), 'None of your 25 students match: Academic Level is “Graduate”.');
});

test('#6 one describer for both paths: the level / major filter and a roster question give the same sentence', async () => {
  const link = { sendSigned: async () => ({ status: 'ok', reply: { roster: MIN } }) };
  const fromQuestion = (q) => createRosterDesk({ hubLink: link, conversationId: () => 'c', readQuery: async () => q });
  const seniors = ROWS.filter((r) => r.level === 'Senior').length;
  const viaFilter = await createRosterDesk({ hubLink: link, conversationId: () => 'c' }).filter({ operationId: 'op-1', hub: null, filter: rosterFilter('how many seniors are in my class?') });
  const viaQuery = await fromQuestion({ kind: 'count', filters: [LEVEL('Senior')], match: 'all' }).question({ operationId: 'op-2', hub: null, question: 'count the seniors' });
  assert.equal(viaFilter.reply, `${seniors} of your 25 students are seniors.`);
  assert.equal(viaQuery.reply, viaFilter.reply);
  const mkt = ROWS.filter((r) => /Marketing/.test(r.plan)).length;
  const listF = await createRosterDesk({ hubLink: link, conversationId: () => 'c' }).filter({ operationId: 'op-3', hub: null, filter: rosterFilter('which students are marketing majors?') });
  assert.equal(listF.reply, `${mkt} Marketing majors are highlighted on your roster below.`);
  const d = fromQuestion({ kind: 'list', filters: [PLAN('marketing')], match: 'all' });
  const listQ = await d.question({ operationId: 'op-4', hub: null, question: 'list the marketing majors' });
  assert.equal(listQ.reply, listF.reply);
  assert.equal(d.view(null, null).highlight.length, mkt, 'the matching rows are highlighted so the count can be checked');
  const both = await createRosterDesk({ hubLink: link, conversationId: () => 'c' }).filter({ operationId: 'op-5', hub: null, filter: rosterFilter('how many seniors majoring in marketing do I have?') });
  const n = ROWS.filter((r) => r.level === 'Senior' && /Marketing/.test(r.plan)).length;
  assert.equal(both.reply, `${n} of your 25 students are seniors and Marketing majors.`);
});

// ---- #7: the signed purpose -------------------------------------------------------------------------------------------
const KEY = 'k'.repeat(43);
test('#7 the purpose set is fixed; lookups and staff reads split it; the staff request signs it when present', () => {
  assert.deepEqual(ROSTER_PURPOSES, ['view', 'fact', 'question', 'tag', 'class_info', 'membership', 'recipients', 'email']);
  assert.ok([...STAFF_ROSTER_PURPOSES, ...LOOKUP_ROSTER_PURPOSES].every((p) => ROSTER_PURPOSES.includes(p)));
  assert.ok(!STAFF_ROSTER_PURPOSES.includes('recipients') && !LOOKUP_ROSTER_PURPOSES.includes('view'));
  const v = { operationId: 'op', conversationId: 'c' };
  assert.deepEqual(staffRequestFields(v), ['staff-request', 'op', 'c'], 'HR: unchanged');
  assert.deepEqual(staffRequestFields({ ...v, service: 'chrs' }), ['staff-request', 'op', 'c', 'chrs'], 'an older roster request: unchanged');
  assert.deepEqual(staffRequestFields({ ...v, service: 'chrs', purpose: 'fact' }), ['staff-request', 'op', 'c', 'chrs', 'purpose:fact']);
});

test('#7 the staff signature covers the purpose: tampering, a missing one or an unknown one never verifies', () => {
  const ids = { staffId: 'staff-dabirian', contextId: 'ctx', operationId: 'op' };
  const meta = (purpose) => ({ staffId: ids.staffId, hubOperationId: ids.operationId, callerKind: 'staff', hubSignature: signStaff(KEY, { ...ids, purpose }) });
  assert.equal(verifyStaffSignature(KEY, meta('view'), 'ctx', 'view'), 'staff-dabirian');
  assert.equal(verifyStaffSignature(KEY, meta('view'), 'ctx', 'fact'), null, 'signed view, sent fact');
  assert.equal(verifyStaffSignature(KEY, meta(undefined), 'ctx', 'view'), null, 'signed without a purpose');
  assert.equal(verifyStaffSignature(KEY, meta('recipients'), 'ctx', 'recipients'), null, 'not a staff purpose');
  assert.equal(verifyStaffSignature(KEY, meta(undefined), 'ctx'), 'staff-dabirian', 'HR: unchanged');
  assert.equal(signStaff(KEY, ids), signStaff(KEY, { ...ids, purpose: undefined }), 'no purpose = the old signature');
  assert.notEqual(signStaff(KEY, ids), signStaff(KEY, { ...ids, purpose: 'view' }));
});

test('#7 the Hub-signed lookup requires a lookup purpose and covers it', () => {
  const base = { courseId: 'mkt-351', instructorStaffId: 'staff-dabirian', operationId: 'op-1' };
  for (const p of LOOKUP_ROSTER_PURPOSES) {
    const sig = signRosterLookup(KEY, { ...base, purpose: p });
    assert.deepEqual(verifyRosterLookupSignature(KEY, { courseId: base.courseId, instructorStaffId: base.instructorStaffId, purpose: p }, { hubOperationId: 'op-1', hubSignature: sig }), { courseId: 'mkt-351', instructorStaffId: 'staff-dabirian', purpose: p });
  }
  for (const p of [undefined, 'view', 'email', 'Recipients', '']) assert.equal(signRosterLookup(KEY, { ...base, purpose: p }), null, String(p));
  const sig = signRosterLookup(KEY, { ...base, purpose: 'recipients' });
  assert.equal(verifyRosterLookupSignature(KEY, { courseId: base.courseId, instructorStaffId: base.instructorStaffId, purpose: 'tag' }, { hubOperationId: 'op-1', hubSignature: sig }), null);
});

test('#7 each desk method asks with its own purpose (code chooses it); an unknown one falls back to view', async () => {
  const sent = [];
  const link = { sendSigned: async (type, value, fields) => { sent.push({ purpose: value.purpose, fields }); return { status: 'ok', reply: { roster: MIN } }; } };
  const desk = createRosterDesk({ hubLink: link, conversationId: () => 'c', readQuery: async () => ({ kind: 'count', filters: [LEVEL('Senior')], match: 'all' }) });
  await desk.request({ operationId: 'o1', hub: null });
  await desk.exportAsk({ operationId: 'o2', hub: null });
  await desk.fact({ operationId: 'o3', hub: null, fact: { kind: 'count' } });
  await desk.filter({ operationId: 'o4', hub: null, filter: rosterFilter('who are my seniors?') });
  await desk.question({ operationId: 'o5', hub: null, question: 'how many seniors?' });
  await desk.names({ operationId: 'o6', fresh: true });
  await desk.names({ operationId: 'o7', fresh: true, purpose: 'membership' });
  await desk.classRecord({ operationId: 'o8' });
  await desk.names({ operationId: 'o9', fresh: true, purpose: 'recipients' }); // not a staff purpose: read as view
  assert.deepEqual(sent.map((x) => x.purpose), ['view', 'view', 'fact', 'question', 'question', 'tag', 'membership', 'class_info', 'view']);
  for (const x of sent) assert.equal(x.fields.at(-1), `purpose:${x.purpose}`, 'signed');
});

test('#7 Topology / Agent activity label: purpose and a row count only', () => {
  const ev = (data) => labelEvent({ source: 'chrs', type: 'roster_read_logged', runId: null, at: new Date().toISOString(), data });
  const label = (data) => JSON.stringify(ev(data));
  assert.match(label({ purpose: 'recipients', rowCount: 25, courseId: 'mkt-351' }), /Roster read logged · recipients · 25 rows/);
  assert.match(label({ purpose: 'class_info', rowCount: 1, courseId: 'mkt-351' }), /Roster read logged · class info · 1 row/);
  assert.doesNotMatch(label({ purpose: 'view', rowCount: 25 }), /CHRS/);
});
