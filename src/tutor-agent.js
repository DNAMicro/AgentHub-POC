// Agent B — "Tutor Agent". An A2A server: publishes an Agent Card and answers
// `SendMessage` over the JSON-RPC binding.
//
// It handles two kinds of incoming message:
//   * plain text              → the Tutor decides: answer (fixed Part 1 reply, or a mock/live Claude
//                                answer, per TUTOR_MODE), clarify, decline, or (Part 6) offer its
//                                in-person tutoring request form as an A2UI v0.9 Task in INPUT_REQUIRED
//   * an A2UI `action` DataPart → an action on a form it issued (src/form-host.js): validate, dedupe,
//                                call the allowlisted createTutoringRequest handler, acknowledge
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Role, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { hostGuard } from './local-guard.js';
import { createSkillService } from './agent-settings.js';
import { LOG_CONTENT, MODE, TutorError, answer, status as tutorStatus } from './tutor-model.js';
import { apiHost } from './llm.js';
import { A2UI_EXTENSION_URI, A2UI_MIME_TYPE, BASIC_CATALOG_ID, TIMEZONE_LABEL, TUTORING_HOURS, WORKFLOWS, buildTutoringForm, isA2uiPart, validateTutoringRequest } from './forms.js';
import { createFormHost } from './form-host.js';
import { reviewGate } from './form-review.js';
import { createTutoringStore } from './demo-store.js';
import { mockTutorIntent, tutoringPrefill, wantsReplacement } from './form-intent.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
export const TUTOR_REPLY = 'Hello Student Agent. Yes, I can help you with calculus.';

const VIZ_PATH = '/viz/events';
// Student Agent's A2A endpoint for agent_card_changed notifications (trusted local configuration).
const STUDENT_A2A_URL = process.env.STUDENT_A2A_URL ?? 'http://127.0.0.1:41240';
let firstSubmissionDelayMs = Number(process.env.TUTOR_TEST_DELAY_FIRST_SUBMISSION_MS ?? 0);

const log = (...args) => console.log('[Tutor Agent]', ...args);

// Visualization-only feed. Events are emitted from the executor at the moment
// they actually happen; nothing here carries or replaces A2A traffic.
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'tutor', type, runId, at: new Date().toISOString(), data });
const textOf = (message) =>
  message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

// In-memory demo records (requests, forms, operation results). Restarting the Tutor clears them.
const tutoringStore = createTutoringStore();
const WORKFLOW_ID = 'tutoring-request';
export const TUTORING_ACK = 'We received your request. A time slot will be sent based on your preferences.';
// Server-written texts (not model output) for the workflow outcomes.
const WORKFLOW_TEXT = {
  offer: 'Here is the in-person tutoring request form. Fill it in and press “Send tutoring request”.',
  info: `In-person calculus tutoring (demo): ask for it here — for example “I’d like to arrange in-person help with calculus” — and I’ll send a request form for your contact details, preferred date, morning or afternoon, an optional specific time, and what you’d like help with. It’s a request, not a booking: a time slot would be sent based on your preferences (this demo sends no messages). Sessions run ${TUTORING_HOURS.days}, ${TUTORING_HOURS.open}–${TUTORING_HOURS.close}, ${TIMEZONE_LABEL}.`,
  clarify: 'Would you like me to explain a calculus topic here, or to request an in-person tutoring session?',
  disabled: 'In-person tutoring requests aren’t offered by this Tutor right now.',
  noClient: 'I can send an in-person tutoring request form, but your client didn’t declare A2UI v0.9 support, so I can’t show it.',
  alreadyOpen: 'You already have an open tutoring request form above. Fill that one in, or say “replace the form” to start a new one.',
};
// Contact details stay out of logs whatever LOG_CONTENT says.
const redact = (values) => (values && typeof values === 'object' ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, ['firstName', 'lastName', 'email'].includes(k) ? '[redacted]' : LOG_CONTENT ? v : '[not logged]'])) : values);

