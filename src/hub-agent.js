// Part 7 — the University Hub ("California State University Fullerton", fictional local demo).
//
// The Student talks only to this agent. The Hub keeps a PRIVATE registry of specialists (Tutor,
// Library), decides which internal destination gets each request (the Part 5 router, moved here),
// forwards over A2A, and relays the specialist's real reply — answers, A2UI forms and authoritative
// form outcomes — back to the Student. Both legs are real A2A exchanges.
//
// Registration, heartbeats, sign-out and card-change notices are this application's conventions
// carried as A2A messages (see src/hub-link.js), not built-in A2A features. Identity on localhost is
// self-declared; the Hub checks it against its allowlist and trusted endpoints, but it is not
// authentication. State is in memory: a restart forgets registrations, forms and dedupe records.
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Role, TaskState, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { hostGuard } from './local-guard.js';
import { loadHubConfig } from './config.js';
import { apiHost, keyEnvName, useModel } from './llm.js';
import { createHubRegistry } from './hub-registry.js';
import { CONTROL_MEDIA_TYPES, DEREGISTER_MEDIA_TYPE, HEARTBEAT_MEDIA_TYPE, REGISTER_MEDIA_TYPE } from './hub-link.js';
import { CARD_CHANGED_MEDIA_TYPE } from './skills.js';
import { A2UI_EXTENSION_URI, A2UI_MIME_TYPE, BASIC_CATALOG_ID, isA2uiPart } from './forms.js';
import { ROUTER_MODE, decideRoute, routerStatus } from './router.js';
import { askTutor, sendFormAction } from './student-agent.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const FORM_TTL_MS = Number(process.env.HUB_FORM_TTL_MS ?? 2 * 60 * 60 * 1000);
const MAX_RECORDS = 1000;
const ROUTING_TURNS = 6;

const log = (...args) => console.log('[Hub]', ...args);
const textOf = (m) => m.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');
const hash = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
const textPart = (value) => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const jsonPart = (value) => ({ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' });
const a2uiPart = (messages) => ({ content: { $case: 'data', value: messages }, metadata: { mimeType: A2UI_MIME_TYPE }, filename: '', mediaType: A2UI_MIME_TYPE });
const statusOf = (state, message) => ({ state, message, timestamp: new Date().toISOString() });
const trim = (map) => { if (map.size > MAX_RECORDS) map.delete(map.keys().next().value); };

// Redaction of specialist telemetry before relaying (Part 7 §12): an ALLOWLIST, so a field added
// later is masked until someone decides it is safe. Run events keep only IDs, statuses, codes, modes,
// timings and token counts; message text, form values, review flags, errors, model-written reasons
// and anything unknown are masked. A receipt is reduced to its ID and status (the student's own
// conversation still shows the full receipt, which arrives over A2A). Only the named configuration
// event types (status, saved skills, registration, card notices) pass unchanged — they carry operator
// configuration, not student content. Whether an event has a runId decides nothing: a request sent
// without one must not get its content relayed. HUB_TELEMETRY_SHOW_CONTENT=1 turns redaction off.
const CONFIG_EVENT_TYPES = new Set(['status', 'skills_saved', 'card_notification', 'hub_registration']);
const SAFE_FIELDS = new Set([
  'runId', 'operationId', 'hubOperationId', 'formId', 'formRef', 'workflowId', 'taskId', 'contextId', 'messageId', 'inReplyTo', 'requestId',
  'agentId', 'skillId', 'actionName', 'policyRevision', 'revision', 'status', 'outcome', 'verdict', 'stage', 'decision', 'mode', 'model',
  'purpose', 'by', 'code', 'kind', 'final', 'lookup', 'duplicate', 'repeat', 'acknowledged', 'unavailable', 'truncated', 'stopReason',
  'taskState', 'resumedTask', 'violates', 'handler', 'reviewer', 'latencyMs', 'earlierMessages', 'chars',
  'usage', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'tutor', 'library',
]);
const mask = (v) => (typeof v === 'string' ? `[${v.length} chars redacted]` : Array.isArray(v) ? `[${v.length} items redacted]`
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).map((f) => [f, '[redacted]'])) : v === null || v === undefined ? v : '[redacted]');
function redactFields(data, depth = 0) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'receipt' && v && typeof v === 'object') out[k] = { requestId: v.requestId, bookingId: v.bookingId, status: v.status };
    else if (!SAFE_FIELDS.has(k)) out[k] = mask(v);
    else if (v && typeof v === 'object') out[k] = Array.isArray(v) || depth >= 2 ? mask(v) : redactFields(v, depth + 1);
    else out[k] = v;
  }
  return out;
}
export function redactTelemetry(event) {
  if (process.env.HUB_TELEMETRY_SHOW_CONTENT === '1' || CONFIG_EVENT_TYPES.has(event.type) || !event.data || typeof event.data !== 'object') return event.data;
  return redactFields(event.data);
}

