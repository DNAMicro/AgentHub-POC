// Agent A — "Student Agent". An A2A client: discovers the Tutor via its Agent
// Card, sends one message with the SDK client, and prints the actual reply.
import { randomUUID } from 'node:crypto';
import { Role, TaskState, HTTP_EXTENSION_HEADER } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import {
  A2UI_EXTENSION_URI, A2UI_MIME_TYPE, A2UI_VERSION, BASIC_CATALOG_ID,
  checkFormPayloadPolicy, checkFormUpdatePolicy, isA2uiPart,
} from './forms.js';

export const STUDENT_MESSAGE = 'Hello Tutor Agent. Can you help me with calculus?';

// The Hub reuses this client for its downstream leg and relabels its log lines (A2A_CLIENT_LABEL).
const log = (...args) => console.log(process.env.A2A_CLIENT_LABEL ?? '[Student Agent]', ...args);
const textOf = (message) =>
  message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 60000);
// The UI server turns this off so question/answer text stays out of its logs; the CLI keeps it.
const logContent = () => process.env.STUDENT_LOG_CONTENT !== '0';
const shown = (text) => (logContent() ? text : `[${text.length} chars, content not logged]`);

// `runId` travels to the Tutor in A2A Message.metadata so both sides' events can be
// correlated. `onEvent(type, data)` is a visualization hook called where each step happens.
//
// `contextId` names the conversation (the Tutor keeps history per contextId); empty lets the
// server start a new one. `messageId` is the request ID: re-sending the same one asks the Tutor
// for the result of that request again instead of a new answer (no second model call).
// `card`: an already-validated Agent Card (from Student's trusted registry). When given, it is used
// as-is instead of fetching the card again, so the destination is the registry's vetted endpoint.
// metadata: extra A2A message metadata (Part 7: the Student's identity to the Hub; the Hub's operation ID downstream).
// signer({ contextId, messageId }): Part 9 — the Student agent's session signature for the Hub (optional).
export async function askTutor(baseUrl, text = STUDENT_MESSAGE, { runId, contextId = '', messageId = randomUUID(), timeoutMs = CHAT_TIMEOUT_MS, card, metadata = {}, signer = null, onEvent = () => {} } = {}) {
  let sendStarted = false;
  // A signed request names its own context (the signature covers it; a server-assigned one couldn't be).
  if (signer && !contextId) contextId = randomUUID();
  try {
    return await exchange(baseUrl, text, { runId, contextId, messageId, timeoutMs, card, metadata, signer }, onEvent, () => (sendStarted = true));
  } catch (err) {
    if (err.tutorError) throw err; // A2A worked; the Tutor reported its own failure (already emitted)
    const outcome = deliveryOutcome(err, sendStarted);
    onEvent('request_failed', { error: err.message, code: err.cause?.code ?? null, outcome, messageId });
    throw Object.assign(err, { outcome });
  }
}

async function exchange(baseUrl, text, { runId, contextId, messageId, timeoutMs, card: knownCard, metadata: extra = {}, signer = null }, onEvent, markSendStarted) {
  // 1. Discovery: GET <baseUrl>/.well-known/agent-card.json
  const card = knownCard ?? (await new DefaultAgentCardResolver().resolve(baseUrl));
  const discovered = {
    name: card.name,
    interfaces: card.supportedInterfaces.map((i) => `${i.protocolBinding} ${i.protocolVersion} ${i.url}`),
  };
  log('discovered Agent Card', discovered);
  onEvent('card_discovered', discovered);

  // 2. The factory picks a transport from the card's supportedInterfaces.
  const client = await new ClientFactory().createFromAgentCard(card);

  const message = {
    messageId,
    contextId, // empty: let the server start a new context
    taskId: '',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    // Declares what UI this client can render, so the receiving agent may answer with a form (Part 6).
    metadata: { ...extra, ...(runId ? { runId } : {}), a2uiClientCapabilities: A2UI_CAPABILITIES },
    extensions: [],
    referenceTaskIds: [],
  };
  if (signer) message.metadata.studentSignature = signer({ contextId: message.contextId, messageId: message.messageId });
  log('sending message', { messageId: message.messageId, contextId: contextId || '(new)', text: shown(text) });
  // "Send started" only: receipt is confirmed separately by the Tutor's own event.
  onEvent('request_sent', { messageId: message.messageId, contextId: contextId || null, text });

  // 3. SendMessage over the A2A JSON-RPC binding.
  markSendStarted();
  const result = await client.sendMessage({ tenant: '', message, configuration: undefined, metadata: undefined }, { ...A2UI_REQUEST_OPTIONS, signal: AbortSignal.timeout(timeoutMs) });

  // A SendMessage result is either a Message (an answer) or a Task. A Task in INPUT_REQUIRED
  // carrying A2UI is a form the agent decided to send (Part 6); anything else is unexpected.
  if (!('messageId' in result)) return formFromTask(result, { messageId, onEvent });
  if (result.role !== Role.ROLE_AGENT) throw new Error(`Expected an agent Message, got: ${JSON.stringify(result)}`);
  const ids = { messageId: result.messageId, contextId: result.contextId, taskId: result.taskId, inReplyTo: messageId };
  // A service-reported failure (Tutor: tutorError; Library: serviceError) — A2A itself worked.
  const tutorError = result.metadata?.tutorError ?? result.metadata?.serviceError;
  if (tutorError) {
    // The A2A exchange succeeded, but the Tutor couldn't produce an answer (e.g. provider failure).
    log('Tutor reported an error', { ...ids, code: tutorError.code });
    onEvent('tutor_error', { ...ids, ...tutorError, tutorMode: result.metadata?.tutorMode ?? null });
    throw Object.assign(new Error(tutorError.message), { tutorError, outcome: 'answered_with_error' });
  }
  const reply = { ...ids, text: textOf(result), servedBy: result.metadata?.agentId ?? null, servedByName: result.metadata?.servedByName ?? null, tutorMode: result.metadata?.tutorMode ?? null, tutor: result.metadata?.tutor ?? null, library: result.metadata?.library ?? null, hub: result.metadata?.hub ?? null };
  log('received reply', { ...reply, text: shown(reply.text) });
  onEvent('reply_received', { ...reply, runId: result.metadata?.runId ?? null });
  return reply;
}

