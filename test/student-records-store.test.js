// Student-records store (Part 17): fictional class roster, in memory, dependency-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStudentRecordsStore, REFUSAL_CODES, COURSE_ID, INSTRUCTOR_STAFF_ID } from '../src/student-records-store.js';

test('header values are exact', () => {
  const r = createStudentRecordsStore().roster({ courseId: COURSE_ID, instructorStaffId: INSTRUCTOR_STAFF_ID });
  assert.equal(r.ok, true);
  assert.deepEqual(r.roster.class, {
    courseId: 'mkt-351', term: 'Fall 2026', session: 'Regular Academic Session', institution: 'California State University, Fullerton', career: 'Undergraduate',
    code: 'MKTG 351 - 01', classNumber: '12351', title: 'Principles of Marketing (Lecture)',
    daysAndTimes: 'MoTuWeThFr 10:00AM - 10:50AM', room: 'Mihaylo Hall 1xxx', instructor: 'Dr. Dabirian', dates: '08/24/2026 - 12/18/2026',
    enrollmentStatus: 'Enrolled', capacity: 35, enrolled: 25,
  });
});

test('25 rows sorted by last name; Alex and Sam present; IDs are fictional 888 numbers', () => {
  const { roster } = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' });
  assert.equal(roster.rows.length, 25);
  const last = roster.rows.map((r) => r.name.split(',')[0]);
  assert.deepEqual(last, [...last].sort((a, b) => a.localeCompare(b)));
  assert.equal(roster.rows[0].name, 'Aguilar,Mariana');
  assert.equal(roster.rows[24].name, 'Yamamoto,Hana');
  const by = (id) => roster.rows.find((r) => r.studentId === id);
  assert.equal(by('student-alex').name, 'Student,Alex');
  assert.equal(by('student-sam').name, 'Student,Sam');
  assert.equal(by('student-sam').level, 'Senior');
  assert.equal(by('student-jordan-davis').pronouns, 'they/them');
  assert.equal(by('student-lily-chen').pronouns, 'she/her');
  assert.equal(roster.rows[0].pronouns, '');
  assert.equal(by('student-alex').program, 'Undergraduate Program');
  assert.equal(by('student-alex').plan, 'Business Admin - Marketing');
  assert.equal(by('student-alex').degree, 'BA');
  assert.equal(by('student-vivian-tran').plan, 'Art - Graphic Design');
  assert.equal(by('student-vivian-tran').degree, 'BFA');
  assert.equal(by('student-alex').email, 'astudent@csu.fullerton.example');
  assert.equal(by('student-alex').units, '3.00');
  const ids = roster.rows.map((r) => r.id);
  assert.equal(new Set(ids).size, 25);
  for (const id of ids) assert.match(id, /^888\d{6}$/);
  assert.equal(new Set(roster.rows.map((r) => r.studentId)).size, 25);
  for (const r of roster.rows) assert.ok(['Sophomore', 'Junior', 'Senior'].includes(r.level));
});

test('IDs are fixed constants: two stores agree, and the source has no randomness', () => {
  const a = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' });
  const b = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' });
  assert.deepEqual(a, b);
  assert.doesNotMatch(readFileSync(new URL('../src/student-records-store.js', import.meta.url), 'utf8'), /Math\.random|randomUUID|randomBytes|^import /m);
});

test('refusals: unknown course, not the instructor', () => {
  const s = createStudentRecordsStore();
  assert.equal(s.roster({ courseId: 'mkt-999', instructorStaffId: 'staff-dabirian' }).code, 'unknown_course');
  assert.equal(s.roster({ courseId: 'mkt-351', instructorStaffId: 'staff-other' }).code, 'not_instructor');
  assert.equal(s.roster({ courseId: '__proto__', instructorStaffId: 'staff-dabirian' }).code, 'unknown_course');
  assert.deepEqual(REFUSAL_CODES, ['not_instructor', 'unknown_course']);
});

test('the result is a copy: changing it never changes the store; reset keeps the same roster', () => {
  const s = createStudentRecordsStore();
  const a = s.roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' });
  a.roster.rows[0].name = 'Changed';
  a.roster.rows.pop();
  s.reset();
  assert.equal(s.roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster.rows[0].name, 'Aguilar,Mariana');
  assert.equal(s.roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster.rows.length, 25);
});