export function startHubServer({ port } = {}) {
  const cfg = loadHubConfig();
  useModel(cfg.model); // the Hub router's own model and key variable
  const viz = new EventEmitter();
  viz.setMaxListeners(50);
  const emit = (type, runId, data, source = 'hub') => viz.emit('event', { source, type, runId: runId ?? null, at: new Date().toISOString(), data });
  const registry = createHubRegistry({ peers: cfg.peers, expiryMs: cfg.heartbeatExpiryMs, cardFetchMs: cfg.timeouts.cardFetchMs, onEvent: (type, data) => emit(type, null, data) });
  const workerOf = Object.fromEntries(Object.entries(cfg.destinations).map(([dest, d]) => [d.worker, dest]));

  // Per Student conversation (= the Student↔Hub A2A context): owner, routing turns, and one separate
  // downstream A2A context per specialist (never reuse one service's IDs with another).
  const conversations = new Map(); // upstreamContextId → { studentId, turns, downstream: { agentId → contextId } }
  const chatLedger = new Map(); // `${contextId}|${messageId}` → Promise<reply parts> (a repeat reuses it; no second dispatch)
  const formRefs = new Map(); // formRef → mapping (issuer, student, conversation, workflow, downstream task)
  const operations = new Map(); // operationId → { hash, result } for form actions (dedupe at the Hub)
  const counters = { active: 0 };
  const activeFor = new Map(); // agentId → in-flight dispatches

  const conversationFor = (ctx, studentId) => {
    let c = conversations.get(ctx.contextId);
    if (!c) {
      c = { studentId, turns: [], downstream: {} };
      conversations.set(ctx.contextId, c);
      trim(conversations);
    }
    return c;
  };
  const services = () => registry.routingView().map((s) => ({ ...s, destination: workerOf[s.agentId] ?? null, description: cfg.destinations[workerOf[s.agentId]]?.description ?? '' }))
    .filter((s) => s.destination); // a specialist is reachable only through its own destination

  // ---- A2A executor ---------------------------------------------------------------------------
  const executor = {
    async execute(ctx, bus) {
      const msg = ctx.userMessage;
      const control = msg.parts.find((p) => p.content?.$case === 'data' && CONTROL_MEDIA_TYPES.has(p.mediaType));
      if (control) return handleControl(ctx, bus, control);
      const studentId = msg.metadata?.studentId;
      if (!cfg.students.includes(studentId)) return replyMessage(ctx, bus, 'This university front door only serves enrolled students configured for this demo.', { hub: { decision: 'rejected', reason: 'unknown_student' } });
      const a2ui = msg.parts.find(isA2uiPart);
      if (a2ui) return handleFormAction(ctx, bus, a2ui, studentId);
      return handleChat(ctx, bus, studentId);
    },
    async cancelTask() {},
  };

  function replyMessage(ctx, bus, text, metadata, extraParts = []) {
    const message = { messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [textPart(text), ...extraParts], metadata, extensions: [], referenceTaskIds: [] };
    bus.publish(AgentEvent.message(message));
    bus.finished();
    return message;
  }

  // ---- control messages from specialists --------------------------------------------------------
  async function handleControl(ctx, bus, part) {
    const value = part.content.value ?? {};
    let ack;
    if (part.mediaType === REGISTER_MEDIA_TYPE) {
      ack = await registry.register(value);
      if (ack.status !== 'registered') emit('registration_rejected', null, { claimedAgentId: String(value.agentId ?? '').slice(0, 40), reason: ack.reason });
    } else if (part.mediaType === HEARTBEAT_MEDIA_TYPE) ack = registry.heartbeat(value);
    else if (part.mediaType === DEREGISTER_MEDIA_TYPE) {
      ack = registry.deregister(value);
      if (ack.status === 'deregistered') emit('deregistered', null, { agentId: value.agentId });
    } else if (part.mediaType === CARD_CHANGED_MEDIA_TYPE) {
      ack = registry.cardChanged(value);
      emit(ack.status === 'received' || ack.status === 'duplicate' ? 'card_notification_received' : 'card_notification_rejected', null,
        { agentId: String(value.agentId ?? '').slice(0, 40), notificationId: value.notificationId ?? null, revision: value.revision ?? null, duplicate: ack.status === 'duplicate', reason: ack.reason ?? null });
    }
    bus.publish(AgentEvent.message({ messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [jsonPart(ack ?? { status: 'rejected' })], metadata: undefined, extensions: [], referenceTaskIds: [] }));
    bus.finished();
  }

  // ---- chat: route, forward, relay --------------------------------------------------------------
  async function handleChat(ctx, bus, studentId) {
    const incoming = ctx.userMessage;
    const runId = incoming.metadata?.runId ?? null;
    const question = textOf(incoming).slice(0, 2000);
    const conv = conversationFor(ctx, studentId);
    if (conv.studentId !== studentId) return replyMessage(ctx, bus, 'This conversation belongs to another student.', { runId, hub: { decision: 'rejected', reason: 'wrong_student' } });
    const key = `${ctx.contextId}|${incoming.messageId}`;
    const repeat = chatLedger.has(key);
    if (!repeat) {
      chatLedger.set(key, processChat(ctx, conv, question, runId, incoming.messageId, incoming.metadata?.requestedCapability));
      trim(chatLedger);
    } else emit('request_repeat', runId, { messageId: incoming.messageId, note: 'Same request ID as before — returning the earlier result; nothing dispatched again.' });
    const out = await chatLedger.get(key);
    if (out.form) {
      // A form travels back as the Hub's own task (INPUT_REQUIRED); actions resume it.
      bus.publish(AgentEvent.task({ id: ctx.taskId, contextId: ctx.contextId, status: statusOf(TaskState.TASK_STATE_INPUT_REQUIRED, { ...out.message, taskId: ctx.taskId, contextId: ctx.contextId }), artifacts: [], history: [], metadata: out.message.metadata }));
      bus.finished();
      if (!repeat) bindFormTask(out.formRef, ctx);
    } else {
      bus.publish(AgentEvent.message({ ...out.message, contextId: ctx.contextId }));
      bus.finished();
    }
    emit('relay_sent', runId, { operationId: out.operationId, to: 'student', kind: out.form ? 'form_offer' : out.kind, servedBy: out.servedBy ?? null, repeat });
  }

  async function processChat(ctx, conv, question, runId, upstreamMessageId, requestedCapability) {
    const operationId = randomUUID();
    emit('message_received', runId, { operationId, contextId: ctx.contextId, messageId: upstreamMessageId, chars: question.length });
    const plain = (text, metadata, kind) => ({ operationId, kind, message: { messageId: randomUUID(), taskId: '', role: Role.ROLE_AGENT, parts: [textPart(text)], metadata: { runId, operationId, ...metadata }, extensions: [], referenceTaskIds: [] } });
    const view = services();
    let decision;
    // The Student may name one of this university's PUBLIC capabilities (its card's skill IDs). The Hub
    // maps it to its own configured worker — the Student never supplies a destination — and the
    // readiness check below still applies. Anything else is ignored and the Hub routes as usual.
    const requested = typeof requestedCapability === 'string' ? requestedCapability.slice(0, 60) : null;
    const capability = requested && Object.hasOwn(cfg.destinations, requested) ? cfg.destinations[requested] : null;
    if (requested && !capability) emit('capability_rejected', runId, { operationId, capability: requested, reason: 'Not one of this university’s capabilities; the Hub routed the request itself.' });
    try {
      if (capability) {
        decision = { decision: 'route', agentId: capability.worker, skillId: null, reason: `The Student asked for ${capability.name ?? requested}.`, model: null, decidedBy: 'student' };
      } else if (ROUTER_MODE === 'direct') {
        const tutor = view.find((s) => s.destination === 'tutoring');
        decision = tutor ? { decision: 'route', agentId: tutor.agentId, skillId: tutor.skills[0]?.id ?? null, reason: 'Direct mode: every request goes to tutoring.', model: null } : { decision: 'unavailable', agentId: null, skillId: null, reason: 'No tutoring service is registered.' };
      } else {
        // Live router: report the provider call as its own milestones (the topology draws them).
        if (ROUTER_MODE === 'live') emit('model_call_started', runId, { operationId, model: routerStatus().model, mode: 'live', purpose: 'routing' });
        const startedAt = Date.now();
        decision = await decideRoute({ question, recentTurns: conv.turns, services: view });
        if (ROUTER_MODE === 'live') emit('model_response_received', runId, { operationId, model: decision.model, purpose: 'routing', latencyMs: Date.now() - startedAt, usage: decision.usage ?? null, requestId: decision.requestId ?? null });
      }
    } catch (err) {
      if (ROUTER_MODE === 'live') emit('model_call_failed', runId, { operationId, purpose: 'routing', code: err.code ?? 'internal_error', message: err.message });
      emit('route_failed', runId, { operationId, code: err.code ?? 'internal_error', message: err.message });
      return plain(`The university assistant could not route this request: ${err.message}`, { hub: { decision: 'failed', code: err.code ?? 'internal_error' }, serviceError: { code: err.code ?? 'internal_error', message: err.message } }, 'error');
    }
    // A supported request for a specialist that isn't ready → unavailable (nothing is dispatched).
    if (decision.decision === 'route' && !registry.isReady(decision.agentId)) {
      const why = { disconnected: 'it isn’t connected', stale: 'it stopped responding', unreachable: 'it can’t be reached', disabled: 'it is turned off', invalid_card: 'its description couldn’t be verified' }[registry.status(decision.agentId)] ?? 'it isn’t ready';
      decision = { ...decision, decision: 'unavailable', unavailableStatus: registry.status(decision.agentId), reason: `${registry.peer(decision.agentId)?.displayName ?? 'That service'} is not available right now (${why}).` };
    }
    const destination = decision.agentId ? workerOf[decision.agentId] : null;
    emit('route_decided', runId, { operationId, decidedBy: decision.decidedBy ?? 'hub', decision: decision.decision, destination, agentId: decision.agentId, skillId: decision.skillId, reason: decision.reason, clarificationQuestion: decision.clarificationQuestion ?? null, model: decision.model ?? null, usage: decision.usage ?? null, invalid: decision.invalid ?? false });
    const hubMeta = { decision: decision.decision, destination, reason: decision.reason, model: decision.model ?? null, decidedBy: decision.decidedBy ?? 'hub' };
    if (decision.decision !== 'route') {
      const text = decision.decision === 'clarify' ? decision.clarificationQuestion || 'Could you say a bit more about what you need?'
        : decision.decision === 'unavailable' ? `${decision.reason} Please try again in a little while.`
          : `The university assistant can’t help with that here. ${decision.reason ?? ''}`.trim();
      conv.turns = [...conv.turns, { question, agentId: null, skillId: null, answer: text.slice(0, 300) }].slice(-ROUTING_TURNS);
      return plain(text, { hub: hubMeta }, decision.decision);
    }

    // Forward over A2A to the specialist's TRUSTED endpoint (from configuration, never from a card or model).
    const agentId = decision.agentId;
    const peer = registry.peer(agentId);
    const downstreamContextId = (conv.downstream[agentId] ??= randomUUID());
    const downstreamMessageId = randomUUID();
    emit('forward_attempted', runId, { operationId, agentId, destination, downstreamContextId, downstreamMessageId, upstreamContextId: ctx.contextId, upstreamMessageId });
    activeFor.set(agentId, (activeFor.get(agentId) ?? 0) + 1);
    counters.active += 1;
    try {
      const reply = await askTutor(peer.baseUrl, question, {
        runId, contextId: downstreamContextId, messageId: downstreamMessageId, card: registry.entry(agentId).card,
        timeoutMs: cfg.timeouts.dispatchMs, metadata: { hubOperationId: operationId, via: cfg.agentId },
      });
      registry.markReachable(agentId, true);
      conv.turns = [...conv.turns, { question, agentId, skillId: decision.skillId, answer: String(reply.text ?? '').slice(0, 300) }].slice(-ROUTING_TURNS);
      const base = { runId, operationId, agentId, servedByName: peer.displayName, hub: hubMeta };
      if (reply.form) {
        const formRef = createFormRef(reply.form, agentId, conv, ctx, operationId);
        emit('forward_completed', runId, { operationId, agentId, kind: 'form_offer', downstreamTaskId: reply.form.taskId, formRef, workflowId: reply.form.workflowId });
        return {
          operationId, kind: 'form_offer', servedBy: agentId, form: true, formRef,
          message: { messageId: randomUUID(), role: Role.ROLE_AGENT, parts: [textPart(reply.text || 'Here is a form.'), a2uiPart(reply.form.a2uiMessages)], extensions: [], referenceTaskIds: [],
            metadata: { ...base, formRef, formId: reply.form.formId, workflowId: reply.form.workflowId, formVersion: reply.form.formVersion, issuer: agentId, supersedes: reply.form.supersedes, prefilled: reply.form.prefilled } },
        };
      }
      emit('forward_completed', runId, { operationId, agentId, kind: 'answer', downstreamMessageId: reply.messageId });
      return plain(reply.text, { ...base, tutorMode: reply.tutorMode, tutor: reply.tutor, library: reply.library }, 'answer');
    } catch (err) {
      const unknown = err.outcome === 'uncertain';
      const serviceError = err.tutorError ?? null;
      if (!serviceError) registry.markReachable(agentId, unknown ? null : false, err.message);
      emit('forward_failed', runId, { operationId, agentId, outcome: serviceError ? 'answered_with_error' : unknown ? 'unknown' : 'not_delivered', code: serviceError?.code ?? err.cause?.code ?? null, message: serviceError?.message ?? err.message });
      const text = serviceError ? `The ${peer.displayName} could not answer: ${serviceError.message}`
        : unknown ? `The ${peer.displayName} didn’t answer in time. It may still be working on it; nothing is assumed to have been undone.`
          : `The ${peer.displayName} is unreachable right now. Please try again in a little while.`;
      return plain(text, { agentId, servedByName: peer.displayName, hub: { ...hubMeta, outcome: unknown ? 'unknown' : 'failed' }, serviceError: serviceError ?? { code: unknown ? 'outcome_unknown' : 'unavailable', message: text } }, 'error');
    } finally {
      activeFor.set(agentId, activeFor.get(agentId) - 1);
      counters.active -= 1;
    }
  }

  // ---- forms: opaque Hub references bound to issuer, student, conversation and downstream task ----
  function createFormRef(form, agentId, conv, ctx, operationId) {
    const formRef = `hf-${randomUUID()}`;
    for (const m of formRefs.values()) {
      if (form.supersedes && m.downstream.formId === form.supersedes && m.upstreamContextId === ctx.contextId && m.state === 'open') m.state = 'superseded';
    }
    formRefs.set(formRef, {
      formRef, studentId: conv.studentId, upstreamContextId: ctx.contextId, upstreamTaskId: null, agentId, workflowId: form.workflowId,
      downstream: { formId: form.formId, taskId: form.taskId, contextId: form.contextId, formVersion: form.formVersion, workflowId: form.workflowId },
      state: 'open', createdAt: Date.now(), operationId,
    });
    trim(formRefs);
    emit('form_ref_created', null, { formRef, agentId, workflowId: form.workflowId, operationId, downstreamTaskId: form.taskId });
    return formRef;
  }
  const bindFormTask = (formRef, ctx) => { const m = formRefs.get(formRef); if (m) m.upstreamTaskId = ctx.taskId; };

  async function handleFormAction(ctx, bus, part, studentId) {
    const incoming = ctx.userMessage;
    const md = incoming.metadata ?? {};
    const runId = md.runId ?? null;
    const operationId = md.operationId;
    const resuming = Boolean(ctx.task);
    const action = Array.isArray(part.content.value) && part.content.value.length === 1 ? part.content.value[0] : null;
    const respond = (body, { text, a2ui = [], closed = false } = {}) => {
      const parts = [textPart(text ?? body.message ?? ''), jsonPart(body), ...(a2ui.length ? [a2uiPart(a2ui)] : [])];
      const metadata = { runId, formRef: md.formRef, operationId, duplicate: Boolean(body.duplicate) };
      if (resuming) {
        bus.publish(AgentEvent.task(ctx.task));
        bus.publish(AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, metadata: undefined, status: statusOf(closed ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_INPUT_REQUIRED, { messageId: randomUUID(), contextId: ctx.contextId, taskId: ctx.taskId, role: Role.ROLE_AGENT, parts, metadata, extensions: [], referenceTaskIds: [] }) }));
      } else {
        bus.publish(AgentEvent.message({ messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts, metadata, extensions: [], referenceTaskIds: [] }));
      }
      bus.finished();
    };
    const reject = (reason) => {
      emit('form_action_rejected', runId, { formRef: md.formRef ?? null, operationId: operationId ?? null, reason });
      respond({ status: 'rejected', formRef: md.formRef, operationId, errors: { _form: reason }, message: reason });
    };
    const m = formRefs.get(md.formRef);
    emit('form_action_received', runId, { formRef: md.formRef ?? null, operationId: operationId ?? null, actionName: action?.action?.name ?? null, agentId: m?.agentId ?? null });
    if (typeof operationId !== 'string' || !/^[\w-]{8,100}$/.test(operationId)) return reject('Missing or malformed operation ID.');
    if (!m) return reject('Unknown or altered form reference.');
    if (m.studentId !== studentId) return reject('This form belongs to another student.');
    if (m.upstreamContextId !== ctx.contextId) return reject('This form belongs to another conversation.');
    if (Date.now() - m.createdAt > FORM_TTL_MS) return reject('This form has expired. Ask again to get a new one.');
    if (m.state === 'superseded') return reject('This form was replaced by a newer one.');
    if (action?.action?.surfaceId !== m.downstream.formId) return reject('The action does not match this form.');

    // Dedupe at the Hub: an identical retry returns the stored result; reuse with other values is refused.
    const payloadHash = hash({ name: action.action.name, context: action.action.context, ack: md.reviewAcknowledged === true });
    const previous = operations.get(operationId);
    if (previous) {
      if (previous.hash !== payloadHash || previous.formRef !== m.formRef) return reject('This operation ID was already used with different values.');
      emit('form_action_duplicate', runId, { formRef: m.formRef, operationId, status: previous.result.body.status });
      return respond({ ...previous.result.body, duplicate: true }, { a2ui: previous.result.a2ui, closed: previous.result.closed });
    }
    if (m.state === 'closed') return reject('This form is already completed.');

    // Submissions follow the recorded mapping to the ISSUING specialist — never semantic re-routing.
    const peer = registry.peer(m.agentId);
    emit('form_forwarded', runId, { formRef: m.formRef, operationId, agentId: m.agentId, actionName: action.action.name, downstreamTaskId: m.downstream.taskId, upstreamTaskId: ctx.taskId });
    try {
      const result = await sendFormAction(peer.baseUrl, {
        form: m.downstream, action: action.action, operationId, runId, card: registry.entry(m.agentId)?.card ?? undefined,
        acknowledgeReview: md.reviewAcknowledged === true, timeoutMs: cfg.timeouts.formActionMs, metadata: { hubOperationId: operationId, via: cfg.agentId },
      });
      registry.markReachable(m.agentId, true);
      const closed = ['accepted', 'cancelled'].includes(result.body.status);
      if (closed) m.state = 'closed';
      const body = { ...result.body, formRef: m.formRef, servedBy: m.agentId };
      operations.set(operationId, { hash: payloadHash, formRef: m.formRef, result: { body, a2ui: result.a2uiUpdate, closed } });
      trim(operations);
      emit('form_result_relayed', runId, { formRef: m.formRef, operationId, agentId: m.agentId, status: body.status, receipt: body.receipt ? { id: body.receipt.requestId ?? body.receipt.bookingId } : null });
      respond(body, { a2ui: result.a2uiUpdate, closed });
    } catch (err) {
      // Not cached: an unknown outcome must be reconcilable with the same operation ID.
      const unknown = err.outcome === 'uncertain';
      if (!unknown) registry.markReachable(m.agentId, false, err.message);
      emit('form_forward_failed', runId, { formRef: m.formRef, operationId, agentId: m.agentId, outcome: unknown ? 'unknown' : 'not_delivered', message: err.message });
      if (unknown) return respond({ status: 'outcome_unknown', formRef: m.formRef, operationId, message: `The ${peer.displayName} didn’t confirm in time; the outcome is unknown. Check the status before trying again.` });
      respond({ status: 'not_delivered', formRef: m.formRef, operationId, message: `The ${peer.displayName} is unreachable, so nothing was submitted.` });
    }
  }

  // ---- telemetry (developer view; separate from A2A) ----------------------------------------
  function topologySnapshot() {
    return {
      hub: { agentId: cfg.agentId, name: cfg.name, role: 'University front door and router', status: 'ready', router: routerStatus(), active: counters.active, openForms: [...formRefs.values()].filter((m) => m.state === 'open').length,
        destinations: Object.entries(cfg.destinations).map(([dest, d]) => ({ destination: dest, worker: d.worker, workerName: registry.peer(d.worker)?.displayName ?? d.worker, description: d.description })) },
      specialists: registry.snapshot().map((s) => ({ ...s, destination: workerOf[s.agentId] ?? null, active: activeFor.get(s.agentId) ?? 0 })),
      trust: 'Localhost spike: identities are self-declared and checked against the Hub’s allowlist and configured endpoints — not authentication.',
    };
  }
  // Relay each specialist's own visualization feed (trusted URLs from configuration), redacted.
  const feedAbort = new AbortController();
  const feeds = Object.fromEntries(cfg.peers.map((p) => [p.agentId, false]));
  const lastStatus = {}; // agentId → the specialist's latest 'status' event (mode, skills), for new viewers
  for (const peer of cfg.peers) {
    (async function follow() {
      while (!feedAbort.signal.aborted) {
        try {
          const res = await fetch(peer.vizUrl, { signal: feedAbort.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          feeds[peer.agentId] = true;
          emit('specialist_feed', null, { agentId: peer.agentId, connected: true });
          let buffer = '';
          for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const line = frame.split('\n').find((l) => l.startsWith('data: '));
              if (!line) continue;
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'status') lastStatus[peer.agentId] = { source: peer.agentId, type: 'status', runId: null, at: ev.at, data: ev.data };
              viz.emit('event', { source: peer.agentId, type: ev.type, runId: ev.runId ?? null, at: ev.at, data: redactTelemetry(ev) });
            }
          }
        } catch {
          // specialist down; reported below
        }
        if (feeds[peer.agentId]) emit('specialist_feed', null, { agentId: peer.agentId, connected: false });
        feeds[peer.agentId] = false;
        if (!feedAbort.signal.aborted) await new Promise((r) => setTimeout(r, 1000));
      }
    })();
  }

  return new Promise((resolve, reject) => {
    const app = express();
    const server = app.listen(port ?? 41243, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      const baseUrl = `http://${HOST}:${actualPort}`;
      // The PUBLIC university card. Specialist cards and endpoints are never part of it.
      const card = {
        name: cfg.name,
        description: cfg.description,
        version: '0.1.0',
        supportedInterfaces: [{ url: `${baseUrl}${JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }],
        provider: undefined,
        capabilities: {
          streaming: false, pushNotifications: false,
          extensions: [{ uri: A2UI_EXTENSION_URI, description: 'Relays A2UI v0.9 forms (basic catalog) from university services and accepts A2UI actions.', required: false, params: { supportedCatalogIds: [BASIC_CATALOG_ID], acceptsInlineCatalogs: false } }],
        },
        securitySchemes: {}, securityRequirements: [],
        defaultInputModes: ['text/plain', A2UI_MIME_TYPE],
        defaultOutputModes: ['text/plain', A2UI_MIME_TYPE, 'application/json'],
        // One public skill per capability (destination). A Student may name one of these IDs as
        // `requestedCapability`; the Hub still maps it to its own worker and checks readiness.
        skills: Object.entries(cfg.destinations).map(([id, d]) => ({
          id, name: d.name ?? id, description: d.description ?? '', tags: d.tags ?? [id], examples: d.examples ?? [],
          inputModes: ['text/plain', A2UI_MIME_TYPE], outputModes: ['text/plain', A2UI_MIME_TYPE, 'application/json'], securityRequirements: [],
        })),
        signatures: [],
      };
      const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
      app.use(hostGuard(actualPort));
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      // Developer telemetry (read-only).
      app.get('/viz/topology', (req, res) => res.json({ ...topologySnapshot(), feeds }));
      app.get('/viz/events', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ source: 'hub', type: 'status', runId: null, at: new Date().toISOString(), data: { ...topologySnapshot(), feeds } })}\n\n`);
        for (const ev of Object.values(lastStatus)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        viz.on('event', forward);
        req.on('close', () => viz.off('event', forward));
      });
      // Developer skill settings, proxied to the specialist's TRUSTED settings URL (local developer controls).
      const dev = express.Router();
      dev.use(express.json({ limit: '64kb' }));
      const proxy = (path, method) => async (req, res) => {
        const peer = registry.peer(req.params.agentId);
        if (!peer) return res.status(404).json({ error: 'Unknown agent.' });
        try {
          const upstream = await fetch(peer.settingsUrl + path, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(req.body ?? {}), signal: AbortSignal.timeout(5000) });
          res.status(upstream.status).json(await upstream.json());
        } catch {
          res.status(502).json({ error: `${peer.displayName} is not reachable, so its settings can’t be read or saved.` });
        }
      };
      dev.get('/dev/agents/:agentId/skills', proxy('', 'GET'));
      dev.post('/dev/agents/:agentId/skills/preview', proxy('/preview', 'POST'));
      dev.put('/dev/agents/:agentId/skills', proxy('', 'PUT'));
      // Manual "Refresh skills": re-fetch every specialist card from its configured URL (no model calls).
      dev.post('/dev/registry/refresh', (req, res) => {
        for (const peer of cfg.peers) registry.refresh(peer.agentId, 'manual');
        res.status(202).json({});
      });
      app.use(dev);
      const close = () => { feedAbort.abort(); registry.stop(); return new Promise((r) => server.close(r)); };
      resolve({ server, baseUrl, close, registry });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.env.STUDENT_LOG_CONTENT ??= '0'; // the Hub never logs message text by default
  process.env.A2A_CLIENT_LABEL ??= '[Hub → specialist]';
  const port = process.env.PORT === undefined ? 41243 : Number(process.env.PORT);
  const { baseUrl } = await startHubServer({ port });
  log(`listening on ${baseUrl}`);
  log(`Public card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const r = routerStatus();
  log(`router: ${r.mode}${r.model ? ` (${r.model})` : ''}${r.mode === 'live' ? `, API key (${keyEnvName()}): ${r.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}`);
}
