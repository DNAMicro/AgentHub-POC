// Agent A — "Student Agent". An A2A client: discovers the Tutor via its Agent
// Card, sends one message with the SDK client, and prints the actual reply.
import { randomUUID } from 'node:crypto';
import { Role, TaskState, HTTP_EXTENSION_HEADER } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import {
  A2UI_EXTENSION_URI, A2UI_MIME_TYPE, A2UI_VERSION, BASIC_CATALOG_ID, FORM_REQUEST,
  checkFormPayloadPolicy, isA2uiPart,
} from './student-form.js';

export const STUDENT_MESSAGE = 'Hello Tutor Agent. Can you help me with calculus?';

const log = (...args) => console.log('[Student Agent]', ...args);
const textOf = (message) =>
  message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

// `runId` travels to the Tutor in A2A Message.metadata so both sides' events can be
// correlated. `onEvent(type, data)` is a visualization hook called where each step happens.
export async function askTutor(baseUrl, text = STUDENT_MESSAGE, { runId, onEvent = () => {} } = {}) {
  try {
    return await exchange(baseUrl, text, runId, onEvent);
  } catch (err) {
    onEvent('request_failed', { error: err.message, code: err.cause?.code ?? null });
    throw err;
  }
}

async function exchange(baseUrl, text, runId, onEvent) {
  // 1. Discovery: GET <baseUrl>/.well-known/agent-card.json
  const card = await new DefaultAgentCardResolver().resolve(baseUrl);
  const discovered = {
    name: card.name,
    interfaces: card.supportedInterfaces.map((i) => `${i.protocolBinding} ${i.protocolVersion} ${i.url}`),
  };
  log('discovered Agent Card', discovered);
  onEvent('card_discovered', discovered);

  // 2. The factory picks a transport from the card's supportedInterfaces.
  const client = await new ClientFactory().createFromAgentCard(card);

  const message = {
    messageId: randomUUID(),
    contextId: '', // empty: let the server start a new context
    taskId: '',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: runId ? { runId } : undefined,
    extensions: [],
    referenceTaskIds: [],
  };
  log('sending message', { messageId: message.messageId, text });
  // "Send started" only: receipt is confirmed separately by the Tutor's own event.
  onEvent('request_sent', { messageId: message.messageId, text });

  // 3. SendMessage over the A2A JSON-RPC binding.
  const result = await client.sendMessage({ tenant: '', message, configuration: undefined, metadata: undefined });

  // A SendMessage result is either a Message or a Task; the Tutor always replies with a Message.
  if (!('messageId' in result) || result.role !== Role.ROLE_AGENT) {
    throw new Error(`Expected an agent Message, got: ${JSON.stringify(result)}`);
  }
  const reply = { messageId: result.messageId, contextId: result.contextId, taskId: result.taskId, text: textOf(result) };
  log('received reply', reply);
  onEvent('reply_received', { ...reply, runId: result.metadata?.runId ?? null });
  return reply;
}

// ---- Part 3: A2UI form over A2A ---------------------------------------------

const SUBMIT_TIMEOUT_MS = Number(process.env.SUBMIT_TIMEOUT_MS ?? 5000);
// Activates the A2UI extension for the request (sent as the A2A-Extensions HTTP header).
const A2UI_REQUEST_OPTIONS = { serviceParameters: { [HTTP_EXTENSION_HEADER]: A2UI_EXTENSION_URI } };

const fetchWithTimeout = (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(SUBMIT_TIMEOUT_MS) });

async function connect(baseUrl) {
  const card = await new DefaultAgentCardResolver({ fetchImpl: fetchWithTimeout }).resolve(baseUrl);
  if (!card.capabilities?.extensions?.some((e) => e.uri === A2UI_EXTENSION_URI)) {
    throw new Error(`Tutor Agent does not advertise the A2UI extension ${A2UI_EXTENSION_URI}`);
  }
  return new ClientFactory().createFromAgentCard(card);
}

const userMessage = (parts, extra) => ({
  messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, parts,
  metadata: undefined, extensions: [], referenceTaskIds: [], ...extra,
});
const statusMessage = (result) => ('messageId' in result ? result : result.status?.message);
const jsonData = (message) => message?.parts.find((p) => p.content?.$case === 'data' && p.mediaType === 'application/json')?.content.value;

