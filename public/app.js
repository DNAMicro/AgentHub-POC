// Browser side of the monitor. Renders only events published by the UI server;
// it never decides on its own that a step happened. Text is set with textContent.
//
// Part 3: the form is drawn by the official A2UI v0.9 Lit renderer from the A2UI
// messages the Tutor sent over A2A (delivered here by the event stream). Draft values
// live only in the renderer's local data model until Submit.
import { MessageProcessor, basicCatalog } from './vendor/a2ui.js';
import { SUBMIT_ACTION, validateSubmission } from '/shared/student-form.js';

const $ = (id) => document.getElementById(id);
const els = {
  browserFeed: $('browser-feed'),
  tutorFeed: $('tutor-feed'),
  state: $('state'),
  studentLog: $('student-log'),
  tutorLog: $('tutor-log'),
  form: $('send-form'),
  message: $('message'),
  send: $('send'),
  requestForm: $('request-form'),
  tutorMode: $('tutor-mode'),
  privacyNote: $('privacy-note'),
  conversation: $('conversation'),
  newConversation: $('new-conversation'),
  formError: $('form-error'),
  formArea: $('form-area'),
  runId: $('run-id'),
  timeline: $('timeline'),
  timelineError: $('timeline-error'),
};

const STATE_LABELS = {
  idle: 'idle', sending: 'sending', waiting: 'waiting for response', completed: 'completed', failed: 'failed',
  requesting: 'requesting form', awaiting_input: 'waiting for student', submitting: 'submitting',
  uncertain: 'delivery uncertain', accepted: 'accepted',
};
const BUSY = new Set(['sending', 'waiting', 'requesting']); // blocks Send / Request form

// Timeline steps per run kind: [key, label, note]. A step is marked only when its real event arrives.
const STEPS = {
  chat: [
    ['request_sent', 'Request sent', 'send started by Student'],
    ['message_received', 'Tutor Agent received', 'confirmed by Tutor process'],
    ['reply_published', 'Response sent', 'published by Tutor'],
    ['reply_received', 'Student Agent received', 'A2A result returned'],
  ],
  // Chat when the Tutor uses a model (mock or live): the model call shows as its own steps.
  chatModel: [
    ['request_sent', 'Request sent', 'send started by Student'],
    ['message_received', 'Tutor Agent received', 'confirmed by Tutor process'],
    ['model_call_started', 'Model call started', 'Tutor → model provider'],
    ['model_response_received', 'Model response received', 'reported by Tutor'],
    ['reply_published', 'Response sent', 'published by Tutor over A2A'],
    ['reply_received', 'A2A response received', 'by Student Agent'],
  ],
  form: [
    ['form_requested', 'Form requested', 'A2A request started'],
    ['form_request_received', 'Tutor received request', 'confirmed by Tutor process'],
    ['form_sent', 'Form sent', 'A2UI in input-required task'],
    ['form_received', 'Student received form', 'A2UI payload checked'],
    ['awaiting_input', 'Waiting for student', 'drafts stay in this browser'],
    ['submission_sent', 'Submission sent', 'A2A message started'],
    ['submission_accepted', 'Tutor accepted', 'validated and recorded'],
    ['ack_received', 'Acknowledgment received', 'A2A result returned'],
  ],
};

let bootId = null;
let seen = new Set(); // event seq numbers already rendered (history is replayed on reconnect)
let currentRunId = null;
let currentState = 'idle';
let awaitingRunId = null; // set between clicking Send/Request form and that run leaving a busy state
const formsById = new Map(); // formId → rendered form state
let currentContextId = null; // the chat conversation follow-up questions belong to (null → start a new one)

const MODE_TEXT = {
  live: (s) => `Tutor: LIVE · ${s.model}`,
  mock: () => 'Tutor: mock model (no external calls)',
  fixed: () => 'Tutor: fixed reply (no model)',
};

