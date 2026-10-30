// Library Agent — a separate A2A service. Answers ONLY from the saved "answer content" of its
// enabled skills (src/library-model.js): mock mode extracts matching lines deterministically;
// live mode uses Claude Haiku 5.5 with code-verified evidence. Part 6: when asked to reserve a group
// study room it sends its booking form (A2UI) and makes DEMO bookings in memory; no real transactions.
// Part 8: questions about the student's OWN loans go to the loan service (synthetic records) and the
// Library's model, which answers, asks, or composes an interface from the catalog (src/loan-model.js);
// renewals are executed only by the loan service, re-checked at submission.
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
import { LlmError, apiHost, keyEnvName, useModel } from './llm.js';
import { LIBRARY_DEFAULT_SKILLS } from './library-fixture.js';
import { LIBRARY_MODE, answerFromKnowledge, libraryStatus } from './library-model.js';
import {
  A2UI_EXTENSION_URI, A2UI_MIME_TYPE, BASIC_CATALOG_ID, BOOKING, ROOMS, TIMEZONE_LABEL, WORKFLOWS,
  buildEditUpdate, buildReviewUpdate, buildSlotUpdate, buildStudyRoomForm, isA2uiPart, prettyDate, validateBooking, validateBookingCriteria,
} from './forms.js';
import { createFormHost } from './form-host.js';
import { reviewGate } from './form-review.js';
import { createRoomStore } from './demo-store.js';
import { bookingPrefill, wantsReplacement } from './form-intent.js';
import { createLoanStore } from './loan-store.js';
import { mockLoanReply, replyAboutLoans } from './loan-model.js';
import { CATALOG_INFO, wrapSurface } from './a2ui-catalog.js';
import { validateLoanRenewal } from './forms.js';

export { LIBRARY_DEFAULT_SKILLS };

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const VIZ_PATH = '/viz/events';
// Part 7: this agent connects to the University Hub (registration, heartbeats, card-change notices).
const CONFIG = loadSpecialistConfig('library');
useModel(CONFIG.model); // the Library's own model and key variable
let hubLink = null;
const MAX_LEDGER = 500;

const log = (...args) => console.log('[Library Agent]', ...args);
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'library', type, runId, at: new Date().toISOString(), data });
const textOf = (message) => message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

// Every Library answer skill is answered from its own saved content, so that content is required.
// Group study-room booking is a built-in form skill handled by code.
const WORKFLOW_ID = 'study-room-booking';
const LOAN_WORKFLOW_ID = 'loan-renewal';
const LIBRARY_RULES = { answer: { knowledge: 'required' }, form: { ids: [WORKFLOWS[WORKFLOW_ID].skillId, WORKFLOWS[LOAN_WORKFLOW_ID].skillId] } };
const WORKFLOW_TEXT = {
  offer: 'Here is the group study room booking form. Choose your details to see demo availability, review, then confirm.',
  info: `Group study rooms (demo): ask here — for example “I want to reserve a group study room” — and I’ll send a booking form. You choose group size, date, room and duration, pick from demo availability, review, then confirm. ${ROOMS.map((r) => `${r.name} holds up to ${r.capacity}`).join('; ')}. Bookable ${BOOKING.open}–${BOOKING.close} ${TIMEZONE_LABEL}, 1 or 2 hours, up to ${BOOKING.maxDaysAhead} days ahead. Demo bookings only.`,
  disabled: 'Group study room booking isn’t offered by the Library Agent right now.',
  noClient: 'I can send a study room booking form, but your client didn’t declare A2UI v0.9 support, so I can’t show it.',
  alreadyOpen: 'You already have an open study room booking form above. Continue with it, or say “replace the form” to start a new one.',
};
const LOG_CONTENT = process.env.LIBRARY_LOG_CONTENT !== undefined ? process.env.LIBRARY_LOG_CONTENT === '1' : LIBRARY_MODE !== 'live';

let skillService = null;
const rooms = createRoomStore();
const loans = createLoanStore();
const workflowEnabled = () => skillService.policy().skills.some((s) => s.id === WORKFLOWS[WORKFLOW_ID].skillId);
const loansEnabled = () => skillService.policy().skills.some((s) => s.id === WORKFLOWS[LOAN_WORKFLOW_ID].skillId);
const roomName = (id) => ROOMS.find((r) => r.id === id)?.name ?? id;

