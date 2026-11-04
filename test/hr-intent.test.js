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
import { chooseAbsence, hrStatus, reasonForRelative, verify } from '../src/hr-model.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 2026-11-02 is a Monday; noon UTC is the same calendar day in every US time zone the demo uses.
const MON = new Date('2026-11-02T17:00:00Z');
const TUE = new Date('2026-11-03T17:00:00Z');
// An arrival partial (hours missed before arriving) carries side 'arrive'.
const arrive = (hours) => ({ mode: 'start_day_only', hours, side: 'arrive' });

test('readDates: a weekday right before its date is one day (“Friday Nov 6”); a weekday that disagrees is asked', () => {
  const span = (b, e) => ({ beginDate: b, endDate: e });
  assert.deepEqual(readDates('I need vacation Friday Nov 6', TUE), span('2026-11-06', '2026-11-06'));
  assert.deepEqual(readDates('I need vacation Friday, Nov 6', TUE), span('2026-11-06', '2026-11-06'));
  assert.deepEqual(readDates('I need vacation from Friday Nov 6 to Monday Nov 9', TUE), span('2026-11-06', '2026-11-09'));
  assert.deepEqual(readDates('I need vacation from Tuesday Nov 10 to Thursday Nov 12', TUE), span('2026-11-10', '2026-11-12'));
  assert.deepEqual(readDates('out Thursday Nov 5 and Friday Nov 6', TUE), span('2026-11-05', '2026-11-06'));
  assert.deepEqual(readDates('off Friday 11/13', TUE), span('2026-11-13', '2026-11-13'), 'the date wins over this week’s Friday');
  // Nov 7 is a Saturday: never a guess, with or without the comma.
  assert.equal(readDates('I need vacation Friday Nov 7', TUE), null);
  assert.equal(readDates('I need vacation Friday, Nov 7', TUE), null);
});

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

test('mock chooseAbsence: labelled heuristic proposes a pair; code verifies it and picks BRV/SCK reasons', async () => {
  const r = await chooseAbsence({ text: 'My grandmother passed away' });
  assert.equal(r.absenceType, 'BRV');
  assert.equal(r.absenceReason, 'GGP');
  assert.equal(r.quote, 'grandmother passed away');
  assert.match(r.model, /mock heuristic/);
  assert.equal(hrStatus().mode, 'mock');
  const self = await chooseAbsence({ text: 'I am sick, need Friday off' });
  assert.deepEqual([self.absenceType, self.absenceReason], ['SCK', 'SCK']);
  const fam = await chooseAbsence({ text: 'My mother is sick, out Tuesday' });
  assert.deepEqual([fam.absenceType, fam.absenceReason], ['SCK', 'FAM']);
  for (const [text, type, reason] of [
    ['jury duty on Monday', 'JRY', 'JRY'], ['going to a conference', 'PDL', 'PDL'], ['a personal holiday please', 'PHL', 'PHL'],
    ['taking a vacation', 'VAC', 'VAC'], ['I need Friday off', '', ''],
  ]) {
    const c = await chooseAbsence({ text });
    assert.deepEqual([c.absenceType, c.absenceReason], [type, reason], text);
  }
  const none = await chooseAbsence({ text: 'I need Friday off' });
  assert.equal(none.quote, '');
});

test('grandmother maps to GGP', () => {
  assert.equal(reasonForRelative('my grandmother passed away'), 'GGP');
  assert.equal(reasonForRelative('my great-grandfather died'), 'GGP');
  assert.equal(reasonForRelative('my granddaughter'), 'AGC', 'not "daughter"');
  assert.equal(reasonForRelative('my grandson'), 'AGC', 'not "son"');
});

test('mother-in-law before mother', () => {
  assert.equal(reasonForRelative("my mother-in-law's funeral"), 'PIL');
  assert.equal(reasonForRelative('my stepfather-in-law died'), 'PIL');
  assert.equal(reasonForRelative('my son-in-law died'), 'CIL');
  assert.equal(reasonForRelative('my sister-in-law died'), 'SBS');
  assert.equal(reasonForRelative('my mother died'), 'PSP');
  assert.equal(reasonForRelative('my stepmother died'), 'PSP');
});

