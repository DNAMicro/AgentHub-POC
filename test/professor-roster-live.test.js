// Part 17 roster questions (owner, 2026-11-05), live mode against the scripted fake Anthropic API (never a real key, never
// the network). Plumbing only: proves what the model is SHOWN (the question and the allowed values, never a row, name,
// email or ID) and what code does with its query (an invalid field or value drops it) — not how a real model reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';

const stub = await startFakeAnthropic();
process.env.PROFESSOR_MODE = 'live';
process.env.ANTHROPIC_API_KEY = `sk-ant-test-${randomUUID()}`;
process.env.ANTHROPIC_BASE_URL = stub.url;
process.env.TUTOR_LOAD_DOTENV = '0';
const { readRosterQuery } = await import('../src/professor-model.js');
const { createRosterDesk, ROSTER_UNCLEAR_TEXT, ROSTER_QUERY_FAILED_TEXT } = await import('../src/professor-roster.js');
const { createStudentRecordsStore } = await import('../src/student-records-store.js');

test.after(() => stub.close());
const ROWS = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster.rows;
const link = { sendSigned: async () => ({ status: 'ok', reply: { roster: { class: { code: 'MKTG 351 - 01' }, rows: ROWS } } }) };
const desk = () => createRosterDesk({ hubLink: link, conversationId: () => 'c', readQuery: readRosterQuery });
const ask = (d, question) => d.question({ operationId: `op-${randomUUID()}`, hub: null, question });
const scripted = (query) => stub.respondWith((body) => (body?.output_config?.format?.schema?.properties?.filters ? messageReply(JSON.stringify(query)) : messageReply('{}')));

test('the model sees the question and the allowed values only — no name, email, ID or row; its query is run by code', async () => {
  stub.reset();
  scripted({ kind: 'list', filters: [{ field: 'plan', op: 'not_contains', value: 'Business' }], match: 'all' });
  const d = desk();
  const r = await ask(d, 'anyone not a business major?');
  const notBusiness = ROWS.filter((x) => !/Business/.test(x.plan)).map((x) => x.studentId).sort();
  assert.equal(r.reply, `Yes — ${notBusiness.length} of your 25 students aren't Business majors; they're highlighted on your roster below.`);
  assert.deepEqual(d.view(null, null).highlight.slice().sort(), notBusiness);
  assert.equal(stub.requests.length, 1, 'one model call');
  const body = JSON.stringify(stub.requests[0].body);
  assert.ok(body.includes('anyone not a business major?'), 'the question');
  for (const v of ['Business Admin - Marketing', 'Communications - Advertising', 'Junior', '3.00']) assert.ok(body.includes(v), `allowed value ${v}`);
  // Review #5: no pronouns at all — neither a value nor a field.
  for (const v of ['they/them', 'she/her', 'he/him', '"pronouns"']) assert.ok(!body.includes(v), `never ${v}`);
  for (const row of ROWS) {
    const [last, first] = row.name.split(',');
    for (const secret of [row.email, row.id, row.studentId, row.name, `${first} ${last}`]) assert.ok(!body.includes(secret), `never ${secret}`);
  }
  assert.equal(stub.requests[0].body.output_config.format.schema.properties.filters.items.properties.field.enum.join(','), 'level,plan,program,units,name');
});

test('an invalid field or value from the model drops the query: the couldn\'t-tell sentence, no card', async () => {
  for (const query of [
    { kind: 'list', filters: [{ field: 'email', op: 'contains', value: 'csu' }], match: 'all' },
    { kind: 'list', filters: [{ field: 'plan', op: 'contains', value: 'Underwater Basket Weaving' }], match: 'all' },
    { kind: 'count', filters: [{ field: 'level', op: 'is', value: 'Senior' }, { field: 'units', op: 'gt', value: 'lots' }], match: 'all' },
    { kind: 'none', filters: [], match: 'all' },
  ]) {
    stub.reset();
    scripted(query);
    const d = desk();
    const r = await ask(d, 'anyone not a business major?');
    assert.equal(r.reply, ROSTER_UNCLEAR_TEXT, JSON.stringify(query));
    assert.equal(d.state(), null);
  }
});

test('a failed model call says nothing was sent (no retry, one request)', async () => {
  stub.reset();
  stub.respondWith(() => ({ status: 500 }));
  const r = await ask(desk(), 'anyone not a business major?');
  assert.equal(r.reply, ROSTER_QUERY_FAILED_TEXT);
  assert.equal(stub.requests.length, 1);
});
