// Reading a time-off request from the professor's words: dates and partial days by code, the absence
// name by the model (live) or a labelled heuristic (mock), then verified by code.
// What is MOCKED: the model's output (fake Anthropic API / heuristic) — this proves plumbing and the code checks, not judgment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';
import { readDates, readPartial, readRequest } from '../src/hr-intent.js';
import { chooseAbsence, hrStatus } from '../src/hr-model.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 2026-11-02 is a Monday; noon UTC is the same calendar day in every US time zone the demo uses.
const MON = new Date('2026-11-02T17:00:00Z');
const TUE = new Date('2026-11-03T17:00:00Z');
// An arrival partial (hours missed before arriving) carries side 'arrive'.
const arrive = (hours) => ({ mode: 'start_day_only', hours, side: 'arrive' });

test('readDates: today, tomorrow, yesterday', () => {
  assert.deepEqual(readDates('I am out today', MON), { beginDate: '2026-11-02', endDate: '2026-11-02' });
  assert.deepEqual(readDates('out tomorrow', MON), { beginDate: '2026-11-03', endDate: '2026-11-03' });
  assert.deepEqual(readDates('I was sick yesterday', TUE), { beginDate: '2026-11-02', endDate: '2026-11-02' });
});

test('readDates: weekday rules (this/bare = next occurrence incl. today, next = following week, last = past)', () => {
  assert.deepEqual(readDates('Friday', MON), { beginDate: '2026-11-06', endDate: '2026-11-06' });
  assert.deepEqual(readDates('this Friday', MON), { beginDate: '2026-11-06', endDate: '2026-11-06' });
  assert.deepEqual(readDates('next Friday', MON), { beginDate: '2026-11-13', endDate: '2026-11-13' });
  assert.deepEqual(readDates('last Friday', MON), { beginDate: '2026-10-30', endDate: '2026-10-30' });
  assert.deepEqual(readDates('Monday', MON), { beginDate: '2026-11-02', endDate: '2026-11-02' }, 'today counts');
  assert.deepEqual(readDates('next Monday', MON), { beginDate: '2026-11-09', endDate: '2026-11-09' });
});

test('readDates: a number followed by hours or a time is never a day', () => {
  const d = (t) => readDates(t, MON);
  const nov6 = { beginDate: '2026-11-06', endDate: '2026-11-06' };
  assert.deepEqual(d('off on Nov 6 - 2 hrs'), nov6);
  assert.deepEqual(d('Off Nov 6, 4 hours'), nov6);
  assert.deepEqual(d('Off Nov 6, 10 am to noon'), nov6);
  assert.deepEqual(d('Nov 6, 4 hours in the morning'), nov6);
  assert.deepEqual(d('Nov 5, 6 and 7'), { beginDate: '2026-11-05', endDate: '2026-11-07' });
  assert.deepEqual(d('Nov 5th and 6th'), { beginDate: '2026-11-05', endDate: '2026-11-06' });
  assert.deepEqual(d('Dec 30 - 2'), { beginDate: '2026-12-30', endDate: '2027-01-02' });
  assert.deepEqual(d('Nov 10 to Nov 12'), { beginDate: '2026-11-10', endDate: '2026-11-12' });
});

test('readDates: lists and ranges', () => {
  assert.deepEqual(readDates('this Thursday and Friday', MON), { beginDate: '2026-11-05', endDate: '2026-11-06' });
  assert.deepEqual(readDates('Monday through Wednesday', MON), { beginDate: '2026-11-02', endDate: '2026-11-04' });
  assert.deepEqual(readDates('Nov 10 to Nov 12', MON), { beginDate: '2026-11-10', endDate: '2026-11-12' });
  assert.deepEqual(readDates('November 10 - 12', MON), { beginDate: '2026-11-10', endDate: '2026-11-12' });
  assert.deepEqual(readDates('next Thursday and Friday', MON), { beginDate: '2026-11-12', endDate: '2026-11-13' });
});

test('readDates: explicit dates', () => {
  assert.deepEqual(readDates('off on 11/5', MON), { beginDate: '2026-11-05', endDate: '2026-11-05' });
  assert.deepEqual(readDates('off Nov 5', MON), { beginDate: '2026-11-05', endDate: '2026-11-05' });
  assert.deepEqual(readDates('off on 12/24/2026', MON), { beginDate: '2026-12-24', endDate: '2026-12-24' });
  assert.equal(readDates('off Feb 30', MON), null, 'not a real date');
});

test('readDates: vague words give no date', () => {
  assert.equal(readDates('a few days next week', MON), null);
  assert.equal(readDates('I need some time off', MON), null);
  assert.equal(readDates('I sat down at 1pm', MON), null, 'the word sat is not Saturday');
});