test('reasonForRelative: the fixed map; no relative or two different relatives → null', () => {
  for (const [text, code] of [
    ['my son', 'ASD'], ['our kid', 'ASD'], ['my aunt', 'AUN'], ['my uncle', 'AUN'], ['my wife', 'SDP'], ['my husband', 'SDP'],
    ['my partner', 'SDP'], ['my brother', 'SBS'], ['my cousin', 'OTH'], ['my niece', 'OTH'], ['my nephew', 'OTH'], ['my dad', 'PSP'],
  ]) assert.equal(reasonForRelative(text), code, text);
  for (const text of ['I need Friday off for a funeral', 'person and reason', 'kidding', 'childcare', 'my mother and my aunt died']) assert.equal(reasonForRelative(text), null, text);
});

test('cousin maps to Other', async () => {
  const c = await chooseAbsence({ text: 'my cousin passed away' });
  assert.equal(c.absenceType, 'BRV');
  assert.equal(c.absenceReason, 'OTH', 'Other — never a closer-looking relative');
});

test('funeral with no relative leaves reason empty', async () => {
  const c = await chooseAbsence({ text: 'I need Friday off for a funeral' });
  assert.deepEqual([c.absenceType, c.absenceReason], ['BRV', '']);
  const r = await readRequest({ text: 'I need Friday off for a funeral', now: MON });
  assert.deepEqual(r.prefill, { absenceType: 'BRV', absenceReason: '', beginDate: '2026-11-06', endDate: '2026-11-06' });
  assert.deepEqual(r.missing, ['absenceReason'], 'the reason is asked for, never guessed');
});

test('sick with my son is family care', async () => {
  const c = await chooseAbsence({ text: 'My son is sick, I need Friday off' });
  assert.deepEqual([c.absenceType, c.absenceReason], ['SCK', 'FAM']);
  const r = await readRequest({ text: 'My son is sick, I need Friday off', now: MON });
  assert.deepEqual(r.missing, []);
});

test('Sick Leave is Family Care only when the relative is tied to the illness or the care', async () => {
  const sck = (text, quote) => verify(text, { pair: 'SCK:SCK', quote, note: '' }).absenceReason;
  assert.equal((await chooseAbsence({ text: "I'm sick, my partner will cover class" })).absenceReason, 'SCK', 'a relative merely mentioned');
  assert.equal(sck("I'm sick, my partner will cover class", 'sick'), 'SCK');
  assert.equal((await chooseAbsence({ text: 'my son is sick, I need to stay home with him Friday' })).absenceReason, 'FAM');
  assert.equal(sck("I'm taking care of my mother tomorrow", 'taking care of'), 'FAM', 'the model/mock chose SCK; code ties the care to the relative');
  assert.equal(verify("I'm taking care of my mother tomorrow", { pair: 'SCK:FAM', quote: 'taking care of', note: '' }).absenceReason, 'FAM');
  assert.equal(sck("I have a doctor's appointment, my wife will drive me", 'appointment'), 'SCK', 'the appointment clause has no relative');
  assert.equal((await chooseAbsence({ text: "I have a doctor's appointment, my wife will drive me" })).absenceReason, 'SCK');
  assert.equal(sck("my daughter's fever, out Friday", 'fever'), 'FAM');
  assert.equal(sck('looking after my dad Friday', 'looking after'), 'FAM');
  assert.equal(sck('I am sick and my kids are fine', 'sick'), 'SCK');
});