// Opaque, per-form slot IDs: only times this form was actually offered can be reviewed or confirmed.
function offerSlots(form, slots) {
  form.data.offered ??= new Map(); // slotId → { room, date, start, end, duration }
  form.data.byKey ??= new Map(); // same slot offered again keeps its ID
  return slots.map((slot) => {
    const key = `${slot.room}|${slot.date}|${slot.start}|${slot.duration}`;
    let slotId = form.data.byKey.get(key);
    if (!slotId) {
      slotId = `slot-${randomUUID().slice(0, 8)}`;
      form.data.byKey.set(key, slotId);
      form.data.offered.set(slotId, slot);
    }
    return { slotId, label: `${slot.start}–${slot.end}` };
  });
}
function availabilityUpdate(form, formId, criteria) {
  const offered = offerSlots(form, rooms.listStudyRoomAvailability(criteria));
  const where = `${roomName(criteria.room)} on ${prettyDate(criteria.date)} for ${criteria.duration / 60} hour${criteria.duration > 60 ? 's' : ''}`;
  const note = offered.length ? `Demo availability for ${where} (${TIMEZONE_LABEL}).` : `No demo availability for ${where}. Try another date, room or duration.`;
  return { note, a2ui: buildSlotUpdate(formId, offered, note) };
}
// The selected slot must be one this form offered AND match the chosen room/date/duration. Never substituted.
function selectedSlot(form, values) {
  const slot = form.data.offered?.get(values.slot);
  if (!slot) return { error: 'That time wasn’t offered on this form. Choose one of the available times.' };
  if (slot.room !== values.room || slot.date !== values.date || slot.duration !== values.duration) return { error: 'The selected time doesn’t match the chosen room, date or duration. Choose a new time.' };
  return { slot };
}
const summary = (v, slot) => [
  `Name: ${v.firstName} ${v.lastName}`, `Email: ${v.email}`, `Group size: ${v.groupSize}`,
  `Room: ${roomName(slot.room)}`, `Date: ${prettyDate(slot.date)}`, `Time: ${slot.start}–${slot.end} (${TIMEZONE_LABEL})`, 'Demo booking — not a real reservation.',
];