test('readDates: fractions are not dates', () => {
  assert.equal(readDates('I need a 1/2 day off', MON), null);
  assert.equal(readDates('out 3/4 of the day', MON), null);
  assert.deepEqual(readDates('out 1/2 day on Friday', MON), { beginDate: '2026-11-06', endDate: '2026-11-06' });
});

test('readDates: unrelated dates are not merged into one span', () => {
  assert.equal(readDates('Friday off, conference is Nov 20', MON), null);
  assert.equal(readDates('back on Nov 9, out Thursday', MON), null);
  assert.deepEqual(readDates('Nov 5 and Nov 6', MON), { beginDate: '2026-11-05', endDate: '2026-11-06' });
  assert.deepEqual(readDates('Monday, Tuesday and Wednesday', MON), { beginDate: '2026-11-02', endDate: '2026-11-04' });
});

test('readDates: a range never runs backwards', () => {
  assert.deepEqual(readDates('Dec 30 - 2', MON), { beginDate: '2026-12-30', endDate: '2027-01-02' });
  assert.deepEqual(readDates('Nov 28 to 3', MON), { beginDate: '2026-11-28', endDate: '2026-12-03' });
});

test('readPartial: times, parts of the day, hours', () => {
  assert.deepEqual(readPartial('leaving at noon today'), { mode: 'start_day_only', hours: 5 });
  assert.equal(readPartial('leaving at 1pm').hours, 4);
  assert.equal(readPartial('out after 2:30').hours, 2.5);
  assert.equal(readPartial('I was sick yesterday afternoon').hours, 4);
  assert.equal(readPartial('out Friday morning').hours, 4);
  assert.equal(readPartial('taking a half day').hours, 4);
  assert.equal(readPartial('out for 2 hours').hours, 2);
  assert.equal(readPartial('afternoon, leaving at 3pm').hours, 2, 'strict Rule A (changed from null): a bare “afternoon” is not a cue, so one cue → 2');
  assert.equal(readPartial('I need Friday off'), null);
  assert.equal(readPartial('leaving at 5pm'), null, 'nothing left of the day');
});

test('mock chooseAbsence: labelled heuristic with a quote from the words', async () => {
  const r = await chooseAbsence({ text: 'My grandmother passed away' });
  assert.equal(r.absenceName, 'Bereavement/Funeral');
  assert.equal(r.quote, 'grandmother passed away');
  assert.equal(r.relationship, 'grandmother');
  assert.match(r.model, /mock heuristic/);
  assert.equal(hrStatus().mode, 'mock');
  const self = await chooseAbsence({ text: 'I am sick, need Friday off' });
  assert.equal(self.absenceName, 'Sick – Self');
  assert.equal(self.relationship, '');
  const fam = await chooseAbsence({ text: 'My mother is sick, out Tuesday' });
  assert.equal(fam.absenceName, 'Sick – Family Care');
  assert.equal(fam.relationship, 'mother');
  assert.equal((await chooseAbsence({ text: 'jury duty on Monday' })).absenceName, 'Jury Duty');
  assert.equal((await chooseAbsence({ text: 'going to a conference' })).absenceName, 'Professional Development');
  assert.equal((await chooseAbsence({ text: 'a personal holiday please' })).absenceName, 'Personal Holiday');
  assert.equal((await chooseAbsence({ text: 'taking a vacation' })).absenceName, 'Vacation');
  const none = await chooseAbsence({ text: 'I need Friday off' });
  assert.equal(none.absenceName, '');
  assert.equal(none.quote, '');
});

test('readRequest: combines the reading and lists what is still missing', async () => {
  const r = await readRequest({ text: 'My grandmother passed away, I need Thursday and Friday off', now: MON });
  assert.deepEqual(r.prefill, { absenceName: 'Bereavement/Funeral', beginDate: '2026-11-05', endDate: '2026-11-06', hours: undefined, relationship: 'grandmother', note: '' });
  assert.equal(r.quote, 'grandmother passed away');
  assert.equal(r.partial, null);
  assert.deepEqual(r.missing, []);

  const m = await readRequest({ text: 'I need Friday off', now: MON });
  assert.equal(m.prefill.absenceName, '');
  assert.equal(m.prefill.beginDate, '2026-11-06');
  assert.deepEqual(m.missing, ['absenceName']);

  const d = await readRequest({ text: 'I am sick', now: MON });
  assert.deepEqual(d.missing, ['dates']);

  const rel = await readRequest({ text: 'I need Friday off for a funeral', now: MON });
  assert.equal(rel.prefill.absenceName, 'Bereavement/Funeral');
  assert.deepEqual(rel.missing, ['relationship'], 'a relationship is asked for only when the absence needs one');

  const p = await readRequest({ text: 'I was sick yesterday afternoon', now: TUE });
  assert.equal(p.prefill.beginDate, '2026-11-02');
  assert.equal(p.partial.hours, 4);
  assert.equal(p.prefill.hours, undefined, 'the store computes hours');
});

