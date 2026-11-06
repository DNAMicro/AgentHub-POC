// Owner, 2026-11-06: a student's questions about classmates are answered from the class list — names, count, year, major
// and campus email (“the student should be able to get the email as well and contact the students”); never an ID, phone,
// pronouns or grades. Code only (no model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSMATES_FAILED_TEXT, NOT_ENROLLED_TEXT, PRIVATE_DETAIL_TEXT, classmatesAnswer } from '../src/classmates.js';
import { createStudentRecordsStore } from '../src/student-records-store.js';
import { maskPrivateFields } from '../src/student-records-mcp.js';
import { classmatesRoster } from '../src/chrs-agent.js';

const ROWS = classmatesRoster(maskPrivateFields(createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster, { includeEmail: true })).rows;
const ask = (q, who = 'student-alex') => classmatesAnswer(q, ROWS, who);

test('who is in my class: every classmate with year, major and email; the asker is “you”, not listed', () => {
  for (const q of ['who is in my class', 'Who else is in my Marketing 351 class?', 'Can I get a list of my classmates?', 'how can I contact my classmates?', 'Show me the class roster']) {
    const a = ask(q);
    assert.equal(a.kind, 'list', q);
    assert.match(a.text, /^Marketing 351 has 25 students — you and 24 classmates:\n\n/, q);
    assert.equal(a.text.split('\n').filter((l) => l.startsWith('- ')).length, 24, q);
    assert.doesNotMatch(a.text, /Alex Student/, `${q}: the asker is not listed`);
    assert.match(a.text, /- Mariana Aguilar — Junior, Marketing · maguilar@csu\.fullerton\.example/, q);
  }
});

test('count, one classmate, a group', () => {
  assert.equal(ask('How many students are in my class?').text, '25 students are enrolled in Marketing 351 — you and 24 classmates.');
  assert.equal(ask('How big is my class?').kind, 'count');
  assert.equal(ask('Is Mariana Aguilar in my class?').text, 'Yes — Mariana Aguilar is in Marketing 351 (Junior, Marketing). Their campus email is maguilar@csu.fullerton.example.');
  assert.equal(ask("What's Sam Student's email?").text, 'Sam Student’s campus email is sstudent@csu.fullerton.example. They’re a senior majoring in Marketing.');
  assert.equal(ask('Is Jane Doe in my class?').text, 'I don’t see Jane Doe in Marketing 351.');
  assert.equal(ask('Is Alex Student in my class?').text, 'That’s you — you’re enrolled in Marketing 351.');
  const seniors = ask('Who are the seniors in my marketing class?');
  assert.equal(seniors.kind, 'group');
  assert.match(seniors.text, /^\d+ classmates in Marketing 351 are seniors:\n\n- /);
  assert.doesNotMatch(seniors.text, /Junior/);
  assert.match(ask('Are there any finance majors in my class?').text, /Finance majors?/);
  assert.match(ask('how many seniors are in my class').text, /^\d+ classmates in Marketing 351 are seniors\.$/);
});

test('emails asked for a group, the whole class or one person by name', () => {
  const juniors = ask('Can I get the emails of the juniors in my marketing class?');
  assert.equal(juniors.kind, 'group');
  assert.match(juniors.text, /^\d+ classmates in Marketing 351 are juniors:\n\n- .+@csu\.fullerton\.example/);
  assert.equal(ask('Is there a class email list?').kind, 'list');
  assert.equal(ask('names of everyone in my class').kind, 'list');
  assert.equal(ask('How can I contact Owen Bennett?').text, 'Owen Bennett’s campus email is obennett@csu.fullerton.example. They’re a senior majoring in Marketing.');
});

test('private details stay private; only an enrolled student gets the list; no list → an honest failure', () => {
  for (const q of ["What's Sam's student ID?", "What's Mariana's phone number?", "What is Sam Student's grade?", "What are Owen Bennett's pronouns?"]) assert.equal(ask(q).text, PRIVATE_DETAIL_TEXT, q);
  assert.equal(ask('who is in my class', 'student-nobody').text, NOT_ENROLLED_TEXT);
  assert.equal(classmatesAnswer('who is in my class', null, 'student-alex').text, CLASSMATES_FAILED_TEXT);
  assert.equal(classmatesAnswer('who is in my class', [], 'student-alex').text, CLASSMATES_FAILED_TEXT);
  for (const r of ROWS) assert.doesNotMatch(JSON.stringify(ask('who is in my class').text), /888\d{6}|•/);
});