function renderMode(status) {
  if (!status) return;
  els.tutorMode.dataset.mode = status.mode;
  els.tutorMode.textContent = MODE_TEXT[status.mode]?.(status) ?? `Tutor: ${status.mode}`;
  els.privacyNote.hidden = status.mode !== 'live';
  els.privacyNote.textContent = status.mode !== 'live' ? '' :
    `Live tutoring: your chat questions, and this conversation’s earlier questions and answers, are sent to Anthropic (${status.model}). ` +
    'Form names, emails and notes are not sent.' + (status.keyConfigured ? '' : ' The Tutor has no API key set, so answers will fail until you add one.');
}

function renderConversation() {
  els.conversation.textContent = currentContextId ? `Conversation ${currentContextId} — follow-ups use its history` : 'New conversation — your next message starts fresh';
}

const fmtUsage = (t) => (t ? `${t.model} · ${(t.latencyMs / 1000).toFixed(1)} s · ${t.usage?.inputTokens ?? '?'} in / ${t.usage?.outputTokens ?? '?'} out tokens${t.truncated ? ' · cut off at output cap' : ''}${t.duplicate ? ' · repeat request (no new model call)' : ''}` : null);

// ---- rendering helpers --------------------------------------------------

const shortTime = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(iso).getMilliseconds()).padStart(3, '0');

function definitionList(className, entries) {
  const dl = document.createElement('dl');
  dl.className = className;
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    dl.append(dt, dd);
  }
  return dl;
}

function messageItem({ dir, label, at, text, values, ids }) {
  const li = document.createElement('li');
  li.className = 'msg';
  li.dataset.dir = dir;

  const head = document.createElement('div');
  head.className = 'msg-head';
  const dirEl = document.createElement('span');
  dirEl.className = 'msg-dir';
  dirEl.textContent = label;
  const timeEl = document.createElement('time');
  timeEl.dateTime = at;
  timeEl.textContent = shortTime(at);
  head.append(dirEl, timeEl);

  const body = document.createElement('p');
  body.className = 'msg-text';
  body.textContent = text;
  li.append(head, body);

  if (values) li.append(definitionList('values', Object.entries(values)));

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'IDs';
  details.append(summary, definitionList('ids', Object.entries(ids)));
  li.append(details);
  return li;
}

function appendTo(log, item) {
  log.append(item);
  log.scrollTop = log.scrollHeight;
}

function resetTimeline(runId, kind) {
  els.runId.textContent = `${kind} run ${runId}`;
  els.timelineError.textContent = '';
  els.timeline.replaceChildren(...STEPS[kind].map(([key, label, note]) => {
    const li = document.createElement('li');
    li.dataset.step = key;
    li.dataset.done = 'false';
    const l = document.createElement('span');
    l.className = 'step-label';
    l.textContent = label;
    const n = document.createElement('span');
    n.className = 'step-note';
    n.textContent = note;
    li.append(l, n, document.createElement('time'));
    return li;
  }));
}

function markStep(step, at) {
  const li = els.timeline.querySelector(`[data-step="${step}"]`);
  if (!li) return;
  li.dataset.done = 'true';
  const t = li.querySelector('time');
  t.dateTime = at;
  t.textContent = shortTime(at);
}

function setBadge(el, ok, text) {
  el.dataset.ok = String(ok);
  el.textContent = text;
}

function renderState() {
  els.state.dataset.state = currentState;
  els.state.textContent = STATE_LABELS[currentState] ?? currentState;
  const busy = awaitingRunId !== null || BUSY.has(currentState);
  els.send.disabled = busy;
  els.requestForm.disabled = busy;
  // Offered whenever there's something on screen to clear; unavailable mid-request.
  els.newConversation.hidden = !currentContextId && !els.studentLog.children.length && !els.tutorLog.children.length;
  els.newConversation.disabled = busy || [...formsById.values()].some((f) => f.pending);
}

// Empty every panel and forget the current conversation (not the event bookkeeping).
function clearScreen() {
  currentRunId = null;
  currentState = 'idle';
  formsById.clear();
  els.studentLog.replaceChildren();
  els.tutorLog.replaceChildren();
  els.formArea.replaceChildren();
  els.formArea.hidden = true;
  els.runId.textContent = 'no run yet';
  els.timeline.replaceChildren();
  els.timelineError.textContent = '';
  currentContextId = null;
  renderConversation();
  renderState();
}

function resetAll() {
  seen = new Set();
  clearScreen();
}