test('readPartial: "N hours" anywhere is a partial day; a time of day or a long span is not', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  assert.deepEqual(readPartial('Off Nov 6, 4 hours, personal holiday'), partial(4));
  assert.deepEqual(readPartial('4 hours on Friday'), partial(4));
  assert.deepEqual(readPartial('Friday, 4 hrs'), partial(4));
  assert.deepEqual(readPartial('Friday, 3 hr'), partial(3));
  assert.deepEqual(readPartial('Friday 6h'), partial(6));
  assert.deepEqual(readPartial('2.5 hours on Friday'), partial(2.5));
  assert.deepEqual(readPartial('a 4-hour absence on Friday'), partial(4));
  assert.deepEqual(readPartial('out for 2 hours'), partial(2), 'the old "for N hours" still reads');
  assert.equal(readPartial('Friday, 8 hours'), null, 'a standard day is a full day, not a partial one');
  assert.equal(readPartial('Friday, 10 hours'), null, 'more than a standard day is not a partial day');
  assert.equal(readPartial('I gave 48 hours notice, out Friday'), null, 'a span over 24 h is ignored');
  assert.equal(readPartial('Friday, 0 hours'), null);
  assert.equal(readPartial('Friday, 10 am appointment'), null, 'a time of day is not a duration');
  assert.equal(readPartial('back by 2pm Friday'), null);
  assert.equal(readPartial('Friday, 9:30 appointment'), null);
  assert.equal(readPartial('out Friday at 10 am').hours, 7, 'a leaving time still counts to 17:00, never as 10 hours');
  assert.equal(readPartial('leaving at 2pm, 4 hours'), null, 'Rule A (changed from 3): two cues → null');
  assert.equal(readPartial('Friday afternoon, 2 hours').hours, 2, 'strict Rule A (changed from null): a bare “afternoon” is not a cue');
  assert.equal(readPartial('leaving at noon').hours, 5, 'noon rule unchanged');
});

test('readPartial review fixes: long spans are skipped, unrelated hours lose to the day words, .5 and 24-hour clocks, no room numbers', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  // 3: a number of 8–24 hours is skipped and reading goes on.
  assert.deepEqual(readPartial('with 12 hours notice, 4 hours off Nov 6'), partial(4));
  assert.deepEqual(readPartial('24 hours notice, off the afternoon'), partial(4));
  // 4: hours not about the absence never beat afternoon/morning; "in N hours" is a relative time, not a length.
  assert.deepEqual(readPartial('I have 2 hours of meetings then off the afternoon'), partial(4));
  assert.equal(readPartial('in 2 hours i leave'), null);
  assert.deepEqual(readPartial('4 hours off on Friday'), partial(4));
  assert.deepEqual(readPartial('out 3 hours Friday'), partial(3));
  // 5: a leading dot; a 24-hour clock is a time of day; "Room 4h" is not hours.
  assert.deepEqual(readPartial('.5 hours on Friday'), partial(0.5));
  assert.deepEqual(readPartial('leave at 14h'), partial(3));
  assert.deepEqual(readPartial('leave at 14:00 Friday'), partial(3));
  assert.equal(readPartial('Friday in Room 4h'), null);
  assert.equal(readPartial('Friday in B4h'), null);
});

test('readPartial: leaving early or coming in late by N hours (an hour = 1) is a partial day of N hours', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  assert.deepEqual(readPartial('leaving 2 hours early Friday'), partial(2));
  assert.deepEqual(readPartial('leave 3 hours early today'), partial(3));
  assert.deepEqual(readPartial('out an hour early'), partial(1));
  assert.deepEqual(readPartial('out one hour early on Friday'), partial(1));
  assert.deepEqual(readPartial('coming in 2 hours late'), arrive(2));
  assert.deepEqual(readPartial('start 2 hours late tomorrow'), arrive(2));
  assert.deepEqual(readPartial('leaving 2.5 hrs early Friday'), partial(2.5));
  // Unchanged: "in N hours" alone is a relative time; unrelated hours lose to the day words; 8+ is never partial.
  assert.equal(readPartial('in 2 hours i leave'), null);
  assert.equal(readPartial('in an hour i leave'), null);
  assert.deepEqual(readPartial('I have an hour of meetings then off the afternoon'), partial(4));
  assert.equal(readPartial('leaving 9 hours early'), null);
});

