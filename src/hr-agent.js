// HR Agent — a separate A2A service for university STAFF (a DEMO with synthetic records, not a real HR
// system). One skill: a time-off request. From the staff member's words it fills the card it can
// (absence name proposed by the model or the labelled mock heuristic and checked by code; dates, partial
// days and hours by code only), runs the Forecast (src/leave-rules.js) and sends ONE editable A2UI card
// inside an A2A task. Submit files the request in PeopleSoft and says it was recorded — there
// is no manager approval (owner, 2026-11-04) and nothing is deducted.
//
// Part 15: the records live in PeopleSoft (a DEMO STAND-IN reached over MCP, src/hr-peoplesoft.js). HR keeps
// no copy: it fetches the balances when it issues a card (and for a balance question), lists filed requests
// through PeopleSoft, and files on Submit. HR's AI chooses the PeopleSoft tool at each moment; code accepts
// only the moment's own tool and builds the arguments. HR keeps the leave rules (src/leave-rules.js) so the
// card's Forecast needs no call per edit; PeopleSoft re-checks everything when it files.
//
// Staff only: the caller must be a staff member the Hub signed for this request (hubLink.verifiedStaff).
// Never from the model, the words, or a bare metadata field. Students never reach HR through the Hub;
// anything unsigned is refused here as well.
//
// Open cards are in memory only; POST /dev/hr/reset (the classroom reset) resets PeopleSoft's records to the
// sample and closes every open card.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Role, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { createSkillService } from './agent-settings.js';
import { loadSpecialistConfig } from './config.js';
import { createHubLink } from './hub-link.js';
import { apiHost, keyEnvName, useModel } from './llm.js';
import { A2UI_EXTENSION_URI, A2UI_MIME_TYPE, BASIC_CATALOG_ID, WORKFLOWS, buildTimeOffForm, checkTimeOffValues, hhmm, isA2uiPart, validateFinal } from './forms.js';
import { createFormHost } from './form-host.js';
import { createPeopleSoftLink } from './hr-peoplesoft.js';
import { planAbsence } from './leave-rules.js';
import { TIMEOUTS } from './timeouts.js';
import { CREDIT_LABEL, PROOF, STANDARD_DAY, daysText, defaultReason, isPair, nameOf, shortDate, spreadOf, titleOf, whenText, workdays } from './absence-types.js';
import { asksBalance, asksRequests, dayReferences, mentionedDays, mentionsDay, mentionsHours, readPartial, readRequest } from './hr-intent.js';
import { familyCare, hrStatus, reasonForRelative, selfSick } from './hr-model.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const VIZ_PATH = '/viz/events';
const CONFIG = loadSpecialistConfig('hr');
useModel(CONFIG.model); // HR's own model and key variable (live mode: the absence name only)
let hubLink = null;
const MAX_LEDGER = 500;

const log = (...args) => console.log('[HR Agent]', ...args);
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'hr', type, runId, at: new Date().toISOString(), data });
const textOf = (message) => message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

const WORKFLOW_ID = 'staff-time-off';
const HR_RULES = { answer: { knowledge: 'optional' }, form: { ids: [WORKFLOWS[WORKFLOW_ID].skillId] } };
export const HR_DEFAULT_SKILLS = {
  skills: [{
    id: 'staff-time-off', kind: 'form', enabled: true, name: 'Staff time off',
    description: 'Fills a time-off request (demo, synthetic records) from what a staff member says: absence name, dates, hours and the balance it uses. The staff member checks it and submits; it is recorded in PeopleSoft.',
    tags: ['time off', 'absence', 'leave', 'vacation', 'sick', 'bereavement'],
    examples: ['My grandmother passed away, I need this Thursday and Friday', 'I need Friday off'],
    scope: { allowed: ['time-off requests from university staff'], excluded: ['students', 'payroll', 'approving requests'] },
    knowledge: '',
  }],
};
// Offered when the words give nothing to go on: the names that use his three leave balances.
const DEFAULT_CHOICES = ['VAC', 'SCK', 'PHL'];
// Fixed wording (owner-approved card copy).
const TEXT = {
  refused: 'HR serves university staff only.',
  disabled: 'Time-off requests aren’t offered by the HR Agent right now.',
  noClient: 'I can fill in a time-off card, but your client didn’t declare A2UI v0.9 support, so I can’t show it.',
  intro: 'Check it and submit.',
  noName: 'What kind of time off is this? If none of these fit, pick from the dropdown below.',
  receipt: 'Recorded in PeopleSoft.',
  badHours: 'These hours don’t fit the dates.', // same words as validateTimeOff (src/forms.js)
};
const SORRY = 'I\'m sorry for your loss. ';
// The lead line (approved mockup): no name yet → ask for it; otherwise kind words by type + reason, then
// “Check it and submit.”
const leadOf = (type, reason) => {
  if (!type) return TEXT.noName;
  if (type === 'BRV' || (type === 'SCK' && reason === 'BRV') || (type === 'OTH' && (reason === '30' || reason === '40'))) return `${SORRY}${TEXT.intro}`;
  if (type === 'SCK' && reason === 'SCK') return `Feel better soon. ${TEXT.intro}`; // Sick Personal only
  return TEXT.intro;
};
const QUESTIONS = {
  absenceReason: 'Which reason fits? Pick it on the card or tell me here.',
  dates: 'Which day or days?',
};
const REASON_QUESTION = { BRV: 'Who in your family is it for?' };
const WORKDAY_START = 8 * 60; // an arrival partial: the day starts at 08:00 (hr-intent.js)

