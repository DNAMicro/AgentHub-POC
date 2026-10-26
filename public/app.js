// Browser side of the monitor. Renders only events published by the UI server;
// it never decides that a step happened on its own. All text is set with
// textContent, so message contents are never interpreted as HTML.
'use strict';

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
  formError: $('form-error'),
  runId: $('run-id'),
  timeline: $('timeline'),
  timelineError: $('timeline-error'),
};

const STATE_LABELS = { idle: 'idle', sending: 'sending', waiting: 'waiting for response', completed: 'completed', failed: 'failed' };
const IN_FLIGHT = new Set(['sending', 'waiting']);

let bootId = null;
let seen = new Set(); // event seq numbers already rendered (history is replayed on reconnect)
let currentRunId = null;
let currentState = 'idle';
let awaitingRunId = null; // set between clicking Send and that run reaching a terminal state

// ---- rendering helpers --------------------------------------------------

const shortTime = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false }) + '.' + String(new Date(iso).getMilliseconds()).padStart(3, '0');

function messageItem({ dir, label, at, text, ids }) {
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

  const dl = document.createElement('dl');
  dl.className = 'ids';
  for (const [key, value] of Object.entries(ids)) {
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  li.append(head, body, dl);
  return li;
}

function appendTo(log, item) {
  log.append(item);
  log.scrollTop = log.scrollHeight;
}

function resetTimeline(runId) {
  els.runId.textContent = `run ${runId}`;
  els.timelineError.textContent = '';
  for (const li of els.timeline.children) {
    li.dataset.done = 'false';
    li.querySelector('time').textContent = '';
  }
}

function markStep(step, at) {
  const li = els.timeline.querySelector(`[data-step="${step}"]`);
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
  els.state.textContent = STATE_LABELS[currentState];
  els.send.disabled = awaitingRunId !== null || IN_FLIGHT.has(currentState);
}

function resetAll() {
  seen = new Set();
  currentRunId = null;
  currentState = 'idle';
  els.studentLog.replaceChildren();
  els.tutorLog.replaceChildren();
  els.runId.textContent = 'no run yet';
  els.timelineError.textContent = '';
  for (const li of els.timeline.children) li.dataset.done = 'false';
  renderState();
}

// ---- event handling -----------------------------------------------------

function handle(event) {
  const { source, type, runId, at, data } = event;
  const runTag = runId ? runId.slice(0, 8) : null;
  const isCurrent = runId === currentRunId;

  if (source === 'system' && type === 'tutor_feed') {
    setBadge(els.tutorFeed, data.connected, data.connected ? 'Tutor feed: connected' : 'Tutor feed: offline');
  } else if (source === 'system' && type === 'run_started') {
    currentRunId = runId;
    resetTimeline(runId);
  } else if (source === 'system' && type === 'state') {
    if (isCurrent) currentState = data.state;
    if (runId === awaitingRunId && !IN_FLIGHT.has(data.state)) awaitingRunId = null;
  } else if (source === 'student' && type === 'request_sent') {
    appendTo(els.studentLog, messageItem({ dir: 'sent', label: 'Sent', at, text: data.text, ids: { messageId: data.messageId, run: runTag } }));
    if (isCurrent) markStep('request_sent', at);
  } else if (source === 'student' && type === 'reply_received') {
    appendTo(els.studentLog, messageItem({
      dir: 'received', label: 'Received', at, text: data.text,
      ids: { messageId: data.messageId, contextId: data.contextId, taskId: data.taskId || '(none — direct Message reply)', run: runTag },
    }));
    if (isCurrent) markStep('reply_received', at);
  } else if (source === 'student' && type === 'request_failed') {
    const detail = data.code ? `${data.error} (${data.code})` : data.error;
    appendTo(els.studentLog, messageItem({ dir: 'error', label: 'Failed', at, text: detail, ids: { run: runTag } }));
    if (isCurrent) els.timelineError.textContent = `Request failed: ${detail}`;
  } else if (source === 'tutor' && type === 'message_received') {
    appendTo(els.tutorLog, messageItem({
      dir: 'received', label: 'Received', at, text: data.text,
      ids: { messageId: data.messageId, contextId: data.contextId, taskId: data.taskId, run: runTag },
    }));
    if (isCurrent) markStep('message_received', at);
  } else if (source === 'tutor' && type === 'reply_published') {
    appendTo(els.tutorLog, messageItem({
      dir: 'sent', label: 'Sent', at, text: data.text,
      ids: { messageId: data.messageId, contextId: data.contextId, inReplyTo: data.inReplyTo, run: runTag },
    }));
    if (isCurrent) markStep('reply_published', at);
  }
  renderState();
}

// ---- connections --------------------------------------------------------

// Visualization stream only. EventSource reconnects automatically with a GET;
// that can never start an A2A request (only POST /api/runs can).
const stream = new EventSource('/api/events');
stream.addEventListener('open', () => setBadge(els.browserFeed, true, 'Browser stream: connected'));
stream.addEventListener('error', () => setBadge(els.browserFeed, false, 'Browser stream: reconnecting…'));
stream.addEventListener('hello', (e) => {
  const hello = JSON.parse(e.data);
  if (bootId !== null && hello.bootId !== bootId) resetAll(); // UI server restarted: seq numbers restart too
  bootId = hello.bootId;
  setBadge(els.tutorFeed, hello.tutorFeedConnected, hello.tutorFeedConnected ? 'Tutor feed: connected' : 'Tutor feed: offline');
});
stream.addEventListener('message', (e) => {
  const event = JSON.parse(e.data);
  if (seen.has(event.seq)) return;
  seen.add(event.seq);
  handle(event);
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (els.send.disabled) return;
  els.formError.textContent = '';
  awaitingRunId = 'pending';
  renderState();
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: els.message.value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    // The run may already have finished (its events can arrive before this response).
    const finished = body.runId === currentRunId && !IN_FLIGHT.has(currentState);
    awaitingRunId = finished ? null : body.runId;
  } catch (err) {
    awaitingRunId = null;
    els.formError.textContent = `Could not start request: ${err.message}`;
  }
  renderState();
});

renderState();