test('readPartial: early/late hours count only with the professor’s own leaving/arriving verb, never negated or about something else', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  assert.equal(readPartial("I'll be 2 hours late with the report, off Friday"), null);
  assert.equal(readPartial('off Friday, 2 hours late for class last week'), null);
  assert.equal(readPartial('not leaving 2 hours early'), null);
  assert.equal(readPartial("I won't be coming in 2 hours late"), null);
  assert.deepEqual(readPartial('leaving 2 hours early Friday'), partial(2));
  assert.deepEqual(readPartial('leave 3 hours early today'), partial(3));
  assert.deepEqual(readPartial('out an hour early'), partial(1));
  assert.deepEqual(readPartial('coming in 2 hours late'), arrive(2));
  assert.deepEqual(readPartial('start 2 hours late tomorrow'), arrive(2));
  assert.deepEqual(readPartial('start 2 hours late on Friday'), arrive(2), 'a day after "on" is a time, not a noun');
  assert.deepEqual(readPartial('Friday I need 2 hours early to leave'), partial(2), 'the verb may follow');
});

test('readPartial: early/late hours count only when the professor is the one leaving/arriving, and not retracted', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  for (const t of [
    'The shuttle is coming in 2 hours late, I’m off Nov 6',
    'my kid is leaving 2 hours early',
    'the students are leaving 2 hours early Friday',
    'He is leaving 2 hours early',
    'leaving 2 hours early, no wait never mind',
    'I think the students are leaving 2 hours early',
    'Alex is leaving 2 hours early Friday',
  ]) assert.equal(readPartial(t), null, t);
  assert.deepEqual(readPartial('leaving 2 hours early Friday'), partial(2));
  assert.deepEqual(readPartial('I’m leaving 2 hours early today'), partial(2));
  assert.deepEqual(readPartial("I'm leaving 2 hours early today"), partial(2));
  assert.deepEqual(readPartial('I need to leave 3 hours early'), partial(3));
  assert.deepEqual(readPartial('out an hour early'), partial(1));
  assert.deepEqual(readPartial('coming in 2 hours late'), arrive(2));
  assert.deepEqual(readPartial('start 2 hours late tomorrow'), arrive(2));
  assert.deepEqual(readPartial('Dr says I should leave 2 hours early'), partial(2), 'the speaker is the one leaving');
  assert.deepEqual(readPartial('Friday I will be leaving 2 hours early'), partial(2));
});

test('readPartial structural rule: early/late hours only when nothing but a day/time follows and no earlier clause is about someone else', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  // (a) anything after the phrase other than a day/date/time (and please/thanks) → no partial day.
  for (const t of [
    'leaving 2 hours early, on second thought skip it',
    'leaving 2 hours early just kidding',
    'leaving 2 hours early jk',
    'leaving 2 hours early nvm',
    'leaving 2 hours early, disregard',
    'leaving 2 hours early or maybe not',
    'leaving 2 hours early, no I’m not',
    'leaving 2 hours early, I mean 3 hours early',
    'leaving 2 hours early, cancel',
  ]) assert.equal(readPartial(t), null, t);
  for (const [t, h] of [
    ['leaving 2 hours early Friday', 2], ['leaving 2 hours early today', 2], ['leaving 2 hours early tomorrow', 2],
    ['leaving 2 hours early on Nov 6', 2], ['leaving 2 hours early this week', 2],
    ['leaving 2 hours early Friday, please', 2], ['leaving 2 hours early Friday. Thanks!', 2],
  ]) assert.deepEqual(readPartial(t), partial(h), t);
  assert.deepEqual(readPartial('leaving 2 hours early Friday afternoon'), partial(2), 'strict Rule A (changed from null): “Friday afternoon” after early is a day/time, not an off cue');
  // (b) an earlier clause about someone else, and no “I” in the verb's own clause → no partial day.
  assert.equal(readPartial('My kid is sick, leaving 2 hours early'), null);
  assert.equal(readPartial('The shuttle is late, coming in 2 hours late'), null);
  assert.deepEqual(readPartial('the bus is late so I’m coming in 2 hours late'), arrive(2));
  assert.deepEqual(readPartial('The students are out Friday, I’m leaving 2 hours early'), partial(2));
  // Live: a negation in an earlier part of the sentence doesn't negate the leaving.
  assert.deepEqual(readPartial("I want to file for time off, I'm not feeling well and I'm leaving 2 hours early Friday"), partial(2));
  assert.equal(readPartial("I'm sick and I'm not leaving 2 hours early"), null);
});