const formHost = createFormHost({
  agentId: 'library',
  isEnabled: (workflowId) => (workflowId === WORKFLOW_ID ? workflowEnabled() : workflowId === LOAN_WORKFLOW_ID ? loansEnabled() : false),
  emitViz, log,
  logValues: (v) => (v ? { ...v, firstName: '[redacted]', lastName: '[redacted]', email: '[redacted]' } : v),
  workflows: {
    [WORKFLOW_ID]: {
      build: buildStudyRoomForm,
      actions: {
        // Lookup: scheduling fields only. Availability comes from the fixture handler, never a model.
        async checkAvailability(form, context, { formId }) {
          const c = validateBookingCriteria(context);
          if (!c.ok) {
            const note = `To see demo availability: ${Object.values(c.errors).join(' ')}`;
            return { status: 'updated', message: note, errors: c.errors, a2ui: buildSlotUpdate(formId, [], note) };
          }
          const { note, a2ui } = availabilityUpdate(form, formId, c.values);
          return { status: 'updated', message: note, a2ui };
        },
        async reviewBooking(form, context, { formId }) {
          const v = validateBooking(context);
          if (!v.ok) return { status: 'rejected', message: 'Please correct the highlighted fields.', errors: v.errors };
          const { slot, error } = selectedSlot(form, v.values);
          if (error) return { status: 'rejected', message: error, errors: { slot: error } };
          if (!rooms.isFree(slot)) {
            const { note, a2ui } = availabilityUpdate(form, formId, v.values);
            return { status: 'rejected', message: `That time is no longer available. ${note}`, errors: { slot: 'That time is no longer available. Choose another.' }, a2ui };
          }
          form.stage = 'review';
          return { status: 'updated', message: 'Review your booking, then confirm.', a2ui: buildReviewUpdate(formId, summary(v.values, slot)) };
        },
        async editBooking(form, context, { formId }) {
          form.stage = 'edit';
          return { status: 'updated', message: 'Back to editing.', a2ui: buildEditUpdate(formId) };
        },
        // Final: re-validate, re-check, and atomically reserve (rooms.reserveStudyRoom is synchronous).
        async confirmStudyRoomBooking(form, context, { formId, reviewAcknowledged, emit }) {
          if (form.stage !== 'review') return { status: 'rejected', message: 'Review the booking before confirming.', errors: { _form: 'Review the booking before confirming.' } };
          const v = validateBooking(context);
          if (!v.ok) return { status: 'rejected', message: 'Please correct the highlighted fields.', errors: v.errors };
          const { slot, error } = selectedSlot(form, v.values);
          if (error) return { status: 'rejected', message: error, errors: { slot: error } };
          // Advisory review of every field (model in live mode). Then the check-and-reserve below stays synchronous.
          const flagged = await reviewGate({ form, workflowId: WORKFLOW_ID, values: v.values, acknowledged: reviewAcknowledged, live: LIBRARY_MODE === 'live', slotLabel: `${slot.start}–${slot.end}`, emit });
          if (flagged) return flagged;
          const result = rooms.reserveStudyRoom({ ...slot, groupSize: v.values.groupSize, contact: { firstName: v.values.firstName, lastName: v.values.lastName, email: v.values.email } });
          if (!result.ok) {
            // Conflict: report it and offer refreshed alternatives. Never pick another time or room.
            form.stage = 'edit';
            const { note, a2ui } = availabilityUpdate(form, formId, v.values);
            return { status: 'conflict', message: `That time was just taken, so nothing was booked. ${note}`, errors: { slot: 'That time was just taken. Choose another available time.' }, a2ui: [...buildEditUpdate(formId), ...a2ui] };
          }
          const b = result.booking;
          log('recorded demo booking', { bookingId: b.bookingId, room: b.room, date: b.date, start: b.start });
          return {
            status: 'accepted', message: 'Your group study room is booked.', values: { ...v.values, slot: `${b.start}–${b.end}` },
            receipt: { bookingId: b.bookingId, room: b.roomName, date: b.date, start: b.start, end: b.end, groupSize: b.groupSize, timezone: TIMEZONE_LABEL, demo: true, note: 'Demo booking — not a real university reservation.' },
          };
        },
        async cancelForm() {
          return { status: 'cancelled', message: 'Form cancelled. Nothing was booked.' };
        },
      },
    },
    // Part 8: generated surfaces only (no template). The handler trusts nothing from the surface: the
    // borrower comes from the Hub's verified context, and the loan service re-checks ownership, record
    // version, eligibility and the permitted range before it renews (idempotent by operation ID).
    [LOAN_WORKFLOW_ID]: {
      build: () => { throw new Error('loan surfaces are generated, never built from a template'); },
      actions: {
        async renewLoan(form, context, { operationId, trusted, emit }) {
          const v = validateLoanRenewal(context);
          if (!v.ok) return { status: 'rejected', message: 'Choose a return date.', errors: v.errors };
          // Only a student the Hub signed for this request counts (a bare metadata studentId is ignored).
          if (hubLink.verifiedStudent(trusted, form.contextId) !== form.data.borrowerId) return { status: 'rejected', message: 'This form belongs to another student.', errors: { _form: 'This form belongs to another student.' } };
          const expectedVersion = form.data.renewable?.[v.values.loanId];
          if (expectedVersion === undefined) return { status: 'rejected', message: 'This form can’t renew that loan.', errors: { _form: 'This form can’t renew that loan.' } };
          const r = loans.renewLoan({ borrowerId: form.data.borrowerId, loanId: v.values.loanId, returnDate: v.values.returnDate, expectedVersion, operationId });
          emit('loan_operation', { operation: 'renewLoan', loanId: v.values.loanId, ok: r.ok, code: r.ok ? 'renewed' : r.code, duplicate: Boolean(r.duplicate) });
          if (r.ok) {
            log('renewed demo loan', { loanId: r.receipt.loanId, renewalId: r.receipt.renewalId, newDueDate: r.receipt.newDueDate });
            return { status: 'accepted', message: `Renewed. ${r.receipt.title} is now due ${prettyDate(r.receipt.newDueDate)}.`, values: v.values, receipt: { ...r.receipt, demo: true, note: 'Demo renewal — synthetic library records.' } };
          }
          return { status: 'rejected', message: r.reason, errors: ['out_of_range', 'invalid_date'].includes(r.code) ? { returnDate: r.reason } : { _form: r.reason } };
        },
        async cancelForm() {
          return { status: 'cancelled', message: 'Closed. Nothing was renewed.' };
        },
      },
    },
  },
});