// ---- A2UI forms over A2A (Parts 3 and 6) ------------------------------------------------

const SUBMIT_TIMEOUT_MS = Number(process.env.SUBMIT_TIMEOUT_MS ?? 5000);
const A2UI_CAPABILITIES = { [A2UI_VERSION]: { supportedCatalogIds: [BASIC_CATALOG_ID] } };
// Activates the A2UI extension for the request (sent as the A2A-Extensions HTTP header).
const A2UI_REQUEST_OPTIONS = { serviceParameters: { [HTTP_EXTENSION_HEADER]: A2UI_EXTENSION_URI } };

const fetchWithTimeout = (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(SUBMIT_TIMEOUT_MS) });

async function connect(baseUrl, knownCard) {
  const card = knownCard ?? (await new DefaultAgentCardResolver({ fetchImpl: fetchWithTimeout }).resolve(baseUrl));
  if (!card.capabilities?.extensions?.some((e) => e.uri === A2UI_EXTENSION_URI)) {
    throw new Error(`${card.name} does not advertise the A2UI extension ${A2UI_EXTENSION_URI}`);
  }
  return new ClientFactory().createFromAgentCard(card);
}

const userMessage = (parts, extra) => ({
  messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, parts,
  metadata: undefined, extensions: [], referenceTaskIds: [], ...extra,
});
const statusMessage = (result) => ('messageId' in result ? result : result.status?.message);
const jsonData = (message) => message?.parts.find((p) => p.content?.$case === 'data' && p.mediaType === 'application/json')?.content.value;

// A chat reply that is a form: check the A2UI payload against the allowlist before anything renders.
function formFromTask(task, { messageId, onEvent }) {
  const msg = task.status?.message;
  const part = msg?.parts.find(isA2uiPart);
  if (task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED || !part) {
    throw new Error(`Expected an agent Message or a form task, got: ${textOf(msg ?? { parts: [] }) || 'unexpected reply'}`);
  }
  const a2uiMessages = part.content.value;
  const meta = msg.metadata ?? {};
  // Generated surfaces (Part 8) may use the wider generated catalog set; fixed forms keep the form set.
  const policyError = checkFormPayloadPolicy(a2uiMessages, { workflowId: meta.workflowId });
  if (policyError) throw new Error(`Rejected A2UI payload: ${policyError}`);
  const form = {
    formId: a2uiMessages[0].createSurface.surfaceId,
    workflowId: meta.workflowId ?? null,
    formVersion: meta.formVersion ?? null,
    issuer: meta.issuer ?? meta.agentId ?? null,
    supersedes: typeof meta.supersedes === 'string' ? meta.supersedes : null,
    formRef: typeof meta.formRef === 'string' ? meta.formRef : null, // Part 7: the Hub's opaque reference for this form
    prefilled: Array.isArray(meta.prefilled) ? meta.prefilled : [],
    taskId: task.id,
    contextId: task.contextId,
    messageId: msg.messageId,
    a2uiMessages,
  };
  const ids = { messageId: msg.messageId, contextId: task.contextId, taskId: task.id, inReplyTo: messageId };
  const reply = { ...ids, text: textOf(msg), servedBy: meta.agentId ?? null, servedByName: meta.servedByName ?? null, tutorMode: null, tutor: null, library: null, hub: meta.hub ?? null, form };
  log('received form', { formId: form.formId, workflowId: form.workflowId, taskId: form.taskId, contextId: form.contextId });
  // The checked A2UI messages ride along so the UI server can deliver them to the browser renderer.
  onEvent('form_received', { ...ids, formId: form.formId, formRef: form.formRef, workflowId: form.workflowId, formVersion: form.formVersion, issuer: form.issuer, servedByName: reply.servedByName, supersedes: form.supersedes, prefilled: form.prefilled, taskState: 'input-required', text: reply.text, a2uiMessages });
  return reply;
}