test('readPartial: once an early/late phrase is present, morning/afternoon never fills in 4 h; a short reason may follow the day', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  // Strict Rule A (changed from null back to the reviewer's values): morning/afternoon here only name when, they are not
  // tied to off/out/sick/leaving, so the early/late phrase is the one cue.
  for (const [t, h, side] of [
    ['I’m leaving 2 hours early Friday afternoon for a doctor appointment', 2],
    ['leaving an hour early Friday afternoon if that’s ok', 1],
    ["leaving an hour early Friday afternoon if that's ok", 1],
    ['leaving 2 hours early tomorrow morning to pick up my kid', 2],
    ['I’m coming in 2 hours late Monday morning, dentist', 2, 'arrive'],
  ]) assert.deepEqual(readPartial(t), side ? arrive(h) : partial(h), t);
  // A short reason after a day (one cue) still gives N.
  assert.deepEqual(readPartial('I’m leaving 2 hours early Friday for a doctor appointment'), partial(2));
  assert.deepEqual(readPartial('I’m coming in 2 hours late Monday, dentist'), arrive(2));
  for (const t of [
    'My kid is sick, leaving 2 hours early Friday afternoon',
    'The shuttle is late, coming in 2 hours late this morning',
    'leaving 2 hours early Friday afternoon jk',
    'leaving 2 hours early Friday morning, actually no',
    'leaving 2 hours early Friday afternoon nvm',
    'leaving 2 hours early Friday afternoon, I mean 3 hours early',
    'leaving 2 hours early Friday afternoon or maybe not',
    'Kid’s sick, leaving 2 hours early',
    "Kid's sick, leaving 2 hours early Friday afternoon",
    'alex is sick, leaving 2 hours early',
    'alex is leaving 2 hours early Friday afternoon',
  ]) assert.equal(readPartial(t), null, t);
  // Without any early/late phrase the day words still count.
  assert.deepEqual(readPartial('off Friday afternoon'), partial(4));
});

test('Rule A: any correction/alternative marker, or two or more hour cues, gives no partial day', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  for (const t of [
    'leaving 2 hours early Friday, or make it 3', 'Off Nov 6, 4 hours, make it 3 hours', 'leaving at 2pm, otherwise at 3pm',
    'leaving 2 hours early unless the meeting runs late', 'leave at noon instead of 1pm', 'leaving 2 hours early, I mean 3',
    'actually leaving at 2pm', 'perhaps leaving at 3pm Friday', 'maybe 2 hours on Friday', 'either 2 or 3 hours',
    'leaving at 2pm jk', 'Off Friday 4 hours nvm', 'leaving at 1pm, never mind', 'leaving at 1pm, scratch that',
    'on second thought, leaving at 2pm', 'leaving 2 hours early Friday, cancel',
    'out Friday morning and leaving at 3pm', '4 hours Friday, then 2 hours Monday', 'leaving at 1pm, 4 hours',
  ]) assert.equal(readPartial(t), null, t);
  // Strict Rule A (changed from null): a bare day-part word is not a cue.
  assert.deepEqual(readPartial('leaving at noon Friday morning'), partial(5));
  assert.deepEqual(readPartial('half day Friday afternoon'), partial(4));
  // The simple positives keep their values.
  assert.deepEqual(readPartial('leaving at noon today'), partial(5));
  assert.deepEqual(readPartial('Off Nov 6, 4 hours'), partial(4));
  assert.deepEqual(readPartial('leaving 2 hours early Friday'), partial(2));
  assert.deepEqual(readPartial('out Friday morning'), partial(4));
});

test('strict Rule A (C2): a clock time counts only after the professor’s own leaving or arrival verb', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  assert.deepEqual(readPartial('coming in at 10am Monday'), arrive(2), 'arrival: 10:00 − 08:00');
  assert.deepEqual(readPartial("I'll be in at 11am tomorrow, dentist"), arrive(3));
  assert.deepEqual(readPartial('arriving at 1pm Friday'), arrive(5));
  assert.equal(readPartial('Out Friday, back at 2pm'), null, '“back at” is not an arrival cue: a full day');
  for (const t of ['meeting at 3pm, off Friday', 'my flight is at 3pm Friday', 'surgery at 2pm Friday', 'students leave at noon Friday', 'students leave at noon, I’m off the afternoon']) assert.equal(readPartial(t), null, t);
  assert.deepEqual(readPartial('leaving Friday at 2pm'), partial(3), 'a day may sit between the verb and the time');
  assert.deepEqual(readPartial('out Friday at 10 am'), partial(7));
});

test('strict Rule A (I1): morning/afternoon/half day count only when tied to being off/out/sick/leaving', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  for (const t of [
    'I have class in the morning, off Friday', 'my afternoon lecture is cancelled, I need Friday off',
    'students have a quiz Friday morning, I am off Friday', 'the morning shuttle is late, off Friday', 'I teach in the afternoon, need Friday off',
  ]) assert.equal(readPartial(t), null, t);
  for (const [t, h] of [['off the afternoon', 4], ['out this morning', 4], ['sick yesterday afternoon', 4], ['Friday afternoon off', 4], ['half-day Friday', 4], ['a half day', 4]]) assert.deepEqual(readPartial(t), partial(h), t);
});