// PeopleSoft (demo stand-in): its URL and the per-start token that only HR and PeopleSoft hold (never logged).
const PEOPLESOFT_URL = process.env.PEOPLESOFT_URL ?? 'http://127.0.0.1:41246';
// One MCP call: > PeopleSoft's planner inside it; tool choice + this call < the Hub's staff-action wait (src/timeouts.js).
const peoplesoft = createPeopleSoftLink({ url: PEOPLESOFT_URL, token: process.env.PEOPLESOFT_TOKEN, emit: emitViz, timeoutMs: Number(process.env.PEOPLESOFT_TIMEOUT_MS ?? TIMEOUTS.hrPeopleSoftCallMs) });
// Fixed wording. Submit, PeopleSoft down or not confirming (Part 15 global constraints):
export const PEOPLESOFT_UNAVAILABLE = 'PeopleSoft didn\'t answer. Nothing is filed until it confirms — press Submit again; it won\'t file twice.';
// Balance / requests questions in the chat:
export const PEOPLESOFT_UNAVAILABLE_CHAT = 'PeopleSoft didn\'t answer, so I can\'t show your leave right now. Nothing changed — ask again in a moment.';
const TOOL_REFUSED_CHAT = 'HR\'s AI didn\'t choose the right PeopleSoft tool, so I can\'t show your leave right now. Nothing changed — ask again in a moment.';
// The card's notice when it has no balances, by why:
const NO_BALANCES = 'PeopleSoft didn\'t answer, so the balance isn\'t shown.';
const TOOL_REFUSED_BALANCES = 'HR\'s AI didn\'t choose the balance tool, so the balance isn\'t shown.';
// Submit when HR's AI chose another tool: nothing was called, so nothing was filed (definite, not stored).
const TOOL_REFUSED_SUBMIT = 'Nothing was filed — HR\'s AI chose the wrong PeopleSoft tool. Press Submit again.';
// HR's AI didn't answer the tool choice (timeout, rate limit, provider error, no key): nothing was called. Not a wrong pick.
const CHOICE_FAILED_SUBMIT = 'HR\'s AI couldn\'t choose a PeopleSoft tool just now, so nothing was filed. Press Submit again.';
const CHOICE_FAILED_BALANCES = 'HR\'s AI couldn\'t choose a PeopleSoft tool just now, so the balance isn\'t shown.';
const CHOICE_FAILED_CHAT = 'HR\'s AI couldn\'t reach PeopleSoft just now, so I can\'t show your leave. Nothing changed — ask again in a moment.';
// A chat answer that failed, by why: HR's AI (wrong pick / no answer) or PeopleSoft.
const chatFailure = (outcome) => (outcome === 'tool_refused' ? [TOOL_REFUSED_CHAT, 'tool_refused'] : outcome === 'tool_choice_failed' ? [CHOICE_FAILED_CHAT, 'tool_choice_failed'] : [PEOPLESOFT_UNAVAILABLE_CHAT, 'peoplesoft_unavailable']);
// The person the leave rules need, from PeopleSoft's balances (null balances: no credit is checked here).
const personOf = (balances) => ({ standardHours: STANDARD_DAY, balances: balances ?? {} });
let skillService = null;
const workflowEnabled = () => skillService.policy().skills.some((s) => s.id === WORKFLOWS[WORKFLOW_ID].skillId);

const hoursWord = (n) => `${Number(Number(n).toFixed(2))} ${n === 1 ? 'hour' : 'hours'}`;
const validType = (type) => (type && nameOf(type) ? type : ''); // plan() accepts any type: check it first
// Total hours for N workdays from a partial read in the words (store shape { mode, hours }).
const totalOf = (days, partial) => {
  if (partial?.mode === 'all_days') return partial.hours * days;
  if (partial?.mode === 'start_day_only') return partial.hours + STANDARD_DAY * (days - 1);
  return STANDARD_DAY * days;
};
// spreadOf's answer → the store's partial (null = full days).
const storePartial = (spread) => {
  if (spread.mode === 'one_day' || spread.mode === 'start_day_only') return { mode: 'start_day_only', hours: spread.first };
  if (spread.mode === 'all_days') return { mode: 'all_days', hours: spread.each };
  return null;
};
// The words' answer to the spread question. Anything else leaves it asking.
const FIRST_DAY_ONLY = /^\s*(?:(?:yes|yeah|no)[,.!]?\s+)?(?:(?:just|only)\s+)?(?:on\s+)?(?:the\s+)?first\s+day(?:\s+only)?(?:\s*,?\s*please)?\s*[.!]?\s*$/i;
const EACH_DAY = /^\s*(?:(?:yes|yeah|no)[,.!]?\s+)?(?:(?:the\s+)?same\s+(?:hours\s+)?)?(?:each|every)\s+day(?:\s*,?\s*please)?\s*[.!]?\s*$/i;
export const spreadAnswer = (text) => (FIRST_DAY_ONLY.test(String(text ?? '')) ? 'start_day_only' : EACH_DAY.test(String(text ?? '')) ? 'all_days' : null);

