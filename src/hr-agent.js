// HR Agent — a separate A2A service for university STAFF (a DEMO with synthetic records, not a real HR
// system). One skill: a time-off request. From the staff member's words it fills the card it can
// (absence name proposed by the model or the labelled mock heuristic and checked by code; dates, partial
// days and hours by code only), runs the Forecast (src/hr-store.js) and sends ONE editable A2UI card
// inside an A2A task. Submit records the request in memory and says it was sent to the manager — there
// is no manager simulation and nothing is deducted.
//
// Staff only: the caller must be a staff member the Hub signed for this request (hubLink.verifiedStaff).
// Never from the model, the words, or a bare metadata field. Students never reach HR through the Hub;
// anything unsigned is refused here as well.
//
// In memory only: staff, balances, requests and open cards reset when the process restarts (and on
// POST /dev/hr/reset, the classroom reset: records back to the sample, every open card closed).
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
import { A2UI_EXTENSION_URI, A2UI_MIME_TYPE, BASIC_CATALOG_ID, RELATIONSHIP_REQUIRED, WORKFLOWS, buildTimeOffForm, checkTimeOffValues, isA2uiPart, validateFinal } from './forms.js';
import { createFormHost } from './form-host.js';
import { createHrStore, shortDate } from './hr-store.js';
import { dayReferences, mentionedDays, mentionsDay, mentionsHours, readPartial, readRequest } from './hr-intent.js';
import { hrStatus, readRelationship } from './hr-model.js';

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
    description: 'Fills a time-off request (demo, synthetic records) from what a staff member says: absence name, dates, hours and the balance it uses. The staff member checks it and submits; it is sent to their manager for a decision.',
    tags: ['time off', 'absence', 'leave', 'vacation', 'sick', 'bereavement'],
    examples: ['My grandmother passed away, I need this Thursday and Friday', 'I need Friday off'],
    scope: { allowed: ['time-off requests from university staff'], excluded: ['students', 'payroll', 'approving requests'] },
    knowledge: '',
  }],
};

// Fixed wording (owner-approved card copy).
const TEXT = {
  refused: 'HR serves university staff only.',
  disabled: 'Time-off requests aren’t offered by the HR Agent right now.',
  noClient: 'I can fill in a time-off card, but your client didn’t declare A2UI v0.9 support, so I can’t show it.',
  intro: 'Here\'s your request. Check it and submit.',
  receipt: 'Sent to your manager for a decision.',
  noCredits: 'This doesn\'t use your vacation or sick hours.',
};
const INTRO_PREFIX = { 'Bereavement/Funeral': 'I\'m sorry for your loss. ', 'Sick – Bereavement': 'I\'m sorry for your loss. ', 'Sick – Self': 'Feel better soon. ' };
const QUESTIONS = {
  absenceName: 'What kind of time off is this — for example vacation, sick, or a personal holiday?',
  dates: 'Which day or days?',
  relationship: 'Who in your family is it for?',
};

const store = createHrStore();
let skillService = null;
const workflowEnabled = () => skillService.policy().skills.some((s) => s.id === WORKFLOWS[WORKFLOW_ID].skillId);