test('strict Rule A (M2): partial hours apply only to a single-day absence', async () => {
  const many = await readRequest({ text: 'Off Nov 5 to Nov 6, 4 hours, vacation', now: MON });
  assert.equal(many.prefill.beginDate, '2026-11-05');
  assert.equal(many.prefill.endDate, '2026-11-06');
  assert.equal(many.partial, null, 'two days: full days');
  const list = await readRequest({ text: 'leaving 2 hours early Thursday and Friday', now: MON });
  assert.equal(list.prefill.endDate, '2026-11-06');
  assert.equal(list.partial, null);
  const one = await readRequest({ text: 'leaving 2 hours early Friday', now: MON });
  assert.deepEqual(one.partial, { mode: 'start_day_only', hours: 2 });
});

test('Rule A: “starting at T” and any clock time that is not the one verb-tied cue block (null)', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  for (const t of [
    "I'm off starting at 2pm Friday", "I'll be out starting at 2pm Friday for a doctor appointment", 'Off Friday starting at 1pm',
    "Starting at 1pm Friday I'm off", "Starting at noon Friday I'm out, my son has a fever", 'starting at noon Monday after my appointment',
    'out from 2pm Friday',
    'Leaving at 2pm Friday, no wait, noon', 'Leaving at 2pm Friday - sorry, 1pm', "I'm leaving at 3pm Friday. Correction: 1pm",
    "I'll leave at 2pm Friday, the dentist moved it to noon", "I'm sick today, I have a meeting at 3pm I'll miss",
  ]) assert.equal(readPartial(t), null, t);
  // “sorry”/“moved” are corrections only when a time or number follows in the same clause.
  assert.deepEqual(readPartial("Sorry, I'm sick, leaving at noon today"), partial(5));
  assert.deepEqual(readPartial('Sorry for the short notice, leaving at 2pm Friday'), partial(3));
  assert.equal(readPartial('Leaving at 2pm Friday, sorry 1pm'), null);
  // A single verb-tied time is still read.
  assert.deepEqual(readPartial('leaving at 2pm Friday'), partial(3));
  assert.deepEqual(readPartial('coming in at 10am Monday'), arrive(2));
});

test('Rule A: any number or correction word after the first hour cue gives null', () => {
  const partial = (hours) => ({ mode: 'start_day_only', hours });
  for (const t of [
    'Leaving at 2pm Friday, sorry, make that 1', 'Leaving at 2pm Friday, sorry, 1', 'Leaving at 2pm Friday. Sorry, one o’clock',
    "Leaving at 2pm Friday. Sorry, one o'clock", 'Leaving at 2pm Friday, sorry — one', 'Leaving at 2pm Friday, sorry, half past one',
    'Leaving at 2pm Friday, sorry, an hour later than that', 'Leaving at 2pm Friday, oops, make that 1',
    'Leaving at 2pm Friday, oops', 'Leaving at 2pm Friday, the dentist moved', 'leaving 2 hours early Friday, two of my kids are sick',
  ]) assert.equal(readPartial(t), null, t);
  // Before the first cue they don't block; a date after the cue is not a correction.
  assert.deepEqual(readPartial("Sorry, I'm sick, leaving at noon today"), partial(5));
  assert.deepEqual(readPartial('Off Nov 6, 4 hours'), partial(4));
  assert.deepEqual(readPartial('I was sick yesterday afternoon'), partial(4));
  assert.deepEqual(readPartial('coming in at 10am Monday'), arrive(2));
  assert.deepEqual(readPartial('leaving 2 hours early on Nov 6'), partial(2));
  assert.deepEqual(readPartial('with 12 hours notice, 4 hours off Nov 6'), partial(4));
});

test('N1: partial hours only when the message refers to exactly one day; “back <day>” is not an absence day', async () => {
  // Item 3 (changed from begin Nov 3): “this afternoon” is today, so the first reads Nov 2–3.
  for (const [text, begin, end] of [
    ['Out sick this afternoon and tomorrow', '2026-11-02', '2026-11-03'],
    ["I'm sick, leaving at noon, and out tomorrow too", '2026-11-03', '2026-11-03'],
    ['Out this afternoon and all day tomorrow', '', ''], // not a plain list (“and all day”): HR asks — never a wrong date
  ]) {
    const r = await readRequest({ text, now: MON });
    assert.equal(r.partial, null, `${text}: two days → full days`);
    assert.equal(r.prefill.beginDate, begin, `${text}: dates as read`);
    assert.equal(r.prefill.endDate, end, text);
  }
  const back = await readRequest({ text: 'Sick, going home at 1pm, back Wednesday', now: MON });
  assert.equal(back.prefill.beginDate, '', '“back Wednesday” is the return day, not an absence day: HR asks');
  assert.equal(back.partial, null);
  assert.ok(back.missing.includes('dates'));
  // One day still reads its hours.
  assert.deepEqual((await readRequest({ text: "I'm sick, leaving at noon today", now: MON })).partial, { mode: 'start_day_only', hours: 5 });
  assert.deepEqual((await readRequest({ text: 'leaving at 2pm Friday, Nov 6', now: MON })).partial, { mode: 'start_day_only', hours: 3 }, 'Friday and Nov 6 are the same day');
});