// Was the submission definitely not delivered, or might the Tutor have processed it?
// Only a failure *while* the SendMessage request was in flight can be uncertain.
function deliveryOutcome(err, sendStarted) {
  if (!sendStarted || err.cause?.code === 'ECONNREFUSED') return 'not_delivered';
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.message === 'fetch failed') return 'uncertain';
  return 'rejected'; // the Tutor answered with an error
}

// Send an A2UI action (a form button's event) to the agent that issued the form.
//
// Mapping: renderer `action` → A2UI client-to-server message `{version, action}` → A2A DataPart
// (application/a2ui+json) in a user Message whose metadata carries the operationId and form version.
// If the form's task is still INPUT_REQUIRED, the message resumes it (taskId). If it has completed
// (e.g. a retry after an uncertain outcome), resuming would be illegal, so a new message in the same
// context references the task instead; the agent returns the stored result for a repeated operationId.
// acknowledgeReview: the student chose "Send anyway" after the agent's review flagged these values.
// metadata: extra A2A metadata (Part 7: the Student's identity). The Hub's formRef is sent when present.
export async function sendFormAction(baseUrl, { form, action, operationId, runId, card, acknowledgeReview = false, timeoutMs = SUBMIT_TIMEOUT_MS, metadata = {}, signer = null, onEvent = () => {} }) {
  let sendStarted = false;
  try {
    const client = await connect(baseUrl, card);
    const task = await client.getTask({ tenant: '', id: form.taskId }, { signal: AbortSignal.timeout(timeoutMs) });
    const resume = task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED;
    const message = userMessage([a2uiDataPart([{ version: A2UI_VERSION, action }])], {
      contextId: form.contextId,
      ...(resume ? { taskId: form.taskId } : { referenceTaskIds: [form.taskId] }),
      metadata: { ...metadata, runId, operationId, formId: form.formId, formVersion: form.formVersion ?? undefined, ...(form.formRef ? { formRef: form.formRef } : {}), ...(acknowledgeReview ? { reviewAcknowledged: true } : {}) },
    });
    if (signer) message.metadata.studentSignature = signer({ contextId: message.contextId, messageId: message.messageId });
    const mode = resume ? 'resume-task' : 'new-message-referencing-task';
    log('sending form action', { operationId, action: action.name, formId: form.formId, messageId: message.messageId, mode });
    onEvent('form_action_sent', { operationId, actionName: action.name, formId: form.formId, messageId: message.messageId, mode, taskId: resume ? form.taskId : null });

    sendStarted = true;
    const result = await client.sendMessage(
      { tenant: '', message, configuration: undefined, metadata: undefined },
      { ...A2UI_REQUEST_OPTIONS, signal: AbortSignal.timeout(timeoutMs) },
    );
    const reply = statusMessage(result);
    const body = jsonData(reply) ?? { status: 'rejected', errors: { _form: 'Unrecognized reply.' } };
    // Part 7: the Hub reports that the specialist's outcome is unknown (e.g. it timed out downstream).
    if (body.status === 'outcome_unknown') throw Object.assign(new Error(body.message ?? 'The outcome is unknown.'), { outcome: 'uncertain' });
    // …or that the specialist was unreachable, so nothing was submitted (safe to edit and retry).
    if (body.status === 'not_delivered') throw Object.assign(new Error(body.message ?? 'Not delivered.'), { outcome: 'not_delivered' });
    // Any UI update (slot options, review screen, removal) must target this form and pass the allowlist.
    const update = reply?.parts.find(isA2uiPart)?.content.value ?? [];
    const updateError = update.length ? checkFormUpdatePolicy(update, form.formId, { workflowId: form.workflowId }) : null;
    if (updateError) throw Object.assign(new Error(`Rejected A2UI update: ${updateError}`), { outcome: 'rejected' });
    const ids = { operationId, actionName: action.name, formId: form.formId, messageId: reply?.messageId, contextId: result.contextId, taskId: 'messageId' in result ? null : result.id, duplicate: Boolean(reply?.metadata?.duplicate) };
    log('form action result', { ...ids, status: body.status });
    onEvent('form_action_result', { ...ids, body, a2uiUpdate: update, text: textOf(reply ?? { parts: [] }) });
    return { ...ids, body, a2uiUpdate: update };
  } catch (err) {
    const outcome = err.outcome ?? deliveryOutcome(err, sendStarted);
    log('form action failed', { operationId, outcome, error: err.message });
    onEvent('form_action_failed', { operationId, actionName: action.name, formId: form.formId, outcome, error: err.message, code: err.cause?.code ?? null });
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