function buildAgentCard(port) {
  return {
    name: 'Tutor Agent',
    description: 'Tutor. Its subjects come from its saved skill configuration (calculus by default) and are enforced on every request.',
    version: '0.1.0',
    supportedInterfaces: [
      {
        url: `http://${HOST}:${port}${JSONRPC_PATH}`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: '',
      },
    ],
    provider: undefined,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: A2UI_EXTENSION_URI,
          description: 'Sends A2UI v0.9 surfaces (basic catalog) and accepts A2UI actions.',
          required: false,
          params: { supportedCatalogIds: [BASIC_CATALOG_ID], acceptsInlineCatalogs: false },
        },
      ],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain', A2UI_MIME_TYPE],
    defaultOutputModes: ['text/plain', A2UI_MIME_TYPE, 'application/json'],
    skills: [], // filled from the skill configuration (src/agent-settings.js)
    signatures: [],
  };
}

// Tutoring skills are answered by the model within their scope; their answer content is optional
// reference notes. The in-person tutoring request workflow is a built-in form skill handled by code.
const TUTOR_RULES = { answer: { knowledge: 'optional' }, form: { id: WORKFLOWS[WORKFLOW_ID].skillId } };

// Initial skills. Edited through the gear dialog; in memory only (a restart restores these).
export const TUTOR_DEFAULT_SKILLS = {
  skills: [
    {
      id: 'calculus-tutoring', kind: 'answer', enabled: true,
      name: 'Calculus tutoring',
      description: 'Explains calculus concepts and works through calculus exercises: limits, derivatives, and integrals.',
      tags: ['calculus', 'limits', 'derivatives', 'integrals', 'exercises'],
      examples: ['Explain the derivative of x squared', 'What is the limit of sin(x)/x as x approaches 0?', 'Integrate 2x from 0 to 3'],
      scope: {
        allowed: ['limits and continuity', 'derivatives and differentiation rules', 'integrals and integration', 'calculus exercises and worked examples', 'algebra steps needed inside a calculus explanation'],
        excluded: ['standalone physics lessons (Newton’s laws, mechanics, electrical circuits)', 'standalone math outside calculus', 'non-academic topics such as home repair or plumbing', 'library services such as borrowing or renewals'],
      },
      knowledge: '', // optional reference notes for the model; the subject itself comes from the model
    },
    {
      id: 'in-person-tutoring-request', kind: 'form', enabled: true,
      name: 'In-person tutoring requests',
      description: 'Takes requests for an in-person calculus tutoring session: sends a form for contact details, preferred date, morning or afternoon, and what you need help with. A request, not a booking (demo).',
      tags: ['in-person tutoring', 'tutoring session', 'meet a tutor', 'tutoring request'],
      examples: ['I want to arrange in-person help with calculus', 'Can I meet a tutor about derivatives tomorrow afternoon?'],
      scope: { allowed: ['requests for an in-person calculus tutoring session', 'explaining how in-person tutoring requests work'], excluded: ['confirming or booking appointment times'] },
      knowledge: '',
    },
  ],
};

let skillService = null; // set when the server starts
// The tutoring part of the current policy: enabled skills served by the model.
const tutoringPolicy = () => {
  const policy = skillService.policy();
  return { revision: policy.revision, skills: policy.skills.filter((s) => s.kind === 'answer') };
};
const workflowEnabled = () => skillService.policy().skills.some((s) => s.id === WORKFLOWS[WORKFLOW_ID].skillId);

// The tutoring request workflow: template + allowlisted actions. Only server code runs the handler.
const formHost = createFormHost({
  agentId: 'tutor',
  isEnabled: (workflowId) => workflowId === WORKFLOW_ID && workflowEnabled(),
  emitViz, log, logValues: redact,
  workflows: {
    [WORKFLOW_ID]: {
      build: buildTutoringForm,
      actions: {
        async submitTutoringRequest(form, context, tools) {
          const checked = validateTutoringRequest(context);
          if (!checked.ok) return { status: 'rejected', message: 'Please correct the highlighted fields.', errors: checked.errors };
          // Advisory review of every field (model in live mode); it can only send the form back with flags.
          const flagged = await reviewGate({ form, workflowId: WORKFLOW_ID, values: checked.values, acknowledged: tools.reviewAcknowledged, live: MODE === 'live', emit: tools.emit });
          if (flagged) return flagged;
          const record = tutoringStore.createTutoringRequest(checked.values);
          log('recorded tutoring request', { requestId: record.requestId, preferences: LOG_CONTENT ? record.preferences : '[not logged]' });
          return {
            status: 'accepted', message: TUTORING_ACK, values: checked.values,
            receipt: { requestId: record.requestId, status: record.status, preferences: record.preferences, timezone: TIMEZONE_LABEL, demo: true, note: 'Demo request — this spike sends no email or scheduling message.' },
          };
        },
        async cancelForm() {
          return { status: 'cancelled', message: 'Form cancelled. Nothing was submitted.' };
        },
      },
    },
  },
});

