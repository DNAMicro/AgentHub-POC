// Agent B — "Tutor Agent". An A2A server: publishes an Agent Card and answers
// `SendMessage` over the JSON-RPC binding. Replies are deterministic (no LLM).
//
// It handles three kinds of incoming message:
//   * plain text                      → the fixed chat reply (Part 1)
//   * metadata.request = form request → a Task in INPUT_REQUIRED carrying an A2UI v0.9 form (Part 3)
//   * an A2UI `action` DataPart        → a form submission: validate, dedupe, record, acknowledge
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Role, TaskState, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { hostGuard } from './local-guard.js';
import {
  A2UI_EXTENSION_URI, A2UI_MIME_TYPE, A2UI_VERSION, BASIC_CATALOG_ID, FORM_REQUEST,
  buildStudentDetailsForm, isA2uiPart, validateAction,
} from './student-form.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
export const TUTOR_REPLY = 'Hello Student Agent. Yes, I can help you with calculus.';

const VIZ_PATH = '/viz/events';
let firstSubmissionDelayMs = Number(process.env.TUTOR_TEST_DELAY_FIRST_SUBMISSION_MS ?? 0);

const log = (...args) => console.log('[Tutor Agent]', ...args);

// Visualization-only feed. Events are emitted from the executor at the moment
// they actually happen; nothing here carries or replaces A2A traffic.
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'tutor', type, runId, at: new Date().toISOString(), data });
const textOf = (message) =>
  message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

// In-memory records. Restarting the Tutor clears them.
const forms = new Map(); // formId (= A2UI surfaceId) → { taskId, contextId, state: 'awaiting_input' | 'accepted' }
const submissions = new Map(); // submissionId → { formId, values, ack }