const missingOf = (v) => [
  ...(validType(v.absenceType) ? (isPair(v.absenceType, v.absenceReason) ? [] : ['absenceReason']) : ['absenceType']),
  ...(v.beginDate && v.endDate ? [] : ['dates']),
];

// Hours and spread for the card. state: { values, cardHours (number typed on the card, or null), partial (from the
// words, store shape, or null), mode (the words' spread choice, or null), startAt, side }.
// → { total, spread, partial } — spread is spreadOf's answer; total null without dates.
function spreadFor(state) {
  const { beginDate, endDate } = state.values;
  if (!beginDate || !endDate) return { total: null, spread: null, partial: null, days: [] };
  const days = workdays(beginDate, endDate);
  const total = state.cardHours ?? (days.length ? totalOf(days.length, state.partial) : null);
  if (!days.length || total == null) return { total, spread: { mode: 'invalid' }, partial: null, days };
  const spread = spreadOf(days.length, total, state.mode ?? state.partial?.mode ?? null);
  return { total, spread, partial: spread.mode === 'ask' || spread.mode === 'invalid' ? null : storePartial(spread), days };
}

// A problem with the dates themselves (the leave rules' own checks with full days), or null. A balance shortfall
// is not one: it depends on the hours (no type → no balance is checked).
function datesProblem(values) {
  const p = planAbsence(personOf(null), { absenceType: '', beginDate: values.beginDate, endDate: values.endDate, partial: null });
  return p.ok ? null : p.reason;
}

// Everything the card shows, worked out by code from the values, the leave rules' Forecast and the balances
// PeopleSoft gave for this card (state.balances; null when PeopleSoft didn't answer). Synchronous.
function cardFor(state) {
  const { values } = state;
  const type = validType(values.absenceType);
  const missing = missingOf(values);
  const { total, spread, partial, days } = spreadFor(state);
  let question = null;
  let problem = null;
  let plan = null;
  // Holiday boundaries, no workdays, too long: shown before any spread question (the hours can't fix those).
  const blocked = spread?.mode === 'ask' ? datesProblem(values) : null;
  if (blocked) problem = blocked;
  else if (spread?.mode === 'ask') {
    missing.push('spread');
    const first = total - STANDARD_DAY * (days.length - 1);
    question = `Is that ${hoursWord(first)} on ${shortDate(days[0])} and the rest in full, or ${hoursWord(total / days.length)} each day?`;
  } else if (spread) {
    // Without balances the rules still check dates and hours; the balance is left to PeopleSoft at Submit.
    plan = planAbsence(personOf(state.balances), { absenceType: state.balances ? type : '', beginDate: values.beginDate, endDate: values.endDate, partial });
    if (!plan.ok) problem = plan.reason;
    else if (spread.mode === 'invalid') problem = TEXT.badHours;
  }
  if (!problem && !state.balances) problem = state.noBalances ?? NO_BALANCES;
  // The clock is shown only while the first day is still the one the words described.
  const wordsFirst = state.partial?.mode === 'start_day_only' && ['one_day', 'start_day_only'].includes(spread?.mode) && spread.first === state.partial.hours;
  const startAt = wordsFirst ? state.startAt ?? null : null;
  const side = wordsFirst ? state.side ?? null : null;
  const when = spread && spread.mode !== 'invalid' && total != null ? whenText({ beginDate: values.beginDate, endDate: values.endDate, hours: total, spread, startAt, side }) : null;
  // A missing name is asked in the lead line itself; the first other missing field keeps its question.
  const first = missing.find((f) => f !== 'absenceType');
  if (first && first !== 'spread') question = first === 'absenceReason' ? REASON_QUESTION[type] ?? QUESTIONS.absenceReason : QUESTIONS[first];
  const credit = plan?.credit ? { type: plan.credit.type, label: CREDIT_LABEL[plan.credit.type], now: plan.credit.now, after: plan.credit.after } : null;
  const { title, subtitle } = type ? titleOf(type, values.absenceReason) : { title: 'Time off request', subtitle: null };
  const hrCard = {
    title, subtitle, when,
    why: state.quote && type ? `Picked from what you wrote: “${state.quote}”.` : null,
    intro: leadOf(type, values.absenceReason),
    question, problem, missing, credit,
    // No name: the names he can pick from (pills under the lead) — the words' choices, else his three leave balances.
    choices: type ? [] : (state.choices?.length ? state.choices : DEFAULT_CHOICES).map((t) => ({ type: t, name: nameOf(t) })),
    proof: PROOF[type] ?? null,
    balances: state.balances ? { ...state.balances } : null,
    spread: spread ?? null,
    startAt, side,
  };
  return { hrCard, hours: total };
}