test('verify: type must exist and the quote must be in the words; reasons by code', () => {
  const v = (text, pair, quote = text) => { const r = verify(text, { pair, quote, note: '' }); return [r.absenceType, r.absenceReason]; };
  assert.deepEqual(v('my uncle died', 'BRV:GGP', 'uncle died'), ['BRV', 'AUN'], 'BRV reason from the words, not the model');
  assert.deepEqual(v('a funeral', 'BRV:GGP', 'funeral'), ['BRV', ''], 'no relative named: empty');
  assert.deepEqual(v('I am sick', 'SCK:FAM', 'sick'), ['SCK', 'SCK'], 'no relative: Sick Personal (never the model’s FAM)');
  assert.deepEqual(v('my daughter is sick', 'SCK:SCK', 'sick'), ['SCK', 'FAM']);
  assert.deepEqual(v('sick leave for bereavement', 'SCK:BRV', 'bereavement'), ['SCK', 'BRV']);
  assert.deepEqual(v('I am sick', 'SCK:BRV', 'sick'), ['SCK', 'SCK'], 'SCK:BRV only when the words say bereavement');
  assert.deepEqual(v('taking a vacation', 'VAC:WTS', 'vacation'), ['VAC', 'WTS'], 'another type: the model’s reason when it is a real pair');
  assert.deepEqual(v('taking a vacation', 'VAC:GGP', 'vacation'), ['VAC', 'VAC'], 'not a pair: the default reason');
  assert.deepEqual(v('a training day', 'OTH:99', 'training'), ['OTH', '10']);
  assert.deepEqual(v('jury', 'XXX:JRY', 'jury'), ['', ''], 'unknown type');
  assert.deepEqual(v('I need Friday off', 'VAC:VAC', 'vacation'), ['', ''], 'quote not in the words');
  assert.deepEqual(v('I need Friday off', 'VAC:VAC', ''), ['', ''], 'empty quote');
});

test('readRequest: combines the reading and lists what is still missing', async () => {
  const r = await readRequest({ text: 'My grandmother passed away, I need Thursday and Friday off', now: MON });
  assert.deepEqual(r.prefill, { absenceType: 'BRV', absenceReason: 'GGP', beginDate: '2026-11-05', endDate: '2026-11-06' });
  assert.equal(r.quote, 'grandmother passed away');
  assert.equal(r.partial, null);
  assert.equal(r.startAt, null);
  assert.equal(r.side, null);
  assert.deepEqual(r.missing, []);

  const m = await readRequest({ text: 'I need Friday off', now: MON });
  assert.equal(m.prefill.absenceType, '');
  assert.equal(m.prefill.beginDate, '2026-11-06');
  assert.deepEqual(m.missing, ['absenceType'], 'no type: the reason is not asked separately');

  const d = await readRequest({ text: 'I am sick', now: MON });
  assert.deepEqual(d.missing, ['dates']);

  const p = await readRequest({ text: 'I was sick yesterday afternoon', now: TUE });
  assert.equal(p.prefill.beginDate, '2026-11-02');
  assert.equal(p.partial.hours, 4);
  assert.equal(p.startAt, null, '“afternoon” says no leaving time');
  assert.equal(p.prefill.hours, undefined, 'the store computes hours');

  const leave = await readRequest({ text: "I'm sick, leaving at 2pm Friday", now: MON });
  assert.deepEqual([leave.partial, leave.startAt, leave.side], [{ mode: 'start_day_only', hours: 3 }, '14:00', null]);
  const early = await readRequest({ text: 'leaving 2 hours early Friday', now: MON });
  assert.equal(early.startAt, '15:00');
  const arr = await readRequest({ text: 'coming in at 10am Monday', now: TUE });
  assert.deepEqual([arr.partial, arr.startAt, arr.side], [{ mode: 'start_day_only', hours: 2, side: 'arrive' }, null, 'arrive']);
});

