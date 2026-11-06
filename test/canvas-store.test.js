// Canvas LMS stand-in store: in-memory quizzes. Nothing is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasStore, CANVAS_REFUSAL_CODES } from '../src/canvas-store.js';
import { defaultSettings } from '../src/quiz-rules.js';
import { TOPICS } from '../src/course-schedule.js';

const NOW = new Date('2026-11-02T18:00:00Z');
const fresh = () => createCanvasStore({ now: () => NOW });
const q = (i) => ({ text: `Which statement number ${i} best describes marketing?`, answers: ['One', 'Two', 'Three', 'Four'], correct: 1 });
const quiz = (extra = {}) => ({ topic: 1, ...defaultSettings(1, NOW), questions: [q(1), q(2), q(3)], ...extra });
const create = (s, over = {}) => s.create({ courseId: 'mkt-351', quiz: quiz(), operationId: 'op-1', ...over });

test('refusal codes are the fixed set of eight', () => {
  assert.deepEqual([...CANVAS_REFUSAL_CODES].sort(), ['bad_question', 'bad_settings', 'due_in_past', 'not_taught', 'operation_reused', 'reset_during_call', 'unknown_course', 'unknown_quiz']);
});

test('create numbers quizzes from 4821 and stores them unpublished, no answer key', () => {
  const s = fresh();
  const a = create(s);
  assert.equal(a.ok, true);
  const z = quiz();
  assert.deepEqual(a.quiz, { quizId: 4821, courseId: 'mkt-351', courseLabel: 'MKTG 351 (Fall 2026)', published: false, title: z.title, questionCount: 3, pointsTotal: 9, minutes: 10, attempts: 1, dueAt: z.dueAt });
  const b = create(s, { operationId: 'op-2', quiz: quiz({ title: 'Other' }) });
  assert.equal(b.quiz.quizId, 4822);
  assert.equal(s.list().length, 2);
  assert.equal(JSON.stringify(s.list()).includes('answers'), false);
});

test('repeat operationId returns the same quiz; changed quiz is operation_reused', () => {
  const s = fresh();
  const a = create(s);
  assert.deepEqual(create(s), a);
  assert.equal(s.list().length, 1);
  const r = create(s, { quiz: quiz({ minutes: 20 }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'operation_reused');
  assert.equal(s.list().length, 1);
  assert.equal(create(s, { operationId: '__proto__' }).ok, true);
});

test('checks: wrong course, untaught topic, bad settings, past due, bad question', () => {
  const s = fresh();
  assert.equal(create(s, { courseId: 'other' }).code, 'unknown_course');
  const last = TOPICS[TOPICS.length - 1].n;
  assert.equal(create(s, { operationId: 'a', quiz: quiz({ topic: last }) }).code, 'not_taught');
  assert.equal(create(s, { operationId: 'b', quiz: quiz({ minutes: 500 }) }).code, 'bad_settings');
  assert.equal(create(s, { operationId: 'c', quiz: quiz({ dueAt: '2026-11-01T00:00:00Z' }) }).code, 'due_in_past');
  const bad = create(s, { operationId: 'd', quiz: quiz({ questions: [{ ...q(1), correct: 9 }] }) });
  assert.equal(bad.code, 'bad_question');
  assert.equal(typeof bad.reason, 'string');
  assert.equal(s.list().length, 0);
  assert.ok([...CANVAS_REFUSAL_CODES].includes(bad.code));
});

test('reset empties, restarts numbering at 4821 and refuses a stale generation', () => {
  const s = fresh();
  const gen = s.generation();
  create(s);
  s.reset();
  assert.equal(s.list().length, 0);
  assert.equal(s.generation(), gen + 1);
  const stale = create(s, { operationId: 'op-9', generation: gen });
  assert.equal(stale.code, 'reset_during_call');
  assert.equal(s.list().length, 0);
  const again = create(s, { generation: s.generation() });
  assert.equal(again.quiz.quizId, 4821);
});

test('publish is idempotent; unknown id is unknown_quiz; wrong course is unknown_course', () => {
  const s = fresh();
  create(s);
  const a = s.publish({ courseId: 'mkt-351', quizId: 4821, operationId: 'p1' });
  assert.equal(a.ok, true);
  assert.equal(a.quiz.published, true);
  assert.equal(s.publish({ courseId: 'mkt-351', quizId: 4821, operationId: 'p2' }).quiz.published, true);
  assert.deepEqual(s.publish({ courseId: 'mkt-351', quizId: 4821, operationId: 'p1' }), a);
  assert.equal(s.publish({ courseId: 'mkt-351', quizId: 9999, operationId: 'p3' }).code, 'unknown_quiz');
  assert.equal(s.publish({ courseId: 'x', quizId: 4821, operationId: 'p4' }).code, 'unknown_course');
  assert.equal(s.publish({ courseId: 'mkt-351', quizId: 4822, operationId: 'p1' }).code, 'operation_reused');
  assert.equal(s.list()[0].published, true);
});

// ---- review C15: the Canvas course list -----------------------------------------------------------------------------
import { CLASS_MEMBERS, ADDED_YESTERDAY } from '../src/class-seed.js';
import { createStudentRecordsStore } from '../src/student-records-store.js';

test('C15 class seed matches the student records roster: same 25 ids and names', () => {
  const rows = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster.rows;
  assert.deepEqual(CLASS_MEMBERS.map(([id]) => id), rows.map((r) => r.studentId));
  assert.deepEqual(CLASS_MEMBERS.map(([, first, last]) => `${last},${first}`), rows.map((r) => r.name));
  assert.ok(rows.some((r) => r.studentId === ADDED_YESTERDAY));
});

test('C15 store.students: everyone but the student added yesterday; copies, so a caller cannot change Canvas', () => {
  const store = createCanvasStore();
  const r = store.students({ courseId: 'mkt-351' });
  assert.equal(r.ok, true);
  assert.equal(r.students.length, CLASS_MEMBERS.length - 1);
  r.students[0].name = 'Changed';
  r.students.pop();
  assert.equal(store.students({ courseId: 'mkt-351' }).students.length, 24);
  assert.notEqual(store.students({ courseId: 'mkt-351' }).students[0].name, 'Changed');
  assert.deepEqual(store.students({ courseId: 'nope' }), { ok: false, code: 'unknown_course', reason: 'Canvas has no such course.' });
});
