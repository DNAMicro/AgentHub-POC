// The Student's allowlist for received A2UI payloads (new forms and updates to them), and the
// shared validators every layer runs. Pure functions; no processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTutoringForm, buildStudyRoomForm, buildSlotUpdate, buildReviewUpdate, buildDelete, checkFormPayloadPolicy, checkFormUpdatePolicy,
  validateTutoringRequest, validateBooking, validateBookingCriteria, checkAction, todayIn, addDays, A2UI_VERSION,
} from '../src/forms.js';

const NOW = new Date('2026-10-26T18:00:00Z'); // Monday, 11:00 in America/Los_Angeles
const tutoring = () => buildTutoringForm('tutoring-request-test', { now: NOW });
const components = (payload) => payload[1].updateComponents.components;
const byId = (payload, id) => components(payload).find((c) => c.id === id);
const openUrl = { call: 'openUrl', args: { url: 'https://attacker.example' } };

test('both registered forms pass the allowlist', () => {
  assert.equal(checkFormPayloadPolicy(tutoring()), null);
  assert.equal(checkFormPayloadPolicy(buildStudyRoomForm('study-room-booking-test', { now: NOW })), null);
});

test('rejects disallowed function calls hidden anywhere in the payload', () => {
  const cases = {
    'inside a check condition': (p) => byId(p, 'email').checks.push({ condition: { call: 'or', args: { values: [openUrl, true] } }, message: 'x' }),
    'as a bound text value': (p) => { byId(p, 'title').text = openUrl; },
    'inside an action context': (p) => { byId(p, 'submit_button').action.event.context.firstName = openUrl; },
    'a formatter that isn’t on the list': (p) => { byId(p, 'title').text = { call: 'formatString', args: { value: 'x' } }; },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const payload = tutoring();
    tamper(payload);
    assert.match(checkFormPayloadPolicy(payload) ?? '', /not allowed/, name);
  }
});

test('rejects actions that are not exactly a server event', () => {
  const both = tutoring();
  byId(both, 'submit_button').action.functionCall = openUrl;
  assert.ok(checkFormPayloadPolicy(both), 'event + functionCall');
  const local = tutoring();
  byId(local, 'submit_button').action = { functionCall: openUrl };
  assert.ok(checkFormPayloadPolicy(local), 'functionCall only');
});

test('rejects other components, catalogs, and surface shapes', () => {
  const image = tutoring();
  components(image).push({ id: 'img', component: 'Image', url: 'https://attacker.example/x.png' });
  assert.match(checkFormPayloadPolicy(image), /Image/);
  const catalog = tutoring();
  catalog[0].createSurface.catalogId = 'https://attacker.example/catalog.json';
  assert.match(checkFormPayloadPolicy(catalog), /basic catalog/);
  assert.match(checkFormPayloadPolicy([...tutoring(), ...buildTutoringForm('second-surface', { now: NOW })]), /exactly one createSurface/);
  const mismatched = tutoring();
  mismatched[2].updateDataModel.surfaceId = 'other-surface';
  assert.match(checkFormPayloadPolicy(mismatched), /same surface/);
  // A new form can't carry a removal; removal is only valid as an update to an existing form.
  assert.match(checkFormPayloadPolicy([...tutoring(), ...buildDelete('tutoring-request-test')]), /Unsupported A2UI message/);
  assert.ok(checkFormPayloadPolicy([]), 'empty');
  assert.ok(checkFormPayloadPolicy({ not: 'an array' }), 'not an array');
});

test('updates: slot options, review screen and removal are allowed for that form only; never a new surface', () => {
  const id = 'study-room-booking-test';
  assert.equal(checkFormUpdatePolicy(buildSlotUpdate(id, [{ slotId: 'slot-abcd1234', label: '14:00–15:00' }], 'note'), id), null);
  assert.equal(checkFormUpdatePolicy(buildReviewUpdate(id, ['Room: A']), id), null);
  assert.equal(checkFormUpdatePolicy(buildDelete(id), id), null);
  assert.match(checkFormUpdatePolicy(buildDelete('another-form'), id), /same surface/);
  assert.match(checkFormUpdatePolicy(buildStudyRoomForm(id, { now: NOW }), id), /Unsupported A2UI message: createSurface/);
  const sneaky = buildReviewUpdate(id, ['x']);
  sneaky[0].updateComponents.components.push({ id: 'v', component: 'Video', url: 'https://attacker.example' });
  assert.match(checkFormUpdatePolicy(sneaky, id), /Video/);
});