// ---- part days over several days (R1-strict) ------------------------------------------------------
// The partial day's hours follow Rule A as before: leaving at noon = 17:00 − 12:00 = 5 hours.
test('noon Thursday out Friday is start day only', async () => {
  const r = await readRequest({ text: "I'm not feeling well, I'm leaving at noon on Thursday and I'll be out Friday", now: TUE });
  assert.equal(r.prefill.beginDate, '2026-11-05');
  assert.equal(r.prefill.endDate, '2026-11-06');
  assert.deepEqual(r.partial, { mode: 'start_day_only', hours: 5 });
  assert.equal(r.startAt, '12:00');
  assert.equal(r.side, null);
  assert.deepEqual([r.prefill.absenceType, r.prefill.absenceReason], ['SCK', 'SCK']);
  assert.deepEqual(r.missing, []);
  const early = await readRequest({ text: "Leaving 2 hours early Thursday and I won't be in Friday", now: TUE });
  assert.deepEqual([early.partial, early.startAt, early.prefill.endDate], [{ mode: 'start_day_only', hours: 2 }, '15:00', '2026-11-06']);
  const late = await readRequest({ text: 'Coming in at 10am Thursday, out Friday', now: TUE });
  assert.deepEqual([late.partial, late.startAt, late.side], [{ mode: 'start_day_only', hours: 2, side: 'arrive' }, null, 'arrive']);
  // Friday then Monday: the weekend between is no gap.
  const fm = await readRequest({ text: 'Leaving at 3pm Friday and out Monday', now: TUE });
  assert.deepEqual([fm.prefill.beginDate, fm.prefill.endDate, fm.partial?.hours], ['2026-11-06', '2026-11-09', 2]);
});

test('leaving at noon today and out tomorrow: the same first-day shape (today is the first day)', async () => {
  // Not pinned by any earlier test; the earlier pinned case has no day in the cue clause (below) and stays null.
  const r = await readRequest({ text: 'leaving at noon today and out tomorrow', now: MON });
  assert.deepEqual([r.prefill.beginDate, r.prefill.endDate, r.partial, r.startAt], ['2026-11-02', '2026-11-03', { mode: 'start_day_only', hours: 5 }, '12:00']);
  const pinned = await readRequest({ text: "I'm sick, leaving at noon, and out tomorrow too", now: MON });
  assert.equal(pinned.partial, null);
});

test('first-day part day: anything else is full days (null)', async () => {
  for (const text of [
    'out Thursday and Friday, leaving at noon Friday', // the cue is on the LAST day
    'leaving at noon Friday and out Thursday', // the cue's day is not the first
    'leaving at noon Thursday and at 3 Friday', // two cues
    'leaving at noon Thursday and Friday', // Friday is not said to be "out"
    "leaving at noon Thursday but I won't be out Friday", // negated
    'leaving at noon Thursday and out Monday', // a gap (Friday)
    'leaving at noon Tuesday Nov 10 and out Wednesday', // Nov 11 is a holiday: not two workdays
    'leaving at noon Thursday and out Friday, maybe', // correction word
    'leaving at noon Thursday and out Friday, sorry 1pm', // a number after the cue
    'My kid is sick, leaving 2 hours early Thursday and out Friday', // someone else's leaving
    'students leave at noon Thursday and I am out Friday', // not the professor's time
    'out this afternoon and tomorrow', // pinned (N1): “tomorrow” alone is not said to be out
  ]) {
    const r = await readRequest({ text, now: TUE });
    assert.equal(r.partial, null, text);
    assert.equal(r.startAt, null, text);
  }
});

test('two cues over two days gives full days', async () => {
  const r = await readRequest({ text: 'leaving at noon Thursday and at 3 Friday', now: TUE });
  assert.equal(r.partial, null);
  assert.ok(!r.missing.includes('absenceReason'));
});

test('four hours each day', async () => {
  const r = await readRequest({ text: '4 hours each day Mon to Wed next week', now: TUE });
  assert.equal(r.prefill.beginDate, '2026-11-09');
  assert.equal(r.prefill.endDate, '2026-11-11');
  assert.deepEqual(r.partial, { mode: 'all_days', hours: 4 });
  assert.equal(r.startAt, null);
  const a = await readRequest({ text: '4 hours a day next Mon to Wed', now: TUE });
  assert.deepEqual([a.prefill.beginDate, a.prefill.endDate, a.partial], ['2026-11-09', '2026-11-11', { mode: 'all_days', hours: 4 }]);
  for (const [text, hours] of [['Out Mon to Wed next week, 4.5 hours per day', 4.5], ['three hours every day Thursday and Friday', 3], ['I need 2 hours off each day Thursday and Friday', 2]]) {
    assert.deepEqual((await readRequest({ text, now: TUE })).partial, { mode: 'all_days', hours }, text);
  }
  // "next week" read on a Monday too: the following week, never today.
  assert.equal((await readRequest({ text: '4 hours each day Mon to Wed next week', now: MON })).prefill.beginDate, '2026-11-09');
});