const pick = (v) => (Array.isArray(v) ? v[0] ?? '' : v ?? '');
const dateOf = (v) => (typeof v === 'string' ? v.trim().slice(0, 10) : '');
const sameSpread = (a, b) => a && b && a.beginDate === b.beginDate && a.endDate === b.endDate && Number(a.hours) === Number(b.hours);

const formHost = createFormHost({
  agentId: 'hr',
  isEnabled: (workflowId) => (workflowId === WORKFLOW_ID ? workflowEnabled() : false),
  emitViz, log,
  // Leave details are sensitive: the name (some are health details, e.g. Pregnancy Disability), the reason (it can be a relationship) and the note never reach the server log.
  logValues: (v) => (v ? { ...v, absenceType: '[redacted]', absenceReason: '[redacted]', note: '[redacted]' } : v),
  workflows: {
    [WORKFLOW_ID]: {
      build: (surfaceId, { prefill, missing }) => buildTimeOffForm(surfaceId, { prefill, missing }),
      actions: {
        // Final: the staff member is re-checked against the Hub's signature on THIS request, then the code
        // checks, the spread and the Forecast; PeopleSoft files the record (idempotent by operation ID).
        async submitTimeOff(form, context, { operationId, runId, trusted, emit }) {
          if (hubLink.verifiedStaff(trusted, form.contextId) !== form.data.staffId) return { status: 'rejected', message: 'This request belongs to another staff member.', errors: { _form: 'This request belongs to another staff member.' } };
          const v = validateFinal(WORKFLOW_ID, context);
          if (!v.ok) return { status: 'rejected', message: 'Please correct the highlighted fields.', errors: v.errors };
          const values = { absenceType: pick(context.absenceType), absenceReason: pick(context.absenceReason), beginDate: dateOf(context.beginDate), endDate: dateOf(context.endDate), note: String(context.note ?? '').trim() };
          if (!nameOf(values.absenceType) || !isPair(values.absenceType, values.absenceReason)) return { status: 'rejected', message: 'Choose a reason.', errors: { absenceReason: 'Choose a reason.' } };
          const hours = Number(context.hours);
          // The words' spread choice counts only for the dates and hours it was made for.
          const decided = form.data.spread;
          const mode = sameSpread(decided, { ...values, hours }) ? decided.mode : null;
          const { spread, partial } = spreadFor({ values, cardHours: hours, partial: null, mode });
          const blocked = spread.mode === 'ask' ? datesProblem(values) : null;
          if (blocked) return { status: 'rejected', message: blocked, errors: { _form: blocked } };
          if (spread.mode === 'ask') {
            const days = workdays(values.beginDate, values.endDate);
            const q = `Is that ${hoursWord(hours - STANDARD_DAY * (days.length - 1))} on ${shortDate(days[0])} and the rest in full, or ${hoursWord(hours / days.length)} each day?`;
            return { status: 'rejected', message: q, errors: { hours: q } };
          }
          if (spread.mode === 'invalid') return { status: 'rejected', message: TEXT.badHours, errors: { hours: TEXT.badHours } };
          const staffId = form.data.staffId;
          // A New conversation (closeAll) may close the card while HR awaits its AI or PeopleSoft.
          const isClosed = () => form.state !== 'awaiting_input';
          // PeopleSoft files it (idempotent by operationId). Its steps are already stripped by the link. A card
          // closed meanwhile skips the call.
          const r = await peoplesoft.file(staffId, { absenceType: values.absenceType, absenceReason: values.absenceReason, beginDate: values.beginDate, endDate: values.endDate, partial }, operationId, { runId, isClosed });
          emit('hr_operation', { operation: 'submitTimeOff', ok: r.ok, code: r.ok ? 'recorded' : r.code ?? r.outcome });
          // Closed while the call ran (or before it): the card stays closed with its own words — never accepted. A
          // record PeopleSoft wrote before its reset is gone with that reset; one that started after it is refused
          // there (reset_during_call).
          if (isClosed()) return { status: 'rejected', message: form.closedMessage ?? 'This card is closed.', errors: { _form: form.closedMessage ?? 'This card is closed.' } };
          if (r.outcome === 'refused') return { status: 'rejected', message: r.reason, errors: { _form: r.reason } };
          // Not filed, or not known to be filed: the card stays open and the same operationId may be sent again
          // (retryable: no layer keeps this answer, so a second Submit reaches PeopleSoft, which files once).
          // HR's AI chose another tool, or didn't answer: nothing was called — a definite rejection, still not stored.
          if (r.outcome === 'tool_refused') return { status: 'rejected', message: TOOL_REFUSED_SUBMIT, errors: { _form: TOOL_REFUSED_SUBMIT }, retryable: true };
          if (r.outcome === 'tool_choice_failed') return { status: 'rejected', message: CHOICE_FAILED_SUBMIT, errors: { _form: CHOICE_FAILED_SUBMIT }, retryable: true };
          if (!r.ok) return { status: 'rejected', message: PEOPLESOFT_UNAVAILABLE, errors: { _form: PEOPLESOFT_UNAVAILABLE }, retryable: true, unknownOutcome: true };
          const { receipt } = r.value;
          log('recorded time-off request', { requestId: receipt.requestId, recordId: receipt.recordId, hours: receipt.hours, status: receipt.status });
          return { status: 'accepted', message: TEXT.receipt, receipt: { ...receipt, demo: true, note: 'Demo request — synthetic HR records.' } };
        },
        async cancelForm(form, context, { trusted }) {
          if (hubLink.verifiedStaff(trusted, form.contextId) !== form.data.staffId) return { status: 'rejected', message: 'This request belongs to another staff member.', errors: { _form: 'This request belongs to another staff member.' } };
          return { status: 'cancelled', message: 'Cancelled. Nothing was recorded.' };
        },
      },
    },
  },
});