function offerWorkflow(ctx, bus, runId, question, metadata) {
  const reply = (text, outcome) => {
    const message = { messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }], metadata: { ...metadata, library: { outcome } }, extensions: [], referenceTaskIds: [] };
    bus.publish(AgentEvent.message(message));
    bus.finished();
    emitViz('reply_published', runId, { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: ctx.userMessage.messageId, text, library: { outcome } });
  };
  if (!workflowEnabled()) return reply(WORKFLOW_TEXT.disabled, 'workflow_disabled');
  if (!formHost.clientSupportsForms(ctx.userMessage)) return reply(WORKFLOW_TEXT.noClient, 'workflow_unsupported_client');
  const open = formHost.openForm(ctx.contextId, WORKFLOW_ID);
  const same = formHost.formForRequest(ctx);
  if (open && open !== same && !wantsReplacement(question)) return reply(WORKFLOW_TEXT.alreadyOpen, 'clarify');
  formHost.issue(ctx, bus, { workflowId: WORKFLOW_ID, prefill: bookingPrefill(question), runId, intro: WORKFLOW_TEXT.offer, supersedes: open === same ? null : open });
}
const recentByContext = new Map(); // contextId → last few { question, answer } (in memory; only for short follow-ups)
const loanLedger = new Map(); // `${contextId}|${messageId}` → Promise<loan reply>; a repeat request reuses it (no second paid call)
const revisions = new Map(); // contextId → generated loan surfaces issued so far (the surface revision)
const remember = (ctx, question, answer) => {
  const turns = [...(recentByContext.get(ctx.contextId) ?? []), { question, answer }].slice(-4);
  recentByContext.delete(ctx.contextId);
  recentByContext.set(ctx.contextId, turns);
  if (recentByContext.size > MAX_LEDGER) recentByContext.delete(recentByContext.keys().next().value);
};

// Part 8: the student's own loans. The borrower is the Hub's verified student for this conversation.
async function handleLoans(ctx, bus, runId, question, metadata) {
  const incoming = ctx.userMessage;
  const send = (text, outcome, extra = {}) => {
    const message = reply(ctx, text, { ...metadata, library: { outcome, ...extra } });
    bus.publish(AgentEvent.message(message));
    bus.finished();
    emitViz('reply_published', runId, { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: incoming.messageId, text, library: { outcome, ...extra } });
    remember(ctx, question, text);
  };
  if (!loansEnabled()) return send('Looking up your loans isn’t offered by the Library Agent right now.', 'workflow_disabled');
  // The borrower is the student the Hub vouched for with a valid signature — never a bare claim.
  const borrowerId = hubLink.verifiedStudent(incoming.metadata, ctx.contextId);
  if (!borrowerId) return send('I can only look up loans for a student who asks through the university.', 'loan_no_identity');
  const view = loans.listLoans(borrowerId);
  const policy = loans.policy();
  const openId = formHost.openForm(ctx.contextId, LOAN_WORKFLOW_ID);
  const open = openId ? formHost.form(openId) : null;
  const key = `${ctx.contextId}|${incoming.messageId}`;
  let pending = loanLedger.get(key);
  if (!pending) {
    pending = LIBRARY_MODE === 'live'
      ? replyAboutLoans({ question, recent: recentByContext.get(ctx.contextId) ?? [], loans: view, policy, openSurface: open ? { formId: openId, revision: open.version, renewableLoans: Object.keys(open.data.renewable ?? {}) } : null, emit: (type, data) => emitViz(type, runId, data) })
      : Promise.resolve(mockLoanReply({ loans: view }));
    loanLedger.set(key, pending);
    pending.catch(() => {});
    if (loanLedger.size > MAX_LEDGER) loanLedger.delete(loanLedger.keys().next().value);
  } else emitViz('model_call_reused', runId, { contextId: ctx.contextId, messageId: incoming.messageId });
  let result;
  try {
    result = await pending;
  } catch (err) {
    const failure = err instanceof LlmError ? err : new LlmError('internal_error');
    return send(`The Library Agent could not answer: ${failure.message}`, 'error', { code: failure.code });
  }
  const showUi = result.kind === 'ui' && formHost.clientSupportsForms(incoming);
  const revision = showUi ? (formHost.formForRequest(ctx) ? (revisions.get(ctx.contextId) ?? 1) : (revisions.get(ctx.contextId) ?? 0) + 1) : null;
  // The inspector (developer view): model output, application validation and backend facts, kept apart.
  const inspect = (surface) => emitViz('ui_generated', runId, {
    kind: result.kind, fallback: Boolean(result.fallback), model: result.model, usage: result.usage,
    inspector: {
      decision: result.fallback ? `${result.kind} (fallback after failed validation)` : result.kind,
      catalog: { catalogId: CATALOG_INFO.catalogId, version: CATALOG_INFO.version, renderer: CATALOG_INFO.renderer },
      validation: result.attempts,
      surface,
      modelOutput: result.kind === 'ui' ? { components: result.components, dataModel: result.dataModel } : { text: result.text },
      authoritative: view.map((l) => ({ loanId: l.loanId, dueDate: l.dueDate, eligible: l.eligible, code: l.eligibilityCode, permittedReturnDates: l.permittedReturnDates, version: l.version, source: 'loan store (synthetic)' })),
      loanIds: result.loanIds,
    },
  });
  if (!showUi) {
    inspect(null);
    const text = result.kind === 'ui' ? `${result.text} (Your client can’t show forms, so here it is as text.)` : result.text;
    return send(text, result.kind === 'clarify' ? 'loan_clarify' : 'loan_answer', { mode: LIBRARY_MODE, model: result.model, usage: result.usage, generated: false });
  }
  revisions.set(ctx.contextId, revision);
  // A new interface replaces the conversation's open loan surface (never two active ones).
  const formId = formHost.issue(ctx, bus, {
    workflowId: LOAN_WORKFLOW_ID, runId, intro: result.text, supersedes: open && openId !== formHost.formForRequest(ctx) ? openId : null,
    payload: (id) => wrapSurface(id, result.components, result.dataModel), version: revision,
    data: { borrowerId, renewable: result.renewable }, extra: { generated: true, revision },
  });
  inspect({ formId, revision, supersedes: open && openId !== formId ? openId : null, issuer: 'library', taskId: ctx.taskId, contextId: ctx.contextId, renewable: result.renewable });
  remember(ctx, question, `${result.text} [showed an interface]`);
}
const ledger = new Map(); // `${contextId}|${messageId}` → Promise<result>; a repeat request reuses it (no second paid call)