test('“N hours a day” only when explicit, in a range, and alone', async () => {
  for (const text of [
    '4 hours each day Friday', // one day
    '8 hours each day Thursday and Friday', // a full day
    'I work 4 hours a day, out Thursday and Friday', // about work, not the absence
    'not 4 hours a day, Thursday and Friday', // negated
    '4 hours each day Thursday and Friday, leaving at noon', // another cue
    '4 hours each day Thursday and Friday, or maybe 3', // correction
    '4 hours Thursday and Friday', // not "each day"
  ]) assert.notEqual((await readRequest({ text, now: TUE })).partial?.mode, 'all_days', text);
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
  assert.deepEqual([r.prefill.absenceType, r.prefill.absenceReason], ['PHL', 'PHL']);
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
const out = (o) => ({ pair: '', quote: '', note: '', ...o });

test('live: a valid choice is kept, request carries no sampling params and uses low effort', async () => {
  const { r, ev } = await live('My uncle died, I need Friday off', out({ pair: 'BRV:AUN', quote: 'uncle died', note: 'Back Monday' }));
  assert.equal(r.absenceType, 'BRV');
  assert.equal(r.absenceReason, 'AUN');
  assert.equal(r.quote, 'uncle died');
  assert.equal(r.note, 'Back Monday');
  assert.deepEqual(ev, ['model_call_started', 'model_response_received']);
  const body = stub.requests[0].body;
  assert.equal(body.temperature, undefined);
  assert.equal(body.output_config.effort, 'low');
  const enumValues = body.output_config.format.schema.properties.pair.enum;
  assert.equal(enumValues.length, 52, 'the 51 pairs and ""');
  assert.ok(enumValues.includes('') && enumValues.includes('JRY:JRY') && enumValues.includes('BRV:GGP'));
  assert.deepEqual(Object.keys(body.output_config.format.schema.properties).sort(), ['choices', 'note', 'pair', 'quote']);
  assert.equal(body.output_config.format.schema.properties.choices.items.enum.length, 34, 'choices: the 34 names only');
  assert.match(body.system, /BRV:GGP = Bereavement — Grandparent\/Great Grandparent/);
});

test('live: grandmother funeral — the reason comes from the words, never from the model', async () => {
  const { r } = await live('My grandmother’s funeral is Friday', out({ pair: 'BRV:SDP', quote: 'funeral' }));
  assert.deepEqual([r.absenceType, r.absenceReason], ['BRV', 'GGP']);
  const none = (await live('I need Friday off for a funeral', out({ pair: 'BRV:GGP', quote: 'funeral' }))).r;
  assert.deepEqual([none.absenceType, none.absenceReason], ['BRV', ''], 'no relative named: empty, never the model’s pick');
  const fam = (await live('I am sick, out Friday', out({ pair: 'SCK:FAM', quote: 'sick' }))).r;
  assert.deepEqual([fam.absenceType, fam.absenceReason], ['SCK', 'SCK'], 'no relative named: Sick Personal');
});

test('live: a pair that is not on the list is dropped', async () => {
  const { r } = await live('My uncle died', out({ pair: 'BEREAVEMENT:AUN', quote: 'uncle died' }));
  assert.equal(r.absenceType, '');
  assert.equal(r.absenceReason, '');
  assert.equal(r.quote, '');
});

test('live: a quote that is not in the words drops the name', async () => {
  const { r } = await live('I need Friday off', out({ pair: 'BRV:AUN', quote: 'my uncle died' }));
  assert.equal(r.absenceType, '');
  assert.equal(r.absenceReason, '');
  assert.equal(r.quote, '');
});

test('live: a failed call returns an empty name and a sanitized code, never a guess', async () => {
  const { r, ev } = await live('I am sick today', null, { status: 429 });
  assert.equal(r.absenceType, '');
  assert.equal(r.absenceReason, '');
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

// ---- fix round 2 (strict review): each of these was a wrong non-null reading; R1 says null / '' instead ------
const days = async (text) => { const r = await readRequest({ text, now: TUE }); return [r.prefill.beginDate, r.prefill.endDate]; };

test('C1: "next week" in another clause does not move the days', async () => {
  for (const [text, b, e] of [
    ["I'm sick Friday, next week I'm back", '2026-11-06', '2026-11-06'],
    ['sick Friday, next week is fine', '2026-11-06', '2026-11-06'],
    ["out Friday, next week I'll be in", '2026-11-06', '2026-11-06'],
    ['out Thursday, next week we have exams', '2026-11-05', '2026-11-05'],
    ['out Thu and Fri, next week the TA covers', '2026-11-05', '2026-11-06'],
  ]) assert.deepEqual(await days(text), [b, e], text);
  const too = await readRequest({ text: 'out Thursday and Friday, next week too', now: TUE });
  assert.deepEqual([too.prefill.beginDate, too.prefill.endDate], ['', ''], 'more days next week: no dates (HR asks)');
  assert.ok(too.missing.includes('dates'));
  // Still read: "next week" right after or right before the day list.
  assert.deepEqual(await days('Mon to Wed next week'), ['2026-11-09', '2026-11-11']);
  assert.deepEqual(await days('next week, Mon to Wed'), ['2026-11-09', '2026-11-11']);
});

test('C2: the first-day shape needs the SPEAKER to be the one out on the other days', async () => {
  for (const text of [
    "I'm leaving at noon on Thursday and my TA is out Friday", 'leaving at noon Thursday and my wife is out Friday',
    'leaving at noon Thursday and the students are off Friday', 'leaving at noon Thursday; Friday the class is off',
    'leaving at noon Thursday and we are off Friday',
  ]) {
    const r = await readRequest({ text, now: TUE });
    assert.equal(r.partial, null, text);
    // Two day references the plain reader can't join: no dates (HR asks), as before this task.
    assert.deepEqual([r.prefill.beginDate, r.prefill.endDate], ['', ''], text);
  }
  assert.equal((await readRequest({ text: "leaving at noon Thursday and I'll be out Friday", now: TUE })).partial?.mode, 'start_day_only');
  assert.equal((await readRequest({ text: "leaving at noon Thursday and I'm off Friday", now: TUE })).partial?.mode, 'start_day_only');
});

test('C3: only the speaker’s own relative gives a Bereavement reason', async () => {
  for (const text of [
    "my friend's mother passed away, funeral Friday", "my colleague's son died, funeral Friday", "my neighbor's husband passed away, funeral Friday",
    "a student's father died, funeral Friday", "my son's teacher passed away, funeral Friday", "my kid's friend died, funeral Friday",
  ]) {
    const r = await readRequest({ text, now: TUE });
    assert.deepEqual([r.prefill.absenceType, r.prefill.absenceReason], ['BRV', ''], text);
    assert.ok(r.missing.includes('absenceReason'), text);
  }
  for (const [text, code] of [
    ["my mother's funeral is Friday", 'PSP'], ["grandma's funeral Friday", 'GGP'], ['funeral for my late husband Friday', 'SDP'],
    ["my stepdaughter's funeral Friday", 'ASD'],
  ]) assert.equal((await readRequest({ text, now: TUE })).prefill.absenceReason, code, text);
});

test('C4: “N hours a day” with a purpose, a non-day tail or an estimate is not the absence', async () => {
  for (const text of [
    '4 hours a day for meetings Thursday and Friday', 'I need 4 hours a day for meetings Thursday and Friday',
    'for 4 hours a day Thursday and Friday the students will be in lab', '2 hours each day of class Thursday and Friday',
    'out 2 hours each day of class Thursday and Friday', 'about 4 hours a day Thursday and Friday',
  ]) assert.equal((await readRequest({ text, now: TUE })).partial, null, text);
});

test('I5: a first-person sick clause, or a relative who is not ill or cared for by the speaker, is Sick Personal', async () => {
  for (const text of [
    "I'm sick Friday so my partner is taking care of the kids", "I'm sick Friday, my mom is looking after my son",
    "I'm ill Friday, my husband's appointment is moved", "my sister is a doctor, I'm sick Friday",
    "I'm sick Friday, my dad's hospital called to say he's fine",
  ]) {
    assert.equal(verify(text, { pair: 'SCK:FAM', quote: text.match(/sick|ill/)[0], note: '' }).absenceReason, 'SCK', text);
    assert.equal((await readRequest({ text, now: TUE })).prefill.absenceReason, 'SCK', text);
  }
});

test('I6: a condition on the other day means no first-day shape', async () => {
  assert.equal((await readRequest({ text: 'leaving at noon Thursday and out Friday if my flight is delayed', now: TUE })).partial, null);
});

test('I7: spaced in-law and step forms', () => {
  assert.equal(reasonForRelative('my mother in law'), 'PIL');
  assert.equal(reasonForRelative('my sister in law died'), 'SBS');
  assert.equal(reasonForRelative('my step mother died'), 'PSP');
  assert.equal(reasonForRelative('my step mother in law died'), 'PIL');
  for (const t of ['', 'nobody', "a friend's aunt"]) assert.equal(reasonForRelative(t), null, 'string or null, never undefined');
});

test('minor: half day over two days is ambiguous; “c’mon” is not Monday', async () => {
  assert.equal((await readRequest({ text: 'half day Thursday and Friday off', now: TUE })).partial, null);
  assert.deepEqual(await days("c'mon, I'm sick Friday"), ['2026-11-06', '2026-11-06']);
  assert.deepEqual(await days('cmon, I’m sick Friday'), ['2026-11-06', '2026-11-06']);
});

test('asksBalance / asksRequests: only the professor’s own leave questions fire (fix round 1)', async () => {
  const { asksBalance, asksRequests } = await import('../src/hr-intent.js');
  const yes = { 'how much sick leave do I have?': 'sick', "what's my vacation balance": 'vacation', 'my leave balances': 'all', 'how many vacation days do I have left': 'vacation', 'how many sick days do I have': 'sick', "what's my PTO balance": 'all', 'how many personal holiday days do I have left?': 'personalHoliday' };
  for (const [t, kind] of Object.entries(yes)) assert.equal(asksBalance(t), kind, t);
  for (const t of ['show my time off requests', 'list my time off requests', 'what time off have I requested', 'which leave have I filed']) assert.equal(asksRequests(t), true, t);
  const no = ['@alex how many days do you have left to submit the homework?', '@alex your balance is low, how many days do you have left?', '@alex please check your balance on the library account', '@alex show my requests',
    "I'm sick, how many days do I have left?", "I'm out sick next week, how many days do I have", "how many days do I have left? I'm sick and need time off", 'I feel sick, how many hours do I have left, need to leave early',
    "my vacation balance is low so I'll take unpaid leave", "what have I submitted for the grant? and I'm sick", 'how many days are left in the semester', 'how many hours do I have left to grade? I\'m out',
    'the balance of the exam: how many hours do students have left', 'how many days of leave do students have left', 'show my requests for the room booking', 'what have I filed for grading',
    'I need Friday off', 'file time off for my vacation', 'show my requests', 'what have I filed', 'how much vacation do I have left before Friday'];
  for (const t of no) { assert.equal(asksBalance(t), null, t); assert.equal(asksRequests(t), false, t); }
});
test('asksBalance: “sick balance” is a sick-leave question; “I’m sick” alone still is not (live run 2026-11-03)', async () => {
  const { asksBalance } = await import('../src/hr-intent.js');
  for (const t of ["What's my sick balance?", 'What’s my sick balance?', 'my sick leave balance', 'how much sick balance do I have left']) assert.equal(asksBalance(t), 'sick', t);
  for (const t of ["I'm sick, what's my balance?", 'I feel sick, how much balance do I have'] ) assert.equal(asksBalance(t), null, t);
});

// ---- final review fixes ------------------------------------------------------------------------------------
test('final: taking my relative to the doctor is Family Care; an unconfirmed FAM proposal is empty, never SCK', async () => {
  for (const text of ['I am taking my son to the doctor on Friday', 'I need to take my mom to her doctor appointment Friday']) {
    const r = await readRequest({ text, now: TUE });
    assert.deepEqual([r.prefill.absenceType, r.prefill.absenceReason], ['SCK', 'FAM'], text);
  }
  assert.equal(verify('I have a thing Friday', { pair: 'SCK:FAM', quote: 'thing', note: '' }).absenceReason, '', 'HR asks');
  assert.equal(verify('I am sick Friday', { pair: 'SCK:FAM', quote: 'sick', note: '' }).absenceReason, 'SCK', 'the speaker is sick');
  assert.equal(verify('I have a thing Friday', { pair: 'SCK:SCK', quote: 'thing', note: '' }).absenceReason, 'SCK', 'SCK:SCK stays');
  assert.equal(verify('my wife is taking my son to the doctor Friday', { pair: 'SCK:FAM', quote: 'doctor', note: '' }).absenceReason, '', 'someone else takes him');
});

test('final: a relative word counts only after my/our (+ late, dear, younger, …) or at the start of a clause', async () => {
  for (const text of ['my research partner passed away', 'my business partner died', 'my sorority sister passed away', 'the father of my wife died']) {
    const r = await readRequest({ text, now: TUE });
    assert.deepEqual([r.prefill.absenceType, r.prefill.absenceReason], ['BRV', ''], text);
  }
  for (const [text, code] of [
    ['my late husband passed away', 'SDP'], ['my younger brother died', 'SBS'], ["my mother's funeral is Friday", 'PSP'], ["grandma's funeral Friday", 'GGP'],
  ]) assert.equal((await readRequest({ text, now: TUE })).prefill.absenceReason, code, text);
});

test('“half a day” and “half of the day” read as 4 hours, like “half day” (user report 2026-11-03)', async () => {
  for (const t of ['taking half a day', 'out for half a day Friday', 'off half of the day Friday', 'I need half a day off']) {
    assert.equal(readPartial(t)?.hours, 4, t);
  }
  const r = await readRequest({ text: 'I need to file for a leave to take my kid to school next Tuesday for half a day', now: TUE });
  assert.equal(r.prefill.beginDate, '2026-11-10');
  assert.equal(r.partial?.hours, 4);
  assert.equal((await readRequest({ text: 'half a day Thursday and Friday off', now: TUE })).partial, null, 'which day? ambiguous');
});

// ---- choices when no single name fits (user rule 2026-11-03: offer the options he can pick from) ----
test('choices: a school visit offers Vacation, Personal Holiday and Dock; a name that is chosen offers none', () => {
  const c = (text, choices = []) => verify(text, { pair: '', quote: '', note: '', choices }).choices;
  assert.deepEqual(c('take my kid to school next Tuesday for half a day'), ['VAC', 'PHL', 'DCK']);
  assert.deepEqual(c("parent-teacher conference Friday"), ['VAC', 'PHL', 'DCK']);
  assert.deepEqual(c('I need Friday off'), [], 'nothing to go on: no choices from code (HR adds its defaults)');
  assert.deepEqual(c('a family thing Friday', ['PHL', 'VAC', 'NOPE', 'VAC', 'PTO', 'DCK']), ['PHL', 'VAC', 'PTO'], 'model choices: real names only, no repeats, at most 3');
  assert.deepEqual(verify('my vacation Friday', { pair: 'VAC:VAC', quote: 'vacation', note: '', choices: ['PHL'] }).choices, [], 'a picked name needs no choices');
  assert.deepEqual(c('my kid is sick at school', ['SCK']), ['SCK'], 'a sick child is not a school visit: the model choice stays');
});

test('choices: readRequest carries them (mock) and live keeps only real names', async () => {
  const r = await readRequest({ text: 'I need to file for a leave to take my kid to school next Tuesday for half a day', now: TUE });
  assert.equal(r.prefill.absenceType, '');
  assert.deepEqual(r.choices, ['VAC', 'PHL', 'DCK']);
  const { r: l } = await live('a family thing on Friday', out({ choices: ['PHL', 'XYZ', 'VAC'] }));
  assert.equal(l.absenceType, '');
  assert.deepEqual(l.choices, ['PHL', 'VAC']);
});