const reply = (ctx, text, metadata) => ({
  messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT,
  parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata, extensions: [], referenceTaskIds: [],
});

// Balance and request questions are answered as plain text from PeopleSoft: no card, nothing filed, no model
// call about the words (HR's AI only chooses the PeopleSoft tool).
const BALANCE_WORDS = { sick: 'sick leave', vacation: 'vacation', personalHoliday: 'personal holiday' };
const hoursText = (h) => `${h} ${h === 1 ? 'hour' : 'hours'}`;
export function balanceText(balances, which) {
  const keys = which === 'all' ? ['sick', 'vacation', 'personalHoliday'] : [which];
  return keys.map((k) => `You have ${daysText(balances[k])} (${hoursText(balances[k])}) of ${BALANCE_WORDS[k]}.`).join('\n');
}
export function requestsText(list) {
  if (!list.length) return 'You have no time-off requests.';
  return list.map((r) => {
    const { subtitle } = titleOf(r.absenceType, r.absenceReason);
    const dates = r.beginDate === r.endDate ? shortDate(r.beginDate) : `${shortDate(r.beginDate)} to ${shortDate(r.endDate)}`;
    return `${r.requestId}: ${r.absenceName}${subtitle ? ` (${subtitle})` : ''}, ${dates}, ${hoursText(r.hours)} — recorded.`;
  }).join('\n');
}

const ledger = new Map(); // `${contextId}|${messageId}` → Promise<readRequest result>; a repeat reuses it (no second paid call)
function readOnce(ctx, text, runId) {
  const key = `${ctx.contextId}|${ctx.userMessage.messageId}`;
  if (ledger.has(key)) {
    emitViz('model_call_reused', runId, { contextId: ctx.contextId, messageId: ctx.userMessage.messageId });
    return ledger.get(key);
  }
  const promise = readRequest({ text, now: new Date(), emit: (type, data) => emitViz(type, runId, data) });
  ledger.set(key, promise);
  promise.catch(() => {});
  if (ledger.size > MAX_LEDGER) ledger.delete(ledger.keys().next().value);
  return promise;
}

// The clock for a partial read from the words: a leaving time is in readRequest's startAt; an arrival is
// 08:00 + hours ("until 10:00").
const clockOf = (partial, startAt) => (partial?.side === 'arrive' ? hhmm(WORKDAY_START + Math.round(partial.hours * 60)) : startAt ?? null);

// The reason the follow-up's OWN words establish for the CURRENT type (never a bare default): Bereavement → the
// speaker's relative; Sick Leave → Bereavement (the word, Task 4's rule), Family Care, or Sick Personal for a
// first-person sick clause.
function reasonFromWords(type, text, read) {
  if (type === 'BRV') return reasonForRelative(text);
  if (type === 'SCK') {
    if (read.prefill.absenceType === 'SCK' && read.prefill.absenceReason === 'BRV' && /\bbereavement\b/i.test(text)) return 'BRV';
    if (familyCare(text)) return 'FAM';
    if (selfSick(text)) return 'SCK';
  }
  return null;
}