function reconcileButton(runId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inline-action';
  button.textContent = 'Check for answer';
  button.title = 'Re-sends the same request ID; the Tutor returns its earlier result instead of calling the model again.';
  button.addEventListener('click', async () => {
    button.disabled = true;
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/reconcile`, { method: 'POST' });
    if (!res.ok) {
      button.disabled = false;
      els.formError.textContent = `Could not check: ${(await res.json().catch(() => ({}))).error ?? res.status}`;
    }
  });
  return button;
}

const errorText = (errors) => Object.entries(errors ?? {}).map(([field, msg]) => (field === '_form' ? msg : `${field}: ${msg}`)).join(' ');

// ---- A2UI form ----------------------------------------------------------

function renderForm(runId, data) {
  // Draw with the official renderer from the received A2UI messages.
  const processor = new MessageProcessor([basicCatalog], (action) => onFormAction(action));
  processor.processMessages(data.a2uiMessages);
  const surface = processor.model.getSurface(data.formId);

  const meta = document.createElement('p');
  meta.className = 'form-meta';
  meta.textContent = `A2UI surface ${data.formId} · task ${data.taskId}`;
  const surfaceEl = document.createElement('a2ui-surface');
  surfaceEl.className = 'form-surface';
  surfaceEl.surface = surface;
  const notice = document.createElement('p');
  notice.className = 'notice';
  notice.setAttribute('role', 'status');

  els.formArea.replaceChildren(meta, surfaceEl, notice);
  els.formArea.hidden = false;
  els.formArea.dataset.state = 'awaiting_input';
  formsById.set(data.formId, { runId, formId: data.formId, surface, notice, pending: false, accepted: false, lastAttempt: null });
}

function setNotice(form, kind, text, retry) {
  form.notice.dataset.kind = kind;
  form.notice.textContent = text;
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Retry submission';
    button.addEventListener('click', () => {
      button.disabled = true;
      sendSubmission(form, form.lastAttempt);
    });
    form.notice.append(button);
  }
}

// The renderer's submit event. This is the explicit A2UI → backend mapping; nothing is
// wired automatically. Typing never reaches here — only a Button action does.
function onFormAction(action) {
  const form = formsById.get(action.surfaceId);
  if (!form || form.pending || form.accepted || action.name !== SUBMIT_ACTION) return;

  form.surface.dataModel.set('/ui/submitAttempted', true); // reveals the renderer's inline errors
  const check = validateSubmission(action.context);
  if (!check.ok) {
    setNotice(form, 'bad', 'Please fix the highlighted fields. Nothing was sent.');
    return;
  }
  const { name, surfaceId, sourceComponentId, timestamp, context } = action;
  sendSubmission(form, { submissionId: crypto.randomUUID(), action: { name, surfaceId, sourceComponentId, timestamp, context } });
}

async function sendSubmission(form, attempt) {
  form.pending = true;
  form.lastAttempt = attempt;
  form.surface.dataModel.set('/ui/submitLocked', true); // the Tutor's Button check disables Submit
  setNotice(form, 'warn', 'Submitting…');
  try {
    const res = await fetch(`/api/forms/${encodeURIComponent(form.formId)}/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attempt),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.errors ? errorText(body.errors) : body.error ?? `HTTP ${res.status}`);
    }
    // Outcome arrives as real events (state + student/tutor events).
  } catch (err) {
    form.pending = false;
    form.surface.dataModel.set('/ui/submitLocked', false);
    setNotice(form, 'bad', `Not sent: ${err.message}`);
  }
}