async function answerOnce(ctx, question, runId) {
  const key = `${ctx.contextId}|${ctx.userMessage.messageId}`;
  if (ledger.has(key)) {
    emitViz('model_call_reused', runId, { contextId: ctx.contextId, messageId: ctx.userMessage.messageId });
    return { ...(await ledger.get(key)), duplicate: true };
  }
  const promise = (async () => {
    const current = skillService.policy();
    const policy = { revision: current.revision, skills: current.skills.filter((s) => s.kind === 'answer') };
    const recent = recentByContext.get(ctx.contextId) ?? [];
    const result = await answerFromKnowledge({ question, policy, workflow: { enabled: workflowEnabled() }, loans: { enabled: loansEnabled() }, recent, emit: (type, data) => emitViz(type, runId, data) });
    // Release check: skills changed while answering → don't release under the old policy.
    if (skillService.revision() !== policy.revision) return { ...result, verdict: 'changed', text: 'The Library Agent’s skills changed while your question was being answered, so that answer wasn’t released. Please ask again.', policyRevision: skillService.revision() };
    return { ...result, policyRevision: policy.revision };
  })();
  ledger.set(key, promise);
  promise.catch(() => {});
  if (ledger.size > MAX_LEDGER) ledger.delete(ledger.keys().next().value);
  return promise;
}

const reply = (ctx, text, metadata) => ({
  messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT,
  parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata, extensions: [], referenceTaskIds: [],
});