const missingOf = (v) => [
  ...(v.absenceName ? [] : ['absenceName']),
  ...(v.beginDate && v.endDate ? [] : ['dates']),
  ...(RELATIONSHIP_REQUIRED.has(v.absenceName) && !v.relationship ? ['relationship'] : []),
];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const startTime = (hours) => {
  const mins = 17 * 60 - Math.round(hours * 60); // a partial first day ends at 17:00 (hr-intent.js)
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};
const endTime = (hours) => { // an arrival partial: the day starts at 08:00 (hr-intent.js)
  const mins = 8 * 60 + Math.round(hours * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

// Everything the card shows, worked out by code from the values (and the store's Forecast).
function cardFor(staffId, { values, partial, quote }) {
  const missing = missingOf(values);
  const hasDates = Boolean(values.beginDate && values.endDate);
  const plan = hasDates ? store.plan(staffId, { absenceName: values.absenceName, beginDate: values.beginDate, endDate: values.endDate, partial }) : null;
  let when = null;
  if (hasDates) {
    const range = values.beginDate === values.endDate ? shortDate(values.beginDate) : `${shortDate(values.beginDate)} – ${shortDate(values.endDate)}`;
    const days = plan?.days ?? store.workdays(values.beginDate, values.endDate).length;
    // An arrival partial is the time missed before arriving (“until 10:00”); otherwise the time from leaving (“from 15:00”).
    const span = partial?.side === 'arrive' ? `until ${endTime(partial.hours)}` : `from ${startTime(partial?.hours)}`;
    when = partial && plan?.hours ? `${range} · ${span} (${plural(plan.hours, 'hour')})` : days ? `${range} · ${plural(days, 'full day')}` : range;
  }
  const credit = plan?.credit ?? null;
  const question = missing.length ? QUESTIONS[missing[0]] : null;
  const hrCard = {
    title: values.absenceName || 'Time off request',
    when,
    why: quote && values.absenceName ? `Chosen because you said “${quote}”.` : null,
    intro: `${INTRO_PREFIX[values.absenceName] ?? ''}${TEXT.intro}`,
    balance: credit ? { type: credit.type, now: credit.now, after: credit.after } : null,
    note: !credit && values.absenceName && plan?.ok ? TEXT.noCredits : null,
    missing,
    question,
    problem: plan && !plan.ok ? plan.reason : null,
  };
  return { hrCard, hours: plan?.hours ?? null };
}

// The card's hours: the full days the store works out, or a shorter FIRST day (a partial day). Anything
// else is refused — hours never come from the browser unchecked.
function partialFromHours(staffId, values) {
  const full = store.plan(staffId, { ...values, absenceName: '', partial: null });
  if (!full.ok) return { error: full.reason };
  const std = store.staff(staffId).standardHours;
  const hours = Number(values.hours);
  if (hours === full.hours) return { partial: null };
  const first = std - (full.hours - hours);
  if (first > 0 && first < std) return { partial: { mode: 'start_day_only', hours: first } };
  return { error: `For these dates the hours are ${full.hours} (${plural(full.days, 'full day')}), or fewer only on the first day (more than ${full.hours - std}).` };
}
const pick = (v) => (Array.isArray(v) ? v[0] ?? '' : v ?? '');
const dateOf = (v) => (typeof v === 'string' ? v.trim().slice(0, 10) : '');

const formHost = createFormHost({
  agentId: 'hr',
  isEnabled: (workflowId) => (workflowId === WORKFLOW_ID ? workflowEnabled() : false),
  emitViz, log,
  // Leave type details are sensitive: the relationship and the note never reach the server log.
  logValues: (v) => (v ? { ...v, relationship: '[redacted]', note: '[redacted]' } : v),
  workflows: {
    [WORKFLOW_ID]: {
      build: (surfaceId, { prefill, missing }) => buildTimeOffForm(surfaceId, { prefill, missing }),
      actions: {
        // Final: the staff member is re-checked against the Hub's signature on THIS request, then the code
        // checks, the Forecast and the record (store.submit is synchronous and idempotent by operation ID).
        async submitTimeOff(form, context, { operationId, trusted, emit }) {
          if (hubLink.verifiedStaff(trusted, form.contextId) !== form.data.staffId) return { status: 'rejected', message: 'This request belongs to another staff member.', errors: { _form: 'This request belongs to another staff member.' } };
          const v = validateFinal(WORKFLOW_ID, context);
          if (!v.ok) return { status: 'rejected', message: 'Please correct the highlighted fields.', errors: v.errors };
          const values = { absenceName: pick(context.absenceName), beginDate: dateOf(context.beginDate), endDate: dateOf(context.endDate), relationship: String(context.relationship ?? '').trim(), note: String(context.note ?? '').trim() };
          const staffId = form.data.staffId;
          const h = partialFromHours(staffId, { ...values, hours: context.hours });
          if (h.error) return { status: 'rejected', message: h.error, errors: { hours: h.error } };
          const r = store.submit(staffId, { ...values, partial: h.partial }, operationId);
          emit('hr_operation', { operation: 'submitTimeOff', ok: r.ok, code: r.ok ? 'sent_to_manager' : r.code });
          if (!r.ok) return { status: 'rejected', message: r.reason, errors: { _form: r.reason } };
          log('recorded time-off request', { requestId: r.receipt.requestId, hours: r.receipt.hours, status: r.receipt.status });
          return { status: 'accepted', message: TEXT.receipt, receipt: { ...r.receipt, demo: true, note: 'Demo request — synthetic HR records.' } };
        },
        async cancelForm(form, context, { trusted }) {
          if (hubLink.verifiedStaff(trusted, form.contextId) !== form.data.staffId) return { status: 'rejected', message: 'This request belongs to another staff member.', errors: { _form: 'This request belongs to another staff member.' } };
          return { status: 'cancelled', message: 'Cancelled. Nothing was sent to your manager.' };
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

// A chat message while this staff member's card is open fills that card. First the card as the staff member
// sees it now (cardValues: the browser's current values, checked — when sent they ARE the card, so a field
// cleared there is empty), then the words: non-empty values from the new words replace those. The card is
// re-issued in place (supersedes the open one).
const ADDITION = /\b(also|plus|as\s+well|too|add|another|extra)\b/i;
function merge(open, read, text, staffId, cardValues) {
  const before = open.data;
  const card = cardValues ? { absenceName: '', beginDate: '', endDate: '', relationship: '', note: '', ...cardValues } : { ...before.values };
  delete card.hours;
  const values = { ...card };
  for (const f of ['absenceName', 'beginDate', 'endDate', 'relationship', 'note']) if (read.prefill[f]) values[f] = read.prefill[f];
  // Dates in a follow-up, fail safe (never extended, never guessed): an addition word with a day (“also Monday”, “add
  // Wednesday”) clears them; a return-day message that isn't the one clear shape clears them; dates read cleanly
  // replace them (the loop above); a day that couldn't be read clears them; otherwise the card's dates stay.
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
  // A name from the words that needs no relationship (e.g. bereavement → vacation) drops the one the old name needed.
  if (values.absenceName !== card.absenceName && !RELATIONSHIP_REQUIRED.has(values.absenceName)) values.relationship = '';
  // The CURRENT name (from the card or the words) needs a relationship: read it from these words.
  if (!values.relationship && RELATIONSHIP_REQUIRED.has(values.absenceName)) values.relationship = readRelationship(text);
  // The partial day: the words first; else the card's hours (a shorter first day, checked by the store);
  // else the earlier one while the dates are unchanged.
  const wordsKeptDates = values.beginDate === card.beginDate && values.endDate === card.endDate;
  let kept = null;
  if (wordsKeptDates && cardValues?.hours && values.beginDate && values.endDate) {
    const h = partialFromHours(staffId, { ...values, hours: cardValues.hours });
    kept = h.error ? null : h.partial;
  } else if (wordsKeptDates && card.beginDate === before.values.beginDate && card.endDate === before.values.endDate) kept = before.partial;
  // Hours from the words apply only to a single-day absence (a span of days is full days).
  const single = values.beginDate && values.beginDate === values.endDate;
  const fromWords = (single || !values.beginDate) && dayReferences(text) <= 1 ? readPartial(text) : null;
  // Hours: a follow-up with a real hour signal (“make that 1pm”, “Actually make it a full day”, “Make it three
  // instead”) uses its one clear value or else a full day — the old value is never kept. Without one, the hours stay.
  const partial = mentionsHours(text) ? fromWords : (fromWords ?? kept);
  // “Chosen because you said …” only while the name is still the one those words chose.
  const quote = read.prefill.absenceName ? read.quote : values.absenceName === before.values.absenceName ? before.quote : null;
  return { values, partial, quote };
}

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
    if (!staffId || !store.staff(staffId)) return send(TEXT.refused, 'refused');
    if (!workflowEnabled()) return send(TEXT.disabled, 'workflow_disabled');
    if (!formHost.clientSupportsForms(incoming)) return send(TEXT.noClient, 'workflow_unsupported_client');

    const read = await readOnce(ctx, text, runId);
    const openId = formHost.openForm(ctx.contextId, WORKFLOW_ID);
    const open = openId ? formHost.form(openId) : null;
    const same = formHost.formForRequest(ctx); // a repeat of the request that made the open card
    const followUp = open && openId !== same && open.data.staffId === staffId;
    // The open card's current values, if the Professor sent them with this follow-up (checked again here).
    const cardValues = followUp && incoming.metadata?.formValues !== undefined ? checkTimeOffValues(incoming.metadata.formValues) : null;
    const state = followUp ? merge(open, read, text, staffId, cardValues?.ok ? cardValues.values : null) : { values: { ...read.prefill }, partial: read.partial, quote: read.quote };
    delete state.values.hours; // hours always come from the store
    const { hrCard, hours } = cardFor(staffId, state);
    const prefill = Object.fromEntries(Object.entries({ ...state.values, hours }).filter(([, v]) => v !== '' && v != null));
    emitViz('request_read', runId, { followUp: Boolean(followUp), cardValues: Boolean(cardValues?.ok), prefilled: Object.keys(prefill), missing: hrCard.missing, outcome: hrCard.problem ? 'forecast_failed' : hrCard.missing.length ? 'missing' : 'ready', code: read.error ?? null });
    formHost.issue(ctx, bus, {
      workflowId: WORKFLOW_ID, prefill, runId,
      intro: hrCard.question ? `${hrCard.intro} ${hrCard.question}` : hrCard.intro,
      supersedes: followUp ? openId : null,
      buildOptions: { missing: hrCard.missing },
      data: { staffId, values: state.values, partial: state.partial, quote: state.quote },
      extra: { hrCard, hr: { outcome: 'card' } },
    });
  },
  async cancelTask() {},
};

function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ source: 'hr', type: 'status', runId: null, at: new Date().toISOString(), data: { ...hrStatus(), skills: skillService?.describe() ?? null } })}\n\n`);
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

function buildAgentCard(port) {
  return {
    name: 'HR Agent',
    description: 'Staff time-off requests (demo, synthetic records): fills the request from what a staff member says, checks the balance, and sends it to their manager for a decision. University staff only.',
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
      // Demo reset (the classroom reset, asked by the Hub): staff, balances and requests back to the sample.
      // Server callers only — a cross-site browser POST is refused.
      app.post('/dev/hr/reset', sameOriginGuard(actualPort), (req, res) => {
        store.reset();
        ledger.clear();
        // A card opened before the reset can't be submitted into the fresh records.
        const closed = formHost.closeAll('This card was closed when the HR records were reset. Ask again for a new card.');
        log('HR records reset to the starting sample', { closedCards: closed });
        res.json({ status: 'reset' });
      });
      // Test hook only: read the in-memory requests.
      if (process.env.HR_TEST_HOOKS === '1') app.get('/test/hr/requests', (req, res) => res.json({ requests: store._records() }));
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
      await Promise.race([hubLink?.stop(), new Promise((r) => setTimeout(r, 800))]);
      process.exit(0);
    });
  }
  log(`listening on ${baseUrl}`);
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const s = hrStatus();
  log(`mode: ${s.mode} (${s.model})${s.mode === 'live' ? `, API key (${keyEnvName()}): ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}, staff only, synthetic records`);
}