// ---- message construction ---------------------------------------------------

const textPart = (value) => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });

function agentMessage(ctx, parts, { taskId = '', metadata } = {}) {
  return { messageId: randomUUID(), contextId: ctx.contextId, taskId, role: Role.ROLE_AGENT, parts, metadata, extensions: [], referenceTaskIds: [] };
}

// ---- handlers -----------------------------------------------------------------

async function handleChat(ctx, bus, runId) {
  const incoming = ctx.userMessage;
  const question = textOf(incoming);
  const received = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId, text: question };
  log('received message', LOG_CONTENT ? received : { ...received, text: `[${question.length} chars, content not logged]` });
  emitViz('message_received', runId, received);

  let text = TUTOR_REPLY;
  const metadata = { ...(runId ? { runId } : {}), agentId: 'tutor', tutorMode: MODE };
  // Fixed mode has no model: the deterministic workflow heuristic decides form requests.
  const fixedIntent = MODE === 'fixed' ? mockTutorIntent(question) : null;
  if (fixedIntent) {
    emitViz('intent_decided', runId, { outcome: fixedIntent, by: 'heuristic (fixed mode)' });
    if (fixedIntent === 'offer') return offerWorkflow(ctx, bus, runId, question, metadata);
    text = fixedIntent === 'info' ? WORKFLOW_TEXT.info : WORKFLOW_TEXT.clarify;
    metadata.tutor = { outcome: fixedIntent === 'info' ? 'workflow_info' : 'clarify' };
  } else if (MODE === 'fixed') {
    // Part 1 connectivity reply. Still subject to the code-level check: no enabled tutoring skill → decline.
    const policy = tutoringPolicy();
    if (!policy.skills.length) {
      text = 'This Tutor has no tutoring skills enabled right now, so it isn’t answering questions.';
      metadata.tutor = { outcome: 'disabled', scope: { verdict: 'disabled', policyRevision: policy.revision } };
      emitViz('scope_checked', runId, { stage: 'policy', verdict: 'disabled', reason: 'No tutoring skill is enabled.', policyRevision: policy.revision });
    }
  } else {
    try {
      const result = await answer({
        contextId: ctx.contextId,
        messageId: incoming.messageId,
        question,
        getPolicy: tutoringPolicy,
        workflow: { enabled: workflowEnabled() },
        emit: (type, data) => emitViz(type, runId, data),
      });
      if (result.kind === 'offer_form') return offerWorkflow(ctx, bus, runId, question, metadata);
      text = result.kind === 'workflow_info' ? WORKFLOW_TEXT.info : result.kind === 'workflow_disabled' ? WORKFLOW_TEXT.disabled : result.text;
      metadata.tutor = { outcome: result.kind, scope: result.scope ?? null, model: result.model, latencyMs: result.latencyMs, usage: result.usage, stopReason: result.stopReason, truncated: result.truncated, requestId: result.requestId, duplicate: result.duplicate };
    } catch (err) {
      // Sanitized error only — never the provider's raw message, never a canned "success".
      const failure = err instanceof TutorError ? err : new TutorError('internal_error');
      text = `The Tutor Agent could not answer: ${failure.message}`;
      metadata.tutorError = { code: failure.code, message: failure.message, requestId: failure.requestId };
      if (failure.rateLimit) log('rate limit details', failure.rateLimit);
    }
  }

  const reply = agentMessage(ctx, [textPart(text)], { metadata });
  const sent = { messageId: reply.messageId, contextId: reply.contextId, inReplyTo: incoming.messageId, text, tutor: metadata.tutor, tutorError: metadata.tutorError };
  log('sending reply', LOG_CONTENT ? sent : { ...sent, text: `[${text.length} chars, content not logged]` });
  bus.publish(AgentEvent.message(reply));
  bus.finished();
  // The SDK now returns `reply` as the JSON-RPC result; delivery is confirmed by the Student, not here.
  emitViz('reply_published', runId, sent);
}