// A chat message while this staff member's card is open fills that card. First the card as the staff member
// sees it now (cardValues: the browser's current values, checked — when sent they ARE the card, so a field
// cleared there is empty), then the words: non-empty values from the new words replace those. The card is
// re-issued in place (supersedes the open one).
const ADDITION = /\b(also|plus|as\s+well|too|add|another|extra)\b/i;
function merge(open, read, text, cardValues) {
  const before = open.data;
  const card = cardValues ? { absenceType: '', absenceReason: '', beginDate: '', endDate: '', note: '', ...cardValues } : { ...before.values };
  const typedHours = cardValues?.hours !== undefined ? Number(cardValues.hours) : null;
  delete card.hours;
  const values = { ...card };
  // The name: the words win. The reason, checked against the CURRENT name after every change: a reason the
  // follow-up's own words establish (Bereavement/Sick Leave: reasonFromWords; other names: the words' reason when
  // they named the name), the card's reason if it belongs to the name, the name's default, or empty (HR asks).
  // "actually make it sick leave" establishes no reason → '' (never Sick Personal guessed from the name).
  const wordsType = validType(read.prefill.absenceType);
  if (wordsType) values.absenceType = wordsType;
  const type = values.absenceType;
  const wordsReason = wordsType && wordsType !== 'SCK' && wordsType !== 'BRV' ? read.prefill.absenceReason : null;
  values.absenceReason = [wordsReason, reasonFromWords(type, text, read), card.absenceReason, defaultReason(type)].find((c) => c && isPair(type, c)) ?? '';
  for (const f of ['beginDate', 'endDate']) if (read.prefill[f]) values[f] = read.prefill[f];
  if (read.note) values.note = read.note;
  // Dates in a follow-up, fail safe (never extended, never guessed): an addition word with a day (“also Monday”, “add
  // Wednesday”) clears them; a return-day message that isn't the one clear shape clears them; dates read cleanly
  // replace them; a day that couldn't be read clears them; otherwise the card's dates stay.
  // Cleared dates make HR ask “Which day or days?”.
  const clearDates = () => { values.beginDate = ''; values.endDate = ''; };
  // A follow-up that names one of the card's CURRENT days together with other days (“Move Friday to Monday and
  // Tuesday”, “Not Friday, Monday and Tuesday”, “Switch it from Friday to Monday”) is a change we can't read safely.
  const said = mentionedDays(text);
  const namesCardDay = card.beginDate && [...said].some((d) => d >= card.beginDate && d <= card.endDate);
  const namesOtherDay = card.beginDate && [...said].some((d) => d < card.beginDate || d > card.endDate);
  if (ADDITION.test(text) && mentionsDay(text)) clearDates();
  else if (namesCardDay && namesOtherDay) clearDates();
  else if (read.datesUnclear) clearDates();
  else if (!read.prefill.beginDate && mentionsDay(text)) clearDates();

  // Hours. Dates changed by the words → full days (unless the words also give hours for them).
  const datesKept = values.beginDate === card.beginDate && values.endDate === card.endDate;
  const cardDatesAsBefore = card.beginDate === before.values.beginDate && card.endDate === before.values.endDate;
  // The hours TYPED on the card go with the card's CURRENT dates (even dates moved on the card) unless the words
  // set the dates themselves; spreadOf/plan then ask or refuse — they are never silently replaced by full days.
  const cardHours = datesKept && typedHours !== null ? typedHours : null;
  // The words' earlier spread choice holds only while the hours are the ones it was made for.
  const sameHours = cardHours === null || cardHours === before.hours;
  const kept = datesKept && cardDatesAsBefore
    ? { cardHours: cardHours ?? before.cardHours ?? null, partial: sameHours ? before.partial : null, mode: sameHours ? before.mode : null, startAt: before.startAt, side: before.side }
    : { cardHours, partial: null, mode: null, startAt: null, side: null };
  const answer = spreadAnswer(text);
  if (answer) return { values, ...kept, mode: answer, quote: quoteOf(read, values, before) };
  if (mentionsHours(text)) {
    // A real hour signal: its one clear value, or else full days — the old value is never kept.
    let partial = null;
    let startAt = null;
    if (read.partial && read.prefill.beginDate === values.beginDate && read.prefill.endDate === values.endDate) ({ partial, startAt } = read);
    else if ((!values.beginDate || values.beginDate === values.endDate) && dayReferences(text) <= 1) partial = readPartial(text);
    return { values, cardHours: null, partial, mode: partial?.mode ?? null, startAt: clockOf(partial, startAt), side: partial?.side ?? null, quote: quoteOf(read, values, before) };
  }
  return { values, ...kept, quote: quoteOf(read, values, before) };
}
// “Picked from what you wrote …” only while the name is still the one those words chose.
const quoteOf = (read, values, before) => (validType(read.prefill.absenceType) ? read.quote : values.absenceType === before.values.absenceType ? before.quote : null);