function onFormState(runId, data) {
  const form = [...formsById.values()].find((f) => f.runId === runId);
  if (!form) return;
  els.formArea.dataset.state = data.state;
  if (data.state === 'submitting') {
    form.pending = true;
    form.surface.dataModel.set('/ui/submitLocked', true);
  } else if (data.state === 'accepted') {
    form.pending = false;
    form.accepted = true;
    form.surface.dataModel.set('/ui/submitLocked', true);
    setNotice(form, 'ok', 'Submitted — the Tutor Agent confirmed it accepted your details.');
  } else if (data.state === 'awaiting_input' && (data.rejected || data.notDelivered)) {
    form.pending = false;
    form.surface.dataModel.set('/ui/submitLocked', false);
    if (data.notDelivered) {
      const reason = data.code === 'ECONNREFUSED' ? 'the Tutor Agent is unavailable'
        : /task not found/i.test(data.error ?? '') ? 'the Tutor Agent no longer knows this form (it keeps records in memory, so a restart clears them) — request a new form'
          : data.error;
      setNotice(form, 'bad', `Not delivered: ${reason}. Your draft is kept.`);
    }
  } else if (data.state === 'uncertain') {
    form.pending = false;
    setNotice(form, 'warn',
      'Delivery uncertain: the request timed out, so the Tutor Agent may or may not have received it. ' +
      'Retry sends the same submission ID, so it will be recorded at most once.', Boolean(form.lastAttempt));
  }
}

// ---- event handling -----------------------------------------------------