test('N3: no / wait / earlier / later / possibly / maybe / might / probably after the cue → null', () => {
  for (const t of [
    'Leaving at 2pm Friday, no, earlier', 'Leaving at 2pm Friday, wait no, earlier', 'Leaving at 2pm Friday, possibly earlier',
    'Leaving at 2pm Friday, might be later', 'Leaving at 2pm Friday, probably', 'Leaving at 2pm Friday, wait',
  ]) assert.equal(readPartial(t), null, t);
  assert.deepEqual(readPartial('leaving 2 hours earlier Friday'), { mode: 'start_day_only', hours: 2 }, '“earlier” inside the cue is the cue');
});

test('item 3: this morning / this afternoon / tonight are today', async () => {
  assert.deepEqual(readDates('out this morning', MON), { beginDate: '2026-11-02', endDate: '2026-11-02' });
  assert.deepEqual(readDates('Out sick this afternoon and tomorrow', MON), { beginDate: '2026-11-02', endDate: '2026-11-03' });
  const r = await readRequest({ text: "I'm leaving at 2pm tonight", now: MON });
  assert.equal(r.prefill.beginDate, '2026-11-02');
  assert.deepEqual(r.partial, { mode: 'start_day_only', hours: 3 });
});

test('item 1: “back/return <day>” gives no dates unless it is exactly one day, back the next working day', async () => {
  for (const text of [
    'Out Wednesday, back Friday', "I'm sick today, back Wednesday", "I'm sick, out tomorrow, back Thursday",
    'Out from Nov 5, back on Nov 9', 'Out today and tomorrow, back Thursday', 'I need a sick day Wednesday, back Friday',
    'Out Wednesday, returning Friday', 'Sick, going home at 1pm, back Wednesday',
  ]) {
    const r = await readRequest({ text, now: MON });
    assert.equal(r.prefill.beginDate, '', `${text}: no dates (HR asks)`);
    assert.ok(r.missing.includes('dates'), text);
  }
  for (const text of ["I'm out Wednesday, back next Thursday", 'I need a sick day Thursday, back Friday next week', 'Vacation Friday, back Monday the 16th']) {
    const r = await readRequest({ text, now: MON });
    assert.equal(r.prefill.beginDate, '', `${text}: the back day is resolved for real (not the next working day) → no dates`);
  }
  assert.equal((await readRequest({ text: 'My back hurts, I need Friday off', now: MON })).prefill.beginDate, '2026-11-06', '“back” without a day is not a return day');
  assert.equal((await readRequest({ text: 'My back hurts and I need Friday off', now: MON })).prefill.beginDate, '2026-11-06', '“back” must be followed directly by a day');
  for (const [text, day] of [['Out Friday, back Monday', '2026-11-06'], ['Out Wednesday, back Thursday', '2026-11-04'], ['Out Friday, returning Monday', '2026-11-06']]) {
    const r = await readRequest({ text, now: MON });
    assert.equal(r.prefill.beginDate, day, text);
    assert.equal(r.prefill.endDate, day, text);
  }
});

test('change verb + “X to Y” days in a first message: no dates (HR asks), never a range', async () => {
  for (const text of ['Change Friday to Monday', 'Move Friday to Monday, vacation', 'Switch it from Friday to Monday', 'Vacation Monday instead of Friday']) {
    const r = await readRequest({ text, now: MON });
    assert.equal(r.prefill.beginDate, '', text);
    assert.ok(r.missing.includes('dates'), text);
  }
  assert.deepEqual((await readRequest({ text: 'Vacation Monday to Wednesday', now: MON })).prefill.endDate, '2026-11-04', 'a range without a change verb still reads');
});

test('arrival partials carry side “arrive”; leaving ones carry no side', () => {
  assert.deepEqual(readPartial('coming in at 10am Monday'), { mode: 'start_day_only', hours: 2, side: 'arrive' });
  assert.deepEqual(readPartial('leaving at 2pm Friday'), { mode: 'start_day_only', hours: 3 });
});

test('changesDay (whole message, ruling): a change word anywhere + “X to Y” days → no dates (HR asks)', async () => {
  for (const text of [
    "I'm sick, not coming in Monday to Wednesday", 'I need time off. Please change it, Friday to Monday', 'Move Thursday and Friday to Monday and Tuesday',
    'Not Friday, Monday to Wednesday',
    // Reverted (were plain ranges in the previous round): a change word elsewhere in the message still makes HR ask.
    "out Nov 9 to Nov 11, I'll move office hours online", 'conference Monday to Wednesday, not vacation', "I'm not well, out Monday to Wednesday",
  ]) assert.equal((await readRequest({ text, now: MON })).prefill.beginDate, '', text);
});