test('tutoring request validation: names, email, date range and weekdays, period/time consistency, notes', () => {
  const today = todayIn(NOW); // 2026-10-26, a Monday
  const ok = { firstName: ' Alex ', lastName: 'Student', email: 'alex@example.com', preferredDate: addDays(today, 2), period: ['afternoon'], specificTime: '14:30', notes: 'Chain rule' };
  const good = validateTutoringRequest(ok, { now: NOW });
  assert.equal(good.ok, true);
  assert.equal(good.values.firstName, 'Alex', 'trimmed');
  assert.equal(good.values.period, 'afternoon');
  const bad = (patch) => validateTutoringRequest({ ...ok, ...patch }, { now: NOW }).errors ?? {};
  assert.ok(bad({ firstName: '   ' }).firstName, 'whitespace-only name');
  assert.ok(bad({ email: 'alex@' }).email);
  assert.ok(bad({ preferredDate: addDays(today, -1) }).preferredDate, 'past');
  assert.ok(bad({ preferredDate: addDays(today, 61) }).preferredDate, 'too far ahead');
  assert.match(bad({ preferredDate: '2026-10-31' }).preferredDate, /Monday–Friday/, 'Saturday');
  assert.ok(bad({ preferredDate: '2026-02-30' }).preferredDate, 'not a real date');
  assert.ok(bad({ period: [] }).period);
  assert.ok(bad({ period: ['morning', 'afternoon'] }).period, 'one choice only');
  assert.ok(bad({ period: ['evening'] }).period);
  assert.match(bad({ period: ['morning'], specificTime: '14:30' }).specificTime, /Morning means before 12:00/);
  assert.match(bad({ specificTime: '18:00' }).specificTime, /09:00–17:00/);
  assert.equal(validateTutoringRequest({ ...ok, specificTime: '' }, { now: NOW }).values.specificTime, null, 'specific time optional');
  assert.ok(bad({ notes: '  ' }).notes, 'notes required');
  assert.match(validateTutoringRequest({ ...ok, admin: true }, { now: NOW }).errors._form, /Unexpected field/);
});

test('booking validation: range, rooms, durations, capacity; slot IDs must look like the Library’s', () => {
  const today = todayIn(NOW);
  const crit = { date: addDays(today, 1), room: ['room-b'], duration: ['60'], groupSize: '5' };
  assert.equal(validateBookingCriteria(crit, { now: NOW }).ok, true);
  assert.match(validateBookingCriteria({ ...crit, groupSize: '7' }, { now: NOW }).errors.groupSize, /holds up to 6/);
  assert.ok(validateBookingCriteria({ ...crit, date: addDays(today, 15) }, { now: NOW }).errors.date);
  assert.ok(validateBookingCriteria({ ...crit, room: ['room-z'] }, { now: NOW }).errors.room);
  assert.ok(validateBookingCriteria({ ...crit, duration: ['90'] }, { now: NOW }).errors.duration);
  assert.match(validateBookingCriteria({ ...crit, firstName: 'Alex' }, { now: NOW }).errors._form, /Unexpected/, 'a lookup carries scheduling fields only');
  const full = { firstName: 'Sam', lastName: 'Student', email: 'sam@example.com', ...crit, slot: ['slot-abcd1234'] };
  assert.equal(validateBooking(full, { now: NOW }).ok, true);
  assert.ok(validateBooking({ ...full, slot: [] }, { now: NOW }).errors.slot);
  assert.ok(validateBooking({ ...full, slot: ['javascript:alert(1)'] }, { now: NOW }).errors.slot);
});

test('actions: only the workflow’s own actions, from their own buttons, with their own fields', () => {
  const surfaceId = 'study-room-booking-x';
  const msg = (name, button, context = {}) => ({ version: A2UI_VERSION, action: { name, surfaceId, sourceComponentId: button, context } });
  assert.equal(checkAction(msg('checkAvailability', 'check_button', { date: 'x' }), { workflowId: 'study-room-booking', surfaceId }).ok, true);
  assert.match(checkAction(msg('submitTutoringRequest', 'submit_button'), { workflowId: 'study-room-booking', surfaceId }).error, /Unknown action/);
  assert.match(checkAction(msg('confirmStudyRoomBooking', 'review_button'), { workflowId: 'study-room-booking', surfaceId }).error, /own button/);
  assert.match(checkAction(msg('checkAvailability', 'check_button', { email: 'x' }), { workflowId: 'study-room-booking', surfaceId }).error, /Unexpected field/);
  assert.match(checkAction(msg('checkAvailability', 'check_button'), { workflowId: 'study-room-booking', surfaceId: 'other' }).error, /different form/);
});
