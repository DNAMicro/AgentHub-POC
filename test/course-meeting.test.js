// Review #10 (second review): one source of truth for when Marketing 351 meets — Tue & Thu, 10:00–11:15 AM, Mihaylo Hall
// 2405, Aug 25 – Dec 18, 2026 (src/course-schedule.js MEETING / TERM). The class record, the class-day rule for cancellation
// previews and the Faculty view's header all read it. Unit tests (no stack) plus static checks of the page's header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEETING, RECORD_DATES, TERM, TOPICS, meetingLine, meetsOn } from '../src/course-schedule.js';
import { classDays, classDetailsOf, cancellationText } from '../src/professor-staff.js';
import { HOLIDAYS } from '../src/absence-types.js';
import { createStudentRecordsStore } from '../src/student-records-store.js';
import { NOTE_MAX, cancelNoteText, withCancelNote } from '../src/cancel-text.js';

const days = (beginDate, endDate = beginDate) => classDays({ beginDate, endDate });

// ---- the meeting pattern -------------------------------------------------------------------------------------------
test('MEETING: Tue & Thu, 10:00–11:15 AM, Mihaylo Hall 2405; the term runs Aug 25 – Dec 18, 2026', () => {
  assert.deepEqual([...MEETING.weekdays], [2, 4]);
  assert.equal(MEETING.daysLabel, 'Tue & Thu');
  assert.equal(MEETING.timeLabel, '10:00–11:15 AM');
  assert.equal(MEETING.room, 'Mihaylo Hall 2405');
  assert.deepEqual([TERM.start, TERM.end], ['2026-08-25', '2026-12-18']);
  assert.equal(RECORD_DATES, '08/25/2026 - 12/18/2026');
  assert.ok(Object.isFrozen(MEETING), 'nobody changes it at run time');
});

test('meetsOn: only Tuesdays and Thursdays inside the term', () => {
  for (const d of ['2026-08-25', '2026-08-27', '2026-11-10', '2026-11-12', '2026-12-01', '2026-12-17']) assert.equal(meetsOn(d), true, d);
  for (const d of ['2026-08-24', '2026-11-09', '2026-11-11', '2026-11-13', '2026-11-14', '2026-11-15', '2026-12-18']) assert.equal(meetsOn(d), false, d);
  for (const d of ['2026-08-20', '2026-12-22', '2027-01-05']) assert.equal(meetsOn(d), false, `${d}: outside the term`);
  for (const bad of [null, '', 'Tuesday', '2026-11-1', 20261110]) assert.equal(meetsOn(bad), false, String(bad));
});

test('every scheduled topic is taught on a meeting day, inside the term (one source of truth)', () => {
  for (const t of TOPICS) assert.ok(meetsOn(t.taught), `Topic ${t.n} on ${t.taught}`);
});