// The request asks for the tutoring workflow: send the form (or say why not). Prefill comes only
// from the student's own words (parsed in code), never from the model; names and emails never.
function offerWorkflow(ctx, bus, runId, question, metadata) {
  const reply = (text, outcome) => {
    const message = agentMessage(ctx, [textPart(text)], { metadata: { ...metadata, tutor: { outcome } } });
    bus.publish(AgentEvent.message(message));
    bus.finished();
    emitViz('reply_published', runId, { messageId: message.messageId, contextId: ctx.contextId, inReplyTo: ctx.userMessage.messageId, text, tutor: { outcome } });
  };
  if (!workflowEnabled()) return reply(WORKFLOW_TEXT.disabled, 'workflow_disabled');
  if (!formHost.clientSupportsForms(ctx.userMessage)) return reply(WORKFLOW_TEXT.noClient, 'workflow_unsupported_client');
  const open = formHost.openForm(ctx.contextId, WORKFLOW_ID);
  // Never stack a second form or silently drop a draft: ask, unless the student explicitly asked to replace it.
  if (open && open !== formHost.formForRequest(ctx) && !wantsReplacement(question)) return reply(WORKFLOW_TEXT.alreadyOpen, 'clarify');
  formHost.issue(ctx, bus, { workflowId: WORKFLOW_ID, prefill: tutoringPrefill(question), runId, intro: WORKFLOW_TEXT.offer, supersedes: open === formHost.formForRequest(ctx) ? null : open });
}

// The agent's business logic. The SDK calls execute() for every incoming message.
const tutorExecutor = {
  async execute(requestContext, eventBus) {
    const incoming = requestContext.userMessage;
    // Set by the UI's Student Agent so visualization events can be correlated; absent for CLI runs.
    const runId = incoming.metadata?.runId ?? null;
    const a2ui = incoming.parts.find(isA2uiPart);
    if (a2ui) {
      // Test hook (off unless the env var is set): process the first submission slowly, so a
      // client timeout leaves delivery genuinely uncertain while the Tutor still records it.
      if (firstSubmissionDelayMs > 0) {
        const delay = firstSubmissionDelayMs;
        firstSubmissionDelayMs = 0;
        await new Promise((r) => setTimeout(r, delay));
      }
      return formHost.handleAction(requestContext, eventBus, runId, a2ui);
    }
    return handleChat(requestContext, eventBus, runId);
  },
  async cancelTask() {
    // Nothing long-running to cancel: every reply is immediate. Forms are cancelled with their own action.
  },
};

// Server-sent events stream of vizEvents. Live only: no replay, no inputs.
function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  // Mode and whether a key is present (yes/no only) — never the key itself.
  res.write(`data: ${JSON.stringify({ source: 'tutor', type: 'status', runId: null, at: new Date().toISOString(), data: { ...tutorStatus(), skills: skillService?.describe() ?? null } })}\n\n`);
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

export function startTutorServer({ port = 41241 } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    // Routes are mounted after listen() so the Agent Card carries the real port
    // (tests pass port 0 to get a free ephemeral port).
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      const baseUrl = `http://${HOST}:${actualPort}`;
      const card = buildAgentCard(actualPort);
      // The skill service writes the saved configuration into this live card object.
      skillService = createSkillService({
        agentId: 'tutor', agentName: card.name, defaults: TUTOR_DEFAULT_SKILLS, rules: TUTOR_RULES, card,
        emit: (type, data) => emitViz(type, null, data), log, studentUrl: STUDENT_A2A_URL,
      });
      const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), tutorExecutor);
      app.use(hostGuard(actualPort));
      // maxAge 0 → "Cache-Control: no-cache": clients revalidate with the ETag on every read.
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.get(VIZ_PATH, serveVizEvents);
      app.use(skillService.router());
      skillService.started(actualPort, `${baseUrl}/${AGENT_CARD_PATH}`);
      resolve({ server, baseUrl });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT === undefined ? 41241 : Number(process.env.PORT);
  const { baseUrl } = await startTutorServer({ port });
  log(`listening on ${baseUrl}`);
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const s = tutorStatus();
  log(`mode: ${s.mode}${s.model ? ` (model: ${s.model})` : ''}${s.mode === 'live' ? `, API key: ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}, message contents in logs: ${s.logContent ? 'on' : 'off'}`);
}