const hrExecutor = {
  async execute(ctx, bus) {
    const incoming = ctx.userMessage;
    const runId = incoming.metadata?.runId ?? null;
    const a2ui = incoming.parts.find(isA2uiPart);
    if (a2ui) return formHost.handleAction(ctx, bus, runId, a2ui);
    const text = textOf(incoming).slice(0, 2000);
    const received = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId };
    log('received message', { ...received, text: `[${text.length} chars, content not logged]` });
    emitViz('message_received', runId, { ...received, text });
    const metadata = { ...(runId ? { runId } : {}), agentId: 'hr' };
    const send = (value, outcome) => {
      const message = reply(ctx, value, { ...metadata, hr: { outcome } });
      bus.publish(AgentEvent.message(message));
      bus.finished();
      log('sending reply', { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: incoming.messageId, outcome });
      emitViz('reply_published', runId, { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: incoming.messageId, text: value, outcome, hrOutcome: outcome, hr: { outcome } });
    };

    // The Hub's signature on THIS request says who the staff member is. Nothing else does.
    const staffId = hubLink.verifiedStaff(incoming.metadata, ctx.contextId);
    if (!staffId) return send(TEXT.refused, 'refused');
    // PeopleSoft knows the staff: one balances call per message, used for the check, a balance answer and the card.
    const bal = await peoplesoft.balances(staffId, { runId });
    if (bal.outcome === 'refused' && bal.code === 'unknown_staff') return send(TEXT.refused, 'refused');
    const balances = bal.ok ? { vacation: bal.value.vacation, sick: bal.value.sick, personalHoliday: bal.value.personalHoliday } : null;
    if (!workflowEnabled()) return send(TEXT.disabled, 'workflow_disabled');
    // A question about balances or filed requests: text only. An open card stays open and unchanged.
    const whichBalance = asksBalance(text);
    const wantsRequests = asksRequests(text);
    if (whichBalance || wantsRequests) {
      if (!balances) return send(...chatFailure(bal.outcome));
      const parts = [];
      if (whichBalance) parts.push(balanceText(balances, whichBalance));
      if (wantsRequests) {
        const filed = await peoplesoft.requests(staffId, { runId });
        if (!filed.ok) return send(...chatFailure(filed.outcome));
        parts.push(requestsText(filed.value.requests));
      }
      return send(parts.join('\n'), whichBalance && wantsRequests ? 'info' : whichBalance ? 'balance' : 'requests');
    }
    if (!formHost.clientSupportsForms(incoming)) return send(TEXT.noClient, 'workflow_unsupported_client');

    const read = await readOnce(ctx, text, runId);
    const openId = formHost.openForm(ctx.contextId, WORKFLOW_ID);
    const open = openId ? formHost.form(openId) : null;
    const same = formHost.formForRequest(ctx); // a repeat of the request that made the open card
    const followUp = open && openId !== same && open.data.staffId === staffId;
    // The open card's current values, if the Professor sent them with this follow-up (checked again here).
    const cardValues = followUp && incoming.metadata?.formValues !== undefined ? checkTimeOffValues(incoming.metadata.formValues) : null;
    const state = followUp
      ? merge(open, read, text, cardValues?.ok ? cardValues.values : null)
      : {
        values: { ...read.prefill, absenceType: validType(read.prefill.absenceType), note: read.note ?? '' },
        cardHours: null, partial: read.partial, mode: read.partial?.mode ?? null,
        startAt: clockOf(read.partial, read.startAt), side: read.side ?? null, quote: read.quote,
      };
    // Choices when no single name fits: this message's, else the ones the open card already offered.
    state.choices = read.choices?.length ? read.choices : followUp ? open.data.choices ?? [] : [];
    if (!isPair(state.values.absenceType, state.values.absenceReason)) state.values.absenceReason = state.values.absenceType ? defaultReason(state.values.absenceType) ?? '' : '';
    state.balances = balances;
    // Why there are no balances: HR's AI (a wrong pick, or no answer) or PeopleSoft.
    state.noBalances = bal.outcome === 'tool_refused' ? TOOL_REFUSED_BALANCES : bal.outcome === 'tool_choice_failed' ? CHOICE_FAILED_BALANCES : NO_BALANCES;
    const { hrCard, hours } = cardFor(state);
    const prefill = Object.fromEntries(Object.entries({ ...state.values, hours }).filter(([, v]) => v !== '' && v != null));
    emitViz('request_read', runId, { followUp: Boolean(followUp), cardValues: Boolean(cardValues?.ok), prefilled: Object.keys(prefill), missing: hrCard.missing, outcome: hrCard.problem === state.noBalances && !balances ? 'no_balances' : hrCard.problem ? 'forecast_failed' : hrCard.missing.length ? 'missing' : 'ready', code: read.error ?? null });
    // The spread the words decided, kept with the card for the dates and hours it was decided for (Submit, follow-ups).
    const decided = state.mode && hours != null ? { beginDate: state.values.beginDate, endDate: state.values.endDate, hours, mode: state.mode } : null;
    formHost.issue(ctx, bus, {
      workflowId: WORKFLOW_ID, prefill, runId,
      intro: hrCard.question ? `${hrCard.intro} ${hrCard.question}` : hrCard.intro,
      supersedes: followUp ? openId : null,
      buildOptions: { missing: hrCard.missing },
      data: { staffId, values: state.values, hours, cardHours: state.cardHours, partial: state.partial, mode: state.mode, startAt: state.startAt, side: state.side, quote: state.quote, choices: state.choices, spread: decided },
      extra: { hrCard, hr: { outcome: 'card' } },
    });
  },
  async cancelTask() {},
};