// ---- the class-day rule ------------------------------------------------------------------------------------------
test('classDays: a filed Tuesday or Thursday is a class day; Mon / Wed / Fri and weekends are not', () => {
  assert.deepEqual(days('2026-11-10'), ['2026-11-10']);
  assert.deepEqual(days('2026-11-12'), ['2026-11-12']);
  for (const d of ['2026-11-09', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-18']) assert.deepEqual(days(d), [], d);
});

test('classDays: a whole week gives its Tuesday and Thursday; two weeks give four', () => {
  assert.deepEqual(days('2026-11-16', '2026-11-20'), ['2026-11-17', '2026-11-19']);
  assert.deepEqual(days('2026-11-16', '2026-11-27'), ['2026-11-17', '2026-11-19', '2026-11-24'], 'Thanksgiving Thursday is out');
  assert.deepEqual(days('2026-12-01', '2026-12-10'), ['2026-12-01', '2026-12-03', '2026-12-08', '2026-12-10']);
});

test('classDays: campus holidays are never class days (Thanksgiving Thursday, Nov 26)', () => {
  assert.ok(HOLIDAYS.includes('2026-11-26'));
  assert.deepEqual(days('2026-11-26'), []);
  assert.deepEqual(days('2026-11-24', '2026-12-01'), ['2026-11-24', '2026-12-01']);
  for (const h of HOLIDAYS) assert.ok(!days('2026-08-25', '2026-12-18').includes(h), h);
});

test('classDays: only inside the term; a range across the term end keeps the days before it', () => {
  assert.deepEqual(days('2026-08-17', '2026-08-28'), ['2026-08-25', '2026-08-27'], 'the first week: nothing before Aug 25');
  assert.deepEqual(days('2026-12-14', '2026-12-31'), ['2026-12-15', '2026-12-17']);
  assert.deepEqual(days('2027-01-05', '2027-01-07'), []);
});

test('classDays: bad or backwards dates give no class days (never a guess)', () => {
  assert.deepEqual(days('2026-11-12', '2026-11-10'), []);
  assert.deepEqual(classDays({ beginDate: 'Thursday', endDate: '2026-11-12' }), []);
  assert.deepEqual(classDays({ beginDate: '2026-02-30', endDate: '2026-02-30' }), []);
});

test('the class record says “TuTh 10:00AM - 11:15AM” and reads back as the cancellation’s time and room', () => {
  const klass = createStudentRecordsStore().roster({ courseId: 'mkt-351', instructorStaffId: 'staff-dabirian' }).roster.class;
  assert.equal(klass.daysAndTimes, 'TuTh 10:00AM - 11:15AM');
  assert.equal(klass.dates, '08/25/2026 - 12/18/2026');
  const info = classDetailsOf(klass);
  assert.deepEqual(info, { time: MEETING.timeLabel, room: MEETING.room });
  assert.equal(cancellationText(days('2026-11-10', '2026-11-12'), info), 'Marketing 351 (10:00–11:15 AM, Mihaylo Hall 2405) is cancelled on Tue, Nov 10 and Thu, Nov 12.');
});

// ---- the note wording shared by the preview card and the agent ---------------------------------------------------------
test('cancel-text: the preview and the agent tidy a note the same way', () => {
  assert.equal(cancelNoteText('  read   chapter 6 '), 'Read chapter 6.');
  assert.equal(cancelNoteText('“See you Tuesday!”'), 'See you Tuesday!');
  assert.equal(cancelNoteText('Quiz moves to Thursday?'), 'Quiz moves to Thursday?');
  assert.equal(cancelNoteText('   '), null);
  assert.equal(cancelNoteText(undefined), null);
  assert.equal(withCancelNote('Base.', 'Dr. Dabirian', null), 'Base.');
  assert.equal(withCancelNote('Base.', 'Dr. Dabirian', 'Read chapter 6.'), 'Base.\n\nFrom Dr. Dabirian: Read chapter 6.');
  assert.equal(NOTE_MAX, 500);
});

// ---- the Faculty view's header -------------------------------------------------------------------------------------
test('header: “Fall 2026 · Aug 25 – Dec 18 · Tue & Thu, 10:00–11:15 AM · Mihaylo Hall 2405”', () => {
  assert.equal(meetingLine(), 'Fall 2026 · Aug 25 – Dec 18 · Tue & Thu, 10:00–11:15 AM · Mihaylo Hall 2405');
  assert.doesNotMatch(meetingLine(), /MoTuWe|10:50|Aug 24/);
});

test('header: the page has its own line under the course and disclaimer, filled from the shared schedule (no lookup per poll)', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const course = html.indexOf('id="author-course"');
  const meeting = html.indexOf('id="author-meeting"');
  assert.ok(course > 0 && meeting > course, 'the meeting line follows the course line (the disclaimer stays)');
  const js = readFileSync(new URL('../public/classroom.js', import.meta.url), 'utf8');
  assert.match(js, /import \{ meetingLine \} from '\/shared\/course-schedule\.js';/);
  assert.match(js, /pv\.meeting\.textContent = meetingLine\(\);/);
  assert.match(js, /pv\.course\.textContent = `\$\{s\.course\.title\} — \$\{s\.course\.note\}`;/, 'the disclaimer line is unchanged');
  assert.doesNotMatch(js, /innerHTML/);
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.prof-chat \.panel-head \.course-meeting/);
});

test('header: the browser can load the shared modules it needs (course schedule, cancel text)', () => {
  const ui = readFileSync(new URL('../src/ui-server.js', import.meta.url), 'utf8');
  assert.match(ui, /app\.get\('\/shared\/course-schedule\.js'/);
  assert.match(ui, /app\.get\('\/shared\/cancel-text\.js'/);
  for (const f of ['course-schedule.js', 'cancel-text.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /^import /m, `${f} stays dependency-free`);
  }
});