function handle(event) {
  const { source, type, runId, at, data } = event;
  const run = runId ? runId.slice(0, 8) : null;
  const isCurrent = runId === currentRunId;
  const student = (item) => appendTo(els.studentLog, messageItem({ at, ...item }));
  const tutor = (item) => appendTo(els.tutorLog, messageItem({ at, ...item }));

  if (source === 'system') {
    if (type === 'tutor_feed') {
      setBadge(els.tutorFeed, data.connected, data.connected ? 'Tutor feed: connected' : 'Tutor feed: offline');
    } else if (type === 'conversation_reset') {
      // Replayed in order on reload too, so a cleared screen stays cleared.
      clearScreen();
    } else if (type === 'tutor_status') {
      renderMode(data);
    } else if (type === 'run_started') {
      currentRunId = runId;
      const kind = data.kind === 'chat' && data.tutorMode && data.tutorMode !== 'fixed' ? 'chatModel' : data.kind ?? 'chat';
      resetTimeline(runId, kind);
      if (data.kind === 'chat') {
        currentContextId = data.contextId;
        renderConversation();
      }
    } else if (type === 'state') {
      if (isCurrent) currentState = data.state;
      if (runId === awaitingRunId && !BUSY.has(data.state)) awaitingRunId = null;
      if (isCurrent && data.state === 'awaiting_input') markStep('awaiting_input', at);
      onFormState(runId, data);
    }
  } else if (source === 'student') {
    switch (type) {
      // chat
      case 'request_sent':
        student({ dir: 'sent', label: 'Sent', text: data.text, ids: { messageId: data.messageId, run } });
        break;
      case 'reply_received':
        student({ dir: 'received', label: 'Received', text: data.text, ids: { model: fmtUsage(data.tutor), messageId: data.messageId, inReplyTo: data.inReplyTo, contextId: data.contextId, taskId: data.taskId || '(none — direct Message reply)', anthropicRequest: data.tutor?.requestId, run } });
        break;
      case 'tutor_error':
        student({ dir: 'error', label: 'Tutor error', text: data.message, ids: { code: data.code, anthropicRequest: data.requestId, messageId: data.messageId, contextId: data.contextId, run } });
        if (isCurrent) els.timelineError.textContent = `The Tutor could not answer: ${data.message}`;
        break;
      case 'request_failed': {
        const detail = data.code ? `${data.error} (${data.code})` : data.error;
        if (data.outcome === 'uncertain') {
          const item = messageItem({ at, dir: 'error', label: 'Uncertain', text: `No reply in time — the Tutor may still be answering. ${detail}`, ids: { request: data.messageId, run } });
          item.insertBefore(reconcileButton(runId), item.querySelector('details'));
          appendTo(els.studentLog, item);
          if (isCurrent) els.timelineError.textContent = 'Outcome uncertain: use “Check for answer” to fetch the result of the same request (no new model call).';
        } else {
          student({ dir: 'error', label: 'Failed', text: detail, ids: { run } });
          if (isCurrent) els.timelineError.textContent = `Request failed: ${detail}`;
        }
        break;
      }
      // form
      case 'form_requested':
        student({ dir: 'sent', label: 'Sent', text: 'Requested the student-details form.', ids: { messageId: data.messageId, run } });
        break;
      case 'form_received':
        student({ dir: 'received', label: 'Received', text: `Form received (${data.a2uiMessages.length} A2UI v0.9 messages) — rendered below.`, ids: { form: data.formId, contextId: data.contextId, taskId: `${data.taskId} (input-required)`, messageId: data.messageId, run } });
        renderForm(runId, data);
        break;
      case 'form_request_failed': {
        const detail = data.code ? `${data.error} (${data.code})` : data.error;
        student({ dir: 'error', label: 'Failed', text: `Form request failed: ${detail}`, ids: { run } });
        if (isCurrent) els.timelineError.textContent = `Form request failed: ${detail}`;
        break;
      }
      case 'submission_sent':
        student({ dir: 'sent', label: 'Sent', text: `Submitted the form (${data.mode === 'resume-task' ? 'resuming the form task' : 'new message referencing the completed form task'}).`, ids: { submission: data.submissionId, form: data.formId, messageId: data.messageId, taskId: data.taskId, run } });
        break;
      case 'ack_received':
        student({ dir: 'received', label: data.duplicate ? 'Ack (duplicate)' : 'Ack', text: data.ack.message, ids: { ackId: data.ack.ackId, recordedAt: data.ack.recordedAt, submission: data.submissionId, form: data.formId, contextId: data.contextId, taskId: data.taskId ? `${data.taskId} (completed)` : '(direct Message reply)', messageId: data.messageId, run } });
        break;
      case 'submission_rejected': {
        student({ dir: 'error', label: 'Rejected', text: `Tutor rejected the submission: ${errorText(data.errors)}`, ids: { submission: data.submissionId, form: data.formId, messageId: data.messageId, run } });
        const form = formsById.get(data.formId);
        if (form) setNotice(form, 'bad', `Tutor rejected the submission: ${errorText(data.errors)}`);
        break;
      }
      case 'submission_failed':
        student({ dir: 'error', label: data.outcome === 'uncertain' ? 'Uncertain' : 'Failed', text: `${data.outcome === 'uncertain' ? 'Delivery uncertain' : 'Not delivered'}: ${data.error}${data.code ? ` (${data.code})` : ''}`, ids: { submission: data.submissionId, run } });
        if (isCurrent) els.timelineError.textContent = data.outcome === 'uncertain' ? 'Submission delivery uncertain.' : `Submission not delivered: ${data.error}`;
        break;
    }
    // A Tutor-reported error still arrived as an A2A response.
    if (isCurrent && type !== 'submission_failed') markStep(type === 'tutor_error' ? 'reply_received' : type, at);
  } else if (source === 'tutor') {
    switch (type) {
      // chat
      case 'message_received':
        tutor({ dir: 'received', label: 'Received', text: data.text, ids: { messageId: data.messageId, contextId: data.contextId, taskId: data.taskId, run } });
        break;
      case 'reply_published':
        tutor({ dir: data.tutorError ? 'error' : 'sent', label: data.tutorError ? 'Sent (error)' : 'Sent', text: data.text, ids: { model: fmtUsage(data.tutor), messageId: data.messageId, contextId: data.contextId, inReplyTo: data.inReplyTo, run } });
        break;
      case 'model_call_started':
        tutor({ dir: 'sent', label: 'Model call', text: `Calling ${data.model} with ${data.earlierMessages} earlier message${data.earlierMessages === 1 ? '' : 's'} from this conversation.`, ids: { mode: data.mode, contextId: data.contextId, messageId: data.messageId, run } });
        break;
      case 'model_response_received':
        tutor({ dir: 'received', label: 'Model reply', text: `${data.model} responded in ${(data.latencyMs / 1000).toFixed(1)} s (${data.usage?.inputTokens ?? '?'} input / ${data.usage?.outputTokens ?? '?'} output tokens, stop: ${data.stopReason}${data.truncated ? ', cut off at the output cap' : ''}).`, ids: { anthropicRequest: data.requestId, contextId: data.contextId, messageId: data.messageId, run } });
        break;
      case 'model_call_failed':
        tutor({ dir: 'error', label: 'Model error', text: data.message, ids: { code: data.code, anthropicRequest: data.requestId, latency: `${data.latencyMs} ms`, run } });
        break;
      case 'model_call_reused':
        tutor({ dir: 'sent', label: 'Repeat request', text: 'Same request ID as before — returning the earlier result; no new model call.', ids: { contextId: data.contextId, messageId: data.messageId, run } });
        break;
      // form
      case 'form_request_received':
        tutor({ dir: 'received', label: 'Received', text: 'Form request.', ids: { messageId: data.messageId, contextId: data.contextId, taskId: data.taskId, run } });
        break;
      case 'form_sent':
        tutor({ dir: 'sent', label: 'Sent', text: `A2UI form (${data.a2uiMessages} messages) in a task awaiting input.`, ids: { form: data.formId, taskId: data.taskId, contextId: data.contextId, messageId: data.messageId, run } });
        break;
      case 'form_request_refused':
        tutor({ dir: 'error', label: 'Refused', text: data.reason, ids: { messageId: data.messageId, run } });
        break;
      case 'submission_received':
        tutor({ dir: 'received', label: 'Received', text: `Submission (action "${data.actionName}") — values exactly as received:`, values: data.receivedValues ?? {}, ids: { submission: data.submissionId, form: data.formId, messageId: data.messageId, taskId: data.taskId, contextId: data.contextId, resumedTask: data.resumedTask, run } });
        break;
      case 'submission_accepted':
        tutor({ dir: 'sent', label: 'Accepted', text: 'Validated and recorded in memory:', values: data.values, ids: { ackId: data.ackId, submission: data.submissionId, form: data.formId, run } });
        break;
      case 'submission_rejected':
        tutor({ dir: 'error', label: 'Rejected', text: errorText(data.errors), ids: { submission: data.submissionId, form: data.formId, run } });
        break;
      case 'submission_duplicate':
        tutor({ dir: 'sent', label: 'Duplicate', text: 'Already processed — returned the stored acknowledgment, recorded nothing.', ids: { ackId: data.ackId, submission: data.submissionId, form: data.formId, run } });
        break;
    }
    if (isCurrent) markStep(type, at);
  }
  renderState();
}