test('readRequest end to end: "Off Nov 6, 4 hours, personal holiday" is a 4-hour partial day', async () => {
  const r = await readRequest({ text: 'I need time off: Off Nov 6, 4 hours, personal holiday', now: MON });
  assert.equal(r.prefill.absenceName, 'Personal Holiday');
  assert.equal(r.prefill.beginDate, '2026-11-06');
  assert.equal(r.prefill.endDate, '2026-11-06');
  assert.deepEqual(r.partial, { mode: 'start_day_only', hours: 4 });
  assert.deepEqual(r.missing, []);
});

// ---- live mode: a child process (HR_MODE is read at import) against the fake Anthropic API ----------
let stub;
before(async () => { stub = await startFakeAnthropic(); });
after(async () => { await stub?.close(); });

async function live(text, modelJson, { status = 200 } = {}) {
  stub.reset();
  stub.respondWith(() => (status === 200 ? messageReply(JSON.stringify(modelJson)) : { status }));
  const code = `import { chooseAbsence } from './src/hr-model.js'; const ev = []; const r = await chooseAbsence({ text: ${JSON.stringify(text)}, emit: (t, d) => ev.push(t) }); console.log(JSON.stringify({ r, ev }));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, env: { ...process.env, HR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' },
  });
  return JSON.parse(stdout);
}
const out = (o) => ({ absence_name: '', quote: '', relationship: '', note: '', ...o });

test('live: a valid choice is kept, request carries no sampling params and uses low effort', async () => {
  const { r, ev } = await live('My uncle died, I need Friday off', out({ absence_name: 'Bereavement/Funeral', quote: 'uncle died', relationship: 'Uncle', note: 'Back Monday' }));
  assert.equal(r.absenceName, 'Bereavement/Funeral');
  assert.equal(r.quote, 'uncle died');
  assert.equal(r.relationship, 'uncle');
  assert.equal(r.note, 'Back Monday');
  assert.deepEqual(ev, ['model_call_started', 'model_response_received']);
  const body = stub.requests[0].body;
  assert.equal(body.temperature, undefined);
  assert.equal(body.output_config.effort, 'low');
  const enumValues = body.output_config.format.schema.properties.absence_name.enum;
  assert.ok(enumValues.includes('') && enumValues.includes('Jury Duty'));
});

test('live: a name that is not on the list is dropped', async () => {
  const { r } = await live('My uncle died', out({ absence_name: 'Bereavement Leave', quote: 'uncle died' }));
  assert.equal(r.absenceName, '');
  assert.equal(r.quote, '');
});

test('live: a quote that is not in the words drops the name', async () => {
  const { r } = await live('I need Friday off', out({ absence_name: 'Bereavement/Funeral', quote: 'my uncle died' }));
  assert.equal(r.absenceName, '');
  assert.equal(r.quote, '');
});

test('live: a relationship that is not in the words is dropped', async () => {
  const { r } = await live('I am sick today', out({ absence_name: 'Sick – Self', quote: 'sick', relationship: 'sister' }));
  assert.equal(r.absenceName, 'Sick – Self');
  assert.equal(r.relationship, '');
});

test('live: a failed call returns an empty name and a sanitized code, never a guess', async () => {
  const { r, ev } = await live('I am sick today', null, { status: 429 });
  assert.equal(r.absenceName, '');
  assert.equal(r.error, 'rate_limited');
  assert.deepEqual(ev, ['model_call_started', 'model_call_failed']);
});

test('final fix 6: a month with a list of bare days reads every day, or asks — never a shorter span', () => {
  assert.deepEqual(readDates('Nov 5th and 6th', MON), { beginDate: '2026-11-05', endDate: '2026-11-06' });
  assert.deepEqual(readDates('Nov 5, 6 and 7', MON), { beginDate: '2026-11-05', endDate: '2026-11-07' });
  assert.deepEqual(readDates('out November 5th, 6th, and 7th', MON), { beginDate: '2026-11-05', endDate: '2026-11-07' });
  assert.equal(readDates('Nov 5 and 7', MON), null, 'not consecutive: ask instead of widening to Nov 5–7');
  assert.equal(readDates('Nov 5th and the 6th', MON), null, 'a day the reading can’t take is asked, not dropped');
  assert.deepEqual(readDates('Nov 5, 2026', MON), { beginDate: '2026-11-05', endDate: '2026-11-05' }, 'a year is not a day');
  assert.deepEqual(readDates('out Nov 5 and 2 students will cover', MON), null, 'a number after "and" that is not a day: asked');
});