// Ask the Tutor for the student-details form. Resolves with the validated A2UI messages
// and the A2A ids needed to submit it (the form's task stays INPUT_REQUIRED).
export async function requestForm(baseUrl, { runId, onEvent = () => {} } = {}) {
  try {
    const client = await connect(baseUrl);
    const message = userMessage([textPart('Please send me the student-details form.')], {
      metadata: {
        runId,
        request: FORM_REQUEST,
        a2uiClientCapabilities: { [A2UI_VERSION]: { supportedCatalogIds: [BASIC_CATALOG_ID] } },
      },
    });
    log('requesting form', { messageId: message.messageId });
    onEvent('form_requested', { messageId: message.messageId });

    const result = await client.sendMessage({ tenant: '', message, configuration: undefined, metadata: undefined }, A2UI_REQUEST_OPTIONS);
    if ('messageId' in result || result.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
      throw new Error(`Tutor did not return a form task: ${textOf(statusMessage(result) ?? { parts: [] }) || 'unexpected reply'}`);
    }
    const part = result.status.message.parts.find(isA2uiPart);
    const a2uiMessages = part?.content.value;
    const policyError = checkFormPayloadPolicy(a2uiMessages);
    if (policyError) throw new Error(`Rejected A2UI payload: ${policyError}`);

    const form = {
      formId: a2uiMessages[0].createSurface?.surfaceId,
      taskId: result.id,
      contextId: result.contextId,
      messageId: result.status.message.messageId,
      a2uiMessages,
    };
    log('received form', { formId: form.formId, taskId: form.taskId, contextId: form.contextId });
    // The checked A2UI messages ride along so the UI server can deliver them to the browser renderer.
    onEvent('form_received', { formId: form.formId, taskId: form.taskId, contextId: form.contextId, messageId: form.messageId, taskState: 'input-required', a2uiMessages });
    return form;
  } catch (err) {
    onEvent('form_request_failed', { error: err.message, code: err.cause?.code ?? null });
    throw err;
  }
}

// Was the submission definitely not delivered, or might the Tutor have processed it?
// Only a failure *while* the SendMessage request was in flight can be uncertain.
function deliveryOutcome(err, sendStarted) {
  if (!sendStarted || err.cause?.code === 'ECONNREFUSED') return 'not_delivered';
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message === 'fetch failed') return 'uncertain';
  return 'rejected'; // the Tutor answered with an error
}

// Send an A2UI action (the renderer's submit event) to the Tutor.
//
// Mapping: renderer `action` → A2UI client-to-server message `{version, action}` → A2A DataPart
// (application/a2ui+json) in a user Message whose metadata carries the submissionId.
// If the form's task is still INPUT_REQUIRED, the message resumes it (taskId). If it has already
// completed (e.g. a retry after an uncertain delivery), resuming would be illegal, so a new message
// in the same context references the task instead; the Tutor dedupes by submissionId.
export async function submitForm(baseUrl, { form, action, submissionId, runId, onEvent = () => {} }) {
  let sendStarted = false;
  try {
    const client = await connect(baseUrl);
    const task = await client.getTask({ tenant: '', id: form.taskId }, { signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) });
    const resume = task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED;
    const message = userMessage([a2uiDataPart([{ version: A2UI_VERSION, action }])], {
      contextId: form.contextId,
      ...(resume ? { taskId: form.taskId } : { referenceTaskIds: [form.taskId] }),
      metadata: { runId, submissionId, formId: form.formId },
    });
    const mode = resume ? 'resume-task' : 'new-message-referencing-task';
    log('sending submission', { submissionId, formId: form.formId, messageId: message.messageId, mode });
    onEvent('submission_sent', { submissionId, formId: form.formId, messageId: message.messageId, mode, taskId: resume ? form.taskId : null });

    sendStarted = true;
    const result = await client.sendMessage(
      { tenant: '', message, configuration: undefined, metadata: undefined },
      { ...A2UI_REQUEST_OPTIONS, signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) },
    );
    const reply = statusMessage(result);
    const body = jsonData(reply);
    const ids = { submissionId, formId: form.formId, messageId: reply?.messageId, contextId: result.contextId, taskId: 'messageId' in result ? null : result.id, duplicate: Boolean(reply?.metadata?.duplicate) };
    if (body?.status === 'accepted') {
      log('received acknowledgment', { ...ids, ackId: body.ackId });
      onEvent('ack_received', { ...ids, ack: body });
    } else {
      log('submission rejected by Tutor', { ...ids, errors: body?.errors });
      onEvent('submission_rejected', { ...ids, errors: body?.errors ?? { _form: 'Unrecognized reply.' } });
    }
    return { ...ids, body };
  } catch (err) {
    const outcome = deliveryOutcome(err, sendStarted);
    log('submission failed', { submissionId, outcome, error: err.message });
    onEvent('submission_failed', { submissionId, outcome, error: err.message, code: err.cause?.code ?? null });
    throw Object.assign(err, { outcome });
  }
}

const textPart = (value) => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const a2uiDataPart = (messages) => ({ content: { $case: 'data', value: messages }, metadata: { mimeType: A2UI_MIME_TYPE }, filename: '', mediaType: A2UI_MIME_TYPE });

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.env.TUTOR_URL ?? 'http://127.0.0.1:41241';
  try {
    const reply = await askTutor(baseUrl);
    console.log(`\nTutor Agent replied: ${reply.text}`);
  } catch (err) {
    const cause = err.cause?.code ?? err.cause?.message;
    console.error(`[Student Agent] FAILED to reach Tutor Agent at ${baseUrl}: ${err.message}${cause ? ` (${cause})` : ''}`);
    process.exitCode = 1;
  }
}