// ---- connections --------------------------------------------------------

// Visualization stream only. EventSource reconnects automatically with a GET;
// that can never start an A2A request or submit a form (only the POST endpoints can).
const stream = new EventSource('/api/events');
stream.addEventListener('open', () => setBadge(els.browserFeed, true, 'Browser stream: connected'));
stream.addEventListener('error', () => setBadge(els.browserFeed, false, 'Browser stream: reconnecting…'));
stream.addEventListener('hello', (e) => {
  const hello = JSON.parse(e.data);
  if (bootId !== null && hello.bootId !== bootId) resetAll(); // UI server restarted: seq numbers restart too
  bootId = hello.bootId;
  setBadge(els.tutorFeed, hello.tutorFeedConnected, hello.tutorFeedConnected ? 'Tutor feed: connected' : 'Tutor feed: offline');
  renderMode(hello.tutorStatus);
});
stream.addEventListener('message', (e) => {
  const event = JSON.parse(e.data);
  if (seen.has(event.seq)) return;
  seen.add(event.seq);
  handle(event);
});

async function startRun(path, body) {
  els.formError.textContent = '';
  awaitingRunId = 'pending';
  renderState();
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    // The run may already have left its busy state (its events can arrive before this response).
    const finished = reply.runId === currentRunId && !BUSY.has(currentState);
    awaitingRunId = finished ? null : reply.runId;
  } catch (err) {
    awaitingRunId = null;
    els.formError.textContent = `Could not start request: ${err.message}`;
  }
  renderState();
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!els.send.disabled) startRun('/api/runs', { text: els.message.value, contextId: currentContextId });
});
els.newConversation.addEventListener('click', async () => {
  if (els.newConversation.disabled) return;
  els.formError.textContent = '';
  // The server records the reset; the screen clears when that event arrives (here and in other tabs).
  const res = await fetch('/api/conversation/new', { method: 'POST' });
  if (!res.ok) els.formError.textContent = (await res.json().catch(() => ({}))).error ?? `Could not start a new conversation (HTTP ${res.status}).`;
});
els.requestForm.addEventListener('click', () => {
  if (!els.requestForm.disabled) startRun('/api/forms', {});
});

renderConversation();
renderState();