const libraryExecutor = {
  async execute(ctx, bus) {
    const incoming = ctx.userMessage;
    const runId = incoming.metadata?.runId ?? null;
    const a2ui = incoming.parts.find(isA2uiPart);
    if (a2ui) return formHost.handleAction(ctx, bus, runId, a2ui);
    const question = textOf(incoming).slice(0, 2000);
    const received = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId, text: question };
    log('received message', LOG_CONTENT ? received : { ...received, text: `[${question.length} chars, content not logged]` });
    emitViz('message_received', runId, received);

    const metadata = { ...(runId ? { runId } : {}), agentId: 'library' };
    let text;
    try {
      const r = await answerOnce(ctx, question, runId);
      emitViz('scope_checked', runId, { stage: 'request', verdict: r.verdict, skillId: r.skillId ?? null, policyRevision: r.policyRevision, evidenceLines: r.evidence.length });
      if (r.verdict === 'offer_form') return offerWorkflow(ctx, bus, runId, question, metadata);
      if (r.verdict === 'my_loans') return handleLoans(ctx, bus, runId, question, metadata);
      text = r.verdict === 'answered' ? `${r.text}\n\n(From the Library Agent’s saved information.)`
        : r.verdict === 'workflow_info' ? WORKFLOW_TEXT.info : r.verdict === 'workflow_disabled' ? WORKFLOW_TEXT.disabled : r.text;
      metadata.library = { outcome: r.verdict, skillId: r.skillId ?? null, policyRevision: r.policyRevision, mode: LIBRARY_MODE, model: r.model, usage: r.usage, requestId: r.requestId ?? null, evidence: r.evidence, duplicate: Boolean(r.duplicate) };
    } catch (err) {
      const failure = err instanceof LlmError ? err : new LlmError('internal_error');
      text = `The Library Agent could not answer: ${failure.message}`;
      metadata.serviceError = { code: failure.code, message: failure.message, requestId: failure.requestId };
      if (failure.rateLimit) log('rate limit details', failure.rateLimit);
    }
    const message = reply(ctx, text, metadata);
    const sent = { messageId: message.messageId, contextId: message.contextId, inReplyTo: incoming.messageId, text, library: metadata.library, serviceError: metadata.serviceError };
    log('sending reply', LOG_CONTENT ? sent : { ...sent, text: `[${text.length} chars, content not logged]` });
    bus.publish(AgentEvent.message(message));
    bus.finished();
    emitViz('reply_published', runId, sent);
    remember(ctx, question, text);
  },
  async cancelTask() {},
};

function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ source: 'library', type: 'status', runId: null, at: new Date().toISOString(), data: { ...libraryStatus(), skills: skillService?.describe() ?? null } })}\n\n`);
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

function buildAgentCard(port) {
  return {
    name: 'Library Agent',
    description: 'Library help from its saved information (fictional sample data by default): hours, borrowing, renewal and return guidance, finding resources, demo study-room bookings, and your own demo loans and renewals (synthetic records). No real transactions.',
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

export function startLibraryServer({ port = 41242 } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      const baseUrl = `http://${HOST}:${actualPort}`;
      const card = buildAgentCard(actualPort);
      skillService = createSkillService({
        agentId: 'library', agentName: card.name, defaults: LIBRARY_DEFAULT_SKILLS, rules: LIBRARY_RULES, card,
        emit: (type, data) => emitViz(type, null, data), log, notify: (n) => hubLink.notifyCardChanged(n),
      });
      hubLink = createHubLink({
        agentId: CONFIG.agentId, hubUrl: CONFIG.hub.url, endpoint: `${baseUrl}${JSONRPC_PATH}`, cardUrl: `${baseUrl}/${AGENT_CARD_PATH}`,
        enabled: CONFIG.enabled, heartbeatIntervalMs: CONFIG.heartbeatIntervalMs, log,
        emit: (type, data) => emitViz(type, null, data),
      });
      const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), libraryExecutor);
      app.use(hostGuard(actualPort));
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.get(VIZ_PATH, serveVizEvents);
      app.use(skillService.router());
      // Demo reset, asked by the Hub when the Student starts a new conversation: the sample loans come back
      // (renewal counts too). Server callers only — a cross-site browser POST is refused.
      app.post('/dev/loans/reset', sameOriginGuard(actualPort), (req, res) => {
        loans.reset();
        loanLedger.clear();
        revisions.clear();
        log('loans reset to the starting sample');
        res.json({ status: 'reset' });
      });
      // Test hook only: change a loan behind an open form's back (e.g. another borrower places a hold).
      if (process.env.LIBRARY_TEST_HOOKS === '1') {
        app.post('/test/loans/:loanId/hold', express.json(), (req, res) => res.json({ ok: loans._setHold(req.params.loanId, req.body?.hold !== false) }));
      }
      skillService.started(actualPort, `${baseUrl}/${AGENT_CARD_PATH}`);
      hubLink.start(); // retries until the Hub accepts the registration
      resolve({ server, baseUrl, hubLink });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT === undefined ? 41242 : Number(process.env.PORT);
  const { baseUrl } = await startLibraryServer({ port });
  // Sign out from the Hub on shutdown (best effort; the Hub's heartbeat expiry covers a crash).
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await Promise.race([hubLink?.stop(), new Promise((r) => setTimeout(r, 800))]);
      process.exit(0);
    });
  }
  log(`listening on ${baseUrl}`);
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const s = libraryStatus();
  log(`mode: ${s.mode} (${s.model})${s.mode === 'live' ? `, API key (${keyEnvName()}): ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}, answers only from saved skill content`);
}