function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ source: 'hr', type: 'status', runId: null, at: new Date().toISOString(), data: { ...hrStatus(), skills: skillService?.describe() ?? null } })}\n\n`);
  // A follower that connects after the link's startup warm-up still learns the session's current state.
  const session = peoplesoft.sessionStatus();
  if (session) res.write(`data: ${JSON.stringify({ source: 'hr', type: 'peoplesoft_session', runId: null, at: session.at, data: (({ at, ...d }) => d)(session) })}\n\n`);
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

function buildAgentCard(port) {
  return {
    name: 'HR Agent',
    description: 'Staff time-off requests (demo, synthetic records): fills the request from what a staff member says, checks the balance, and records it in PeopleSoft. University staff only.',
    version: '0.1.0',
    supportedInterfaces: [{ url: `http://${HOST}:${port}${JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }],
    provider: undefined,
    capabilities: {
      streaming: false, pushNotifications: false,
      extensions: [{ uri: A2UI_EXTENSION_URI, description: 'Sends A2UI v0.9 surfaces (basic catalog) and accepts A2UI actions.', required: false, params: { supportedCatalogIds: [BASIC_CATALOG_ID], acceptsInlineCatalogs: false } }],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain', A2UI_MIME_TYPE],
    defaultOutputModes: ['text/plain', A2UI_MIME_TYPE, 'application/json'],
    skills: [],
    signatures: [],
  };
}

export function startHrServer({ port = 41245 } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      const baseUrl = `http://${HOST}:${actualPort}`;
      const card = buildAgentCard(actualPort);
      skillService = createSkillService({
        agentId: 'hr', agentName: card.name, defaults: HR_DEFAULT_SKILLS, rules: HR_RULES, card,
        emit: (type, data) => emitViz(type, null, data), log, notify: (n) => hubLink.notifyCardChanged(n),
      });
      hubLink = createHubLink({
        agentId: CONFIG.agentId, hubUrl: CONFIG.hub.url, endpoint: `${baseUrl}${JSONRPC_PATH}`, cardUrl: `${baseUrl}/${AGENT_CARD_PATH}`,
        enabled: CONFIG.enabled, heartbeatIntervalMs: CONFIG.heartbeatIntervalMs, log,
        emit: (type, data) => emitViz(type, null, data),
      });
      const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), hrExecutor);
      app.use(hostGuard(actualPort));
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.get(VIZ_PATH, serveVizEvents);
      app.use(skillService.router());
      // Demo reset (the classroom reset, asked by the Hub): PeopleSoft's staff, balances and requests back to the
      // sample. Server callers only — a cross-site browser POST is refused.
      app.post('/dev/hr/reset', sameOriginGuard(actualPort), async (req, res) => {
        ledger.clear();
        // A card opened before the reset can't be submitted into the fresh records (closed even if PeopleSoft
        // didn't answer, so no old card files later).
        const closed = formHost.closeAll('This card was closed when the HR records were reset. Ask again for a new card.');
        const r = await peoplesoft.reset();
        log('HR records reset to the starting sample', { closedCards: closed, peoplesoft: r.ok ? 'reset' : 'unavailable' });
        if (!r.ok) return res.status(502).json({ status: 'failed', peoplesoft: 'unavailable' });
        res.json({ status: 'reset' });
      });
      // Test hook only: PeopleSoft's records (its own test hook), in today's shape.
      if (process.env.HR_TEST_HOOKS === '1') {
        app.get('/test/hr/requests', async (req, res) => {
          try {
            res.json({ requests: await peoplesoft.records() });
          } catch {
            res.status(502).json({ error: 'peoplesoft_unavailable' });
          }
        });
      }
      skillService.started(actualPort, `${baseUrl}/${AGENT_CARD_PATH}`);
      hubLink.start(); // retries until the Hub accepts the registration
      resolve({ server, baseUrl, hubLink });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT === undefined ? 41245 : Number(process.env.PORT);
  const { baseUrl } = await startHrServer({ port });
  // Sign out from the Hub on shutdown (best effort; the Hub's heartbeat expiry covers a crash).
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      // Best effort, bounded: sign out from the Hub and end the PeopleSoft MCP session (terminate, then close).
      await Promise.race([Promise.allSettled([hubLink?.stop(), peoplesoft.close()]), new Promise((r) => setTimeout(r, 800))]);
      process.exit(0);
    });
  }
  log(`listening on ${baseUrl}`);
  peoplesoft.warm(); // open the MCP session now (no tool call) so the pill is right after a restart
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const s = hrStatus();
  log(`mode: ${s.mode} (${s.model})${s.mode === 'live' ? `, API key (${keyEnvName()}): ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}, staff only, synthetic records`);
  log(`PeopleSoft (demo stand-in, MCP): ${PEOPLESOFT_URL}/mcp, token (PEOPLESOFT_TOKEN): ${process.env.PEOPLESOFT_TOKEN ? 'configured' : 'NOT SET'}`);
}