function buildAgentCard(port) {
  return {
    name: 'Tutor Agent',
    description: 'Deterministic tutor used to verify A2A connectivity.',
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
    skills: [
      {
        id: 'calculus-help',
        name: 'Calculus help',
        description: 'Confirms it can help with calculus.',
        tags: ['calculus'],
        examples: ['Can you help me with calculus?'],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
      {
        id: 'student-details-form',
        name: 'Student details form',
        description: `Send metadata.request="${FORM_REQUEST}" to receive an A2UI form; submit it with an A2UI action.`,
        tags: ['a2ui', 'form'],
        examples: [],
        inputModes: [A2UI_MIME_TYPE],
        outputModes: [A2UI_MIME_TYPE, 'application/json'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

// ---- message construction ---------------------------------------------------

const textPart = (value) => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const jsonPart = (value) => ({ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' });
// A2A v1.0 Parts have a native mediaType; the A2UI extension spec (written against A2A v0.3
// examples) names metadata.mimeType. Set both so either reading finds it.
const a2uiPart = (messages) => ({ content: { $case: 'data', value: messages }, metadata: { mimeType: A2UI_MIME_TYPE }, filename: '', mediaType: A2UI_MIME_TYPE });

function agentMessage(ctx, parts, { taskId = '', metadata } = {}) {
  return { messageId: randomUUID(), contextId: ctx.contextId, taskId, role: Role.ROLE_AGENT, parts, metadata, extensions: [], referenceTaskIds: [] };
}
const status = (state, message) => ({ state, message, timestamp: new Date().toISOString() });

// ---- handlers -----------------------------------------------------------------

function handleChat(ctx, bus, runId) {
  const incoming = ctx.userMessage;
  const received = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId, text: textOf(incoming) };
  log('received message', received);
  emitViz('message_received', runId, received);

  const reply = agentMessage(ctx, [textPart(TUTOR_REPLY)], { metadata: runId ? { runId } : undefined });
  const sent = { messageId: reply.messageId, contextId: reply.contextId, inReplyTo: incoming.messageId, text: TUTOR_REPLY };
  log('sending reply', sent);
  bus.publish(AgentEvent.message(reply));
  bus.finished();
  // The SDK now returns `reply` as the JSON-RPC result; delivery is confirmed by the Student, not here.
  emitViz('reply_published', runId, sent);
}

function handleFormRequest(ctx, bus, runId) {
  const incoming = ctx.userMessage;
  const ids = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId };
  log('received form request', ids);
  emitViz('form_request_received', runId, ids);

  const caps = incoming.metadata?.a2uiClientCapabilities?.[A2UI_VERSION];
  if (!caps?.supportedCatalogIds?.includes(BASIC_CATALOG_ID)) {
    const reply = agentMessage(ctx, [textPart(`I can only send forms to clients that support A2UI ${A2UI_VERSION} with the basic catalog.`)], { metadata: runId ? { runId } : undefined });
    bus.publish(AgentEvent.message(reply));
    bus.finished();
    emitViz('form_request_refused', runId, { ...ids, reason: 'client lacks A2UI v0.9 basic catalog capability' });
    return;
  }

  const formId = `student-details-${randomUUID().slice(0, 8)}`;
  const a2ui = buildStudentDetailsForm(formId);
  const message = agentMessage(ctx, [textPart('Please fill in your details.'), a2uiPart(a2ui)], { taskId: ctx.taskId, metadata: { runId, formId } });
  forms.set(formId, { taskId: ctx.taskId, contextId: ctx.contextId, state: 'awaiting_input' });

  // INPUT_REQUIRED keeps the task open so the submission can resume it with the same taskId.
  bus.publish(AgentEvent.task({
    id: ctx.taskId, contextId: ctx.contextId, status: status(TaskState.TASK_STATE_INPUT_REQUIRED, message),
    artifacts: [], history: [], metadata: { runId, formId },
  }));
  bus.finished();
  log('sent form', { formId, ...ids, messageId: message.messageId });
  emitViz('form_sent', runId, { formId, ...ids, messageId: message.messageId, a2uiMessages: a2ui.length });
}

function handleSubmission(ctx, bus, runId, part) {
  const incoming = ctx.userMessage;
  const resuming = Boolean(ctx.task); // true: resumed the form's INPUT_REQUIRED task; false: new correlated message
  const submissionId = incoming.metadata?.submissionId;
  const messages = part.content.value;
  const action = Array.isArray(messages) && messages.length === 1 ? messages[0] : null;
  const formId = action?.action?.surfaceId;
  const form = forms.get(formId);
  const ids = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId, formId, submissionId, resumedTask: resuming };

  log('received submission', { ...ids, context: action?.action?.context });
  emitViz('submission_received', runId, { ...ids, receivedValues: action?.action?.context ?? null, actionName: action?.action?.name ?? null });

  // Reply on the same task when resuming (keeping it open on rejection), or as a direct Message otherwise.
  const respond = (state, parts, metadata) => {
    if (resuming) {
      bus.publish(AgentEvent.task(ctx.task));
      bus.publish(AgentEvent.statusUpdate({
        taskId: ctx.taskId, contextId: ctx.contextId, metadata: undefined,
        status: status(state, agentMessage(ctx, parts, { taskId: ctx.taskId, metadata })),
      }));
    } else {
      bus.publish(AgentEvent.message(agentMessage(ctx, parts, { metadata })));
    }
    bus.finished();
  };
  const reject = (errors) => {
    log('rejected submission', { ...ids, errors });
    respond(TaskState.TASK_STATE_INPUT_REQUIRED, [textPart('Submission rejected. Please correct the fields.'), jsonPart({ status: 'rejected', formId, submissionId, errors })], { runId, formId, submissionId });
    emitViz('submission_rejected', runId, { ...ids, errors });
  };

  if (typeof submissionId !== 'string' || !/^[\w-]{8,100}$/.test(submissionId)) return reject({ _form: 'Missing or malformed submissionId.' });
  if (!form) return reject({ _form: 'Unknown form.' });
  // Correlation: the message must belong to this form's task and conversation.
  const correlated = resuming ? ctx.task.id === form.taskId : incoming.referenceTaskIds.includes(form.taskId) && ctx.contextId === form.contextId;
  if (!correlated) return reject({ _form: 'Submission is not correlated with this form’s task and conversation.' });

  const previous = submissions.get(submissionId);
  if (previous) {
    if (previous.formId !== formId || JSON.stringify(previous.raw) !== JSON.stringify(action.action.context)) {
      return reject({ _form: 'This submissionId was already used with different content.' });
    }
    // Duplicate: processed once already — return the identical acknowledgment, record nothing.
    log('duplicate submission — returning stored acknowledgment', ids);
    respond(TaskState.TASK_STATE_COMPLETED, [textPart(previous.ack.message), jsonPart(previous.ack)], { runId, formId, submissionId, duplicate: true });
    emitViz('submission_duplicate', runId, { ...ids, ackId: previous.ack.ackId });
    return;
  }

  const result = validateAction(action, formId);
  if (!result.ok) return reject(result.errors);
  if (form.state === 'accepted') return reject({ _form: 'This form was already submitted.' });

  const ack = {
    status: 'accepted', ackId: randomUUID(), formId, submissionId, recordedAt: new Date().toISOString(),
    message: `Thanks ${result.values.firstName}, your details were received.`,
  };
  submissions.set(submissionId, { formId, values: result.values, raw: action.action.context, ack });
  form.state = 'accepted';
  log('recorded submission', { ...ids, values: result.values });
  respond(TaskState.TASK_STATE_COMPLETED, [textPart(ack.message), jsonPart(ack)], { runId, formId, submissionId });
  emitViz('submission_accepted', runId, { ...ids, values: result.values, ackId: ack.ackId });
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
      return handleSubmission(requestContext, eventBus, runId, a2ui);
    }
    if (incoming.metadata?.request === FORM_REQUEST) return handleFormRequest(requestContext, eventBus, runId);
    return handleChat(requestContext, eventBus, runId);
  },
  async cancelTask() {
    // Nothing long-running to cancel: every reply is immediate.
  },
};

// Server-sent events stream of vizEvents. Live only: no replay, no inputs.
function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

export function startTutorServer({ port = 41241 } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    // Routes are mounted after listen() so the Agent Card carries the real port
    // (tests pass port 0 to get a free ephemeral port).
    const server = app.listen(port, HOST, () => {
      const actualPort = server.address().port;
      const requestHandler = new DefaultRequestHandler(buildAgentCard(actualPort), new InMemoryTaskStore(), tutorExecutor);
      app.use(hostGuard(actualPort));
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.get(VIZ_PATH, serveVizEvents);
      resolve({ server, baseUrl: `http://${HOST}:${actualPort}` });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT === undefined ? 41241 : Number(process.env.PORT);
  const { baseUrl } = await startTutorServer({ port });
  log(`listening on ${baseUrl}`);
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
}
