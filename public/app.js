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
  libraryLog: $('library-log'),
  libraryFeed: $('library-feed'),
  routerMode: $('router-mode'),
  refreshSkills: $('refresh-skills'),
  skillsBox: { tutor: $('tutor-skills'), library: $('library-skills') },
  dialog: $('skills-dialog'),
  dialogTitle: $('skills-dialog-title'),
  dialogIdentity: $('skills-identity'),
  skillsEditor: $('skills-editor'),
  skillsErrors: $('skills-errors'),
  cardPreview: $('card-preview'),
  cardPreviewBox: $('card-preview-box'),
  addSkill: $('add-skill'),
  skillsSave: $('skills-save'),
  skillsCancel: $('skills-cancel'),
  skillsDirty: $('skills-dirty'),
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
  // Routed chat (Part 5): the router decides first; the receiving service checks scope itself.
  chatRouted: [
    ['route_decided', 'Routing decision', 'Student router (code-validated)'],
    ['request_sent', 'Request sent', 'over A2A to the chosen service'],
    ['message_received', 'Service received', 'confirmed by that service'],
    ['scope_checked', 'Scope check', 'by the receiving service'],
    ['reply_published', 'Response sent', 'by the service over A2A'],
    ['reply_received', 'Student received', 'A2A result returned'],
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
  els.newConversation.hidden = !currentContextId && ![els.studentLog, els.tutorLog, els.libraryLog].some((log) => log.children.length);
  els.newConversation.disabled = busy || [...formsById.values()].some((f) => f.pending);
}

// Empty every conversation panel and forget the current conversation (not the event
// bookkeeping). Each agent's skills box stays: that's agent configuration, not conversation.
function clearScreen() {
  currentRunId = null;
  currentState = 'idle';
  formsById.clear();
  els.studentLog.replaceChildren();
  els.tutorLog.replaceChildren();
  els.libraryLog.replaceChildren();
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

// ---- Part 5: advertised skills, Student's cached view, propagation ---------

const AGENT_NAMES = { tutor: 'Calculus Tutor', library: 'Library Agent' };
// Per agent: what it advertises (its own settings), the last save, the notification outcome,
// what Student received, and Student's cached registry view. Each comes from a real event.
const agents = {
  tutor: { advertised: null, saved: null, notification: null, received: null, registry: null },
  library: { advertised: null, saved: null, notification: null, received: null, registry: null },
};

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '—');

async function loadAdvertised(agentId) {
  try {
    const res = await fetch(`/api/agents/${agentId}/skills`);
    if (res.ok) agents[agentId].advertised = await res.json();
  } catch {
    // agent offline; panel keeps the last known state
  }
  renderSkillsBox(agentId);
}

function renderSkillsBox(agentId) {
  const a = agents[agentId];
  const box = els.skillsBox[agentId];
  const rows = [];
  if (a.advertised) {
    const chips = a.advertised.config.skills.map((s) => el('span', { className: 'chip', textContent: s.name, title: `${s.id}${s.enabled ? '' : ' (disabled)'}`, dataset: { off: String(!s.enabled) } }));
    rows.push(el('div', { className: 'skills-row' }, el('span', { className: 'label', textContent: `Advertised (rev ${a.advertised.revision}):` }), ...chips,
      el('span', { className: 'tested', textContent: a.advertised.matchesTestedDefault ? ' · matches tested default' : ' · changed since tests — not verified' })));
  }
  const r = a.registry;
  if (r) {
    const chips = r.skills.map((s) => el('span', { className: 'chip', textContent: s.name, title: s.id }));
    rows.push(el('div', { className: 'skills-row' }, el('span', { className: 'label', textContent: `Student’s view (rev ${r.revision ?? '?'}, ${r.status}):` }), ...(chips.length ? chips : [el('span', { textContent: 'none' })])));
  }
  if (a.saved) {
    const n = a.notification?.revision === a.saved.revision ? a.notification : null;
    const updated = r && r.revision === a.saved.revision && (r.status === 'ok');
    rows.push(el('ul', { className: 'propagation', ariaLabel: 'Save and propagation' },
      el('li', { dataset: { status: 'ok' }, textContent: `Configuration saved — revision ${a.saved.revision} (${clock(a.saved.at)})` }),
      el('li', { dataset: { status: !n ? 'wait' : n.outcome === 'delivered' ? 'ok' : n.outcome === 'pending' ? 'pending' : 'bad' }, textContent: !n ? 'Notification: not sent yet' : `Notification ${n.outcome}: ${n.detail}` }),
      el('li', { dataset: { status: updated ? 'ok' : r?.status === 'stale' ? 'bad' : 'wait' }, textContent: updated ? `Student routing updated — revision ${r.revision} (${clock(r.lastSuccessAt)})` : `Student routing not updated yet${r?.lastError ? ` (${r.lastError})` : ''}` }),
    ));
  }
  const details = el('details', {}, el('summary', { textContent: 'Card details' }),
    definitionList('ids', [
      ['card revision', a.advertised?.revision], ['card ETag', a.advertised?.etag],
      ['Student cached revision', r?.revision], ['Student cached ETag', r?.etag],
      ['last successful refresh', r?.lastSuccessAt && new Date(r.lastSuccessAt).toLocaleString()],
      ['last refresh error', r?.lastError], ['last notification', a.notification && `${a.notification.outcome} (${a.notification.notificationId})`],
    ]));
  box.replaceChildren(...rows, details);
}

// ---- Part 5: skills settings dialog -------------------------------------------

let editing = null; // { agentId, revision, rules: { knowledge, builtInFormId }, dirty }
let fieldSeq = 0;

const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 49);

// One labelled control with a hint and a slot for its own error message.
function field({ label, control, hint, errorKey, required }) {
  const id = `skill-field-${++fieldSeq}`;
  control.id = id;
  const error = el('p', { className: 'field-error', id: `${id}-error`, role: 'alert' });
  error.dataset.errorFor = errorKey;
  control.setAttribute('aria-describedby', `${id}-hint ${id}-error`);
  return el('div', { className: 'field' },
    el('label', { htmlFor: id, textContent: label }, required ? el('span', { className: 'req', textContent: ' *', ariaHidden: 'true' }) : null),
    control,
    hint ? el('p', { className: 'hint', id: `${id}-hint`, textContent: hint }) : null,
    error);
}

function markDirty() {
  if (!editing) return;
  editing.dirty = true;
  els.skillsDirty.hidden = false;
}

function skillCard(skill, { isNew }) {
  const isForm = skill.kind === 'form';
  const required = editing.rules.knowledge === 'required';
  const input = (name, value, extra = {}) => el('input', { type: 'text', name, value, ...extra });
  const area = (name, value, rows, extra = {}) => el('textarea', { name, value, rows, ...extra });

  const enabled = el('input', { type: 'checkbox', name: 'enabled', checked: skill.enabled });
  const title = el('span', { className: 'skill-title', textContent: skill.name || 'New skill' });
  const meta = el('span', { className: 'skill-meta' });
  const toggle = el('button', { type: 'button', className: 'skill-toggle' }, title, meta, el('span', { className: 'chevron', ariaHidden: 'true', textContent: '▾' }));
  const nameInput = input('name', skill.name, { maxLength: 80, placeholder: 'e.g. Borrowing a book' });
  const idInput = input('id', skill.id, { readOnly: !isNew, maxLength: 49, placeholder: 'generated from the name', spellcheck: false });
  const body = el('div', { className: 'skill-body' });
  const card = el('section', { className: 'skill-card', dataset: { kind: skill.kind, open: String(isNew), enabled: String(skill.enabled) } },
    el('header', { className: 'skill-head' },
      el('label', { className: 'switch', title: 'Enabled skills are advertised on the Agent Card and permitted at runtime' }, enabled, el('span', { className: 'switch-track', ariaHidden: 'true' }), el('span', { className: 'visually-hidden', textContent: 'Enabled' })),
      toggle),
    body);

  const updateHead = () => {
    title.textContent = nameInput.value.trim() || 'New skill';
    meta.textContent = [idInput.value || '(no ID yet)', isForm ? 'built-in form' : null, enabled.checked ? null : 'disabled'].filter(Boolean).join(' · ');
    card.dataset.enabled = String(enabled.checked);
    toggle.setAttribute('aria-expanded', card.dataset.open);
  };
  toggle.addEventListener('click', () => {
    card.dataset.open = String(card.dataset.open !== 'true');
    updateHead();
  });

  const section = (heading, intro, ...children) => el('div', { className: 'skill-section' }, el('h4', { textContent: heading }), intro ? el('p', { className: 'hint', textContent: intro }) : null, ...children);
  body.append(
    section('Basics', null,
      field({ label: 'Name', control: nameInput, errorKey: 'name', required: true }),
      field({ label: 'Description', control: area('description', skill.description, 2, { maxLength: 500, placeholder: 'What this skill helps with, in one or two sentences.' }), errorKey: 'description', required: true, hint: 'The Student’s router reads this to decide which questions to send here.' }),
      field({ label: 'Skill ID', control: idInput, errorKey: 'id', hint: isNew ? 'Generated from the name; you can edit it before saving. It can’t change after saving.' : 'Stable ID — fixed once saved.' })),
    isForm
      ? section('How it answers', null, el('p', { className: 'note', textContent: 'Built-in A2UI form (Part 3), handled by code. You can rename, re-describe, or turn it off; it has no answer content.' }))
      : section('Answer content', required
        ? 'The facts this skill answers from. The agent reads it for each question and replies with just the relevant part — for example one day from a weekly schedule. It won’t answer beyond what’s written here.'
        : 'Optional reference notes the Tutor uses when answering. The Tutor also uses its own subject knowledge, within the boundaries below.',
        field({ label: required ? 'Answer content' : 'Reference notes (optional)', errorKey: 'knowledge', required,
          control: area('knowledge', skill.knowledge ?? '', 8, { maxLength: 6000, placeholder: required ? 'Monday: 8:00–22:00\nTuesday: 8:00–22:00\n…' : 'e.g. Prefer the limit definition before the shortcut rules.' }) })),
    section('Boundaries', 'What questions belong to this skill, and what doesn’t. Used by the scope checks.',
      field({ label: 'Covers (one per line)', control: area('allowed', skill.scope.allowed.join('\n'), 2, { placeholder: 'e.g. loan periods and due dates' }), errorKey: 'scope.allowed', required: true }),
      field({ label: 'Does not cover (one per line)', control: area('excluded', skill.scope.excluded.join('\n'), 2, { placeholder: 'e.g. tutoring or explaining topics in a book' }), errorKey: 'scope.excluded' })),
    section('Routing hints', 'Help the Student’s router recognise questions for this skill.',
      el('div', { className: 'two-col' },
        field({ label: 'Tags', control: input('tags', skill.tags.join(', '), { placeholder: 'library, loans, due date' }), errorKey: 'tags', hint: 'Comma separated.' }),
        field({ label: 'Example questions (one per line)', control: area('examples', skill.examples.join('\n'), 2, { placeholder: 'When is my book due?' }), errorKey: 'examples' }))),
  );
  if (!isForm) {
    const remove = el('button', { type: 'button', className: 'remove', textContent: 'Remove this skill' });
    remove.addEventListener('click', () => {
      card.remove();
      markDirty();
      schedulePreview();
    });
    body.append(remove);
  }

  let idTouched = !isNew;
  idInput.addEventListener('input', () => { idTouched = true; });
  card.addEventListener('input', (e) => {
    if (isNew && !idTouched && e.target === nameInput) idInput.value = slug(nameInput.value);
    const err = e.target.closest('.field')?.querySelector('.field-error');
    if (err) {
      err.textContent = '';
      e.target.removeAttribute('aria-invalid');
    }
    updateHead();
    markDirty();
    schedulePreview();
  });
  updateHead();
  return card;
}

function collectConfig() {
  return {
    skills: [...els.skillsEditor.querySelectorAll('.skill-card')].map((card) => {
      const v = (name) => card.querySelector(`[name="${name}"]`);
      return {
        id: v('id').value.trim(), kind: card.dataset.kind, enabled: v('enabled').checked,
        name: v('name').value, description: v('description').value,
        tags: v('tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        examples: lines(v('examples').value),
        scope: { allowed: lines(v('allowed').value), excluded: lines(v('excluded').value) },
        knowledge: v('knowledge')?.value ?? '',
      };
    }),
  };
}

// Put each server error next to its field (skills[i].field); others go in the summary.
function showErrors(errors) {
  for (const e of els.skillsEditor.querySelectorAll('.field-error')) e.textContent = '';
  for (const c of els.skillsEditor.querySelectorAll('[aria-invalid]')) c.removeAttribute('aria-invalid');
  if (!errors?.length) {
    els.skillsErrors.replaceChildren();
    return;
  }
  const cards = [...els.skillsEditor.querySelectorAll('.skill-card')];
  const general = [];
  let first = null;
  for (const e of errors) {
    const m = /^skills\[(\d+)\]\.?(.*)$/.exec(e.path ?? '');
    const slot = m && cards[Number(m[1])]?.querySelector(`.field-error[data-error-for="${m[2]}"]`);
    if (slot) {
      slot.textContent = e.message;
      slot.closest('.field').querySelector('input, textarea')?.setAttribute('aria-invalid', 'true');
      const card = slot.closest('.skill-card');
      card.dataset.open = 'true';
      card.querySelector('.skill-toggle').setAttribute('aria-expanded', 'true');
      first ??= slot;
    } else {
      general.push(m && cards[Number(m[1])] ? `${cards[Number(m[1])].querySelector('.skill-title').textContent}: ${e.message}` : e.message);
    }
  }
  const summary = [el('p', { textContent: `Please fix ${errors.length} problem${errors.length === 1 ? '' : 's'} before saving.` })];
  if (general.length) summary.push(el('ul', {}, ...general.map((g) => el('li', { textContent: g }))));
  els.skillsErrors.replaceChildren(...summary);
  (first?.closest('.field') ?? els.skillsErrors).scrollIntoView({ block: 'center', behavior: 'smooth' });
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, 400);
}

async function preview() {
  if (!editing || !els.cardPreviewBox.open) return;
  const res = await fetch(`/api/agents/${editing.agentId}/skills/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: collectConfig() }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    els.cardPreview.textContent = '(fix the problems above to see the preview)';
    return;
  }
  const { name, skills, capabilities } = body.card;
  els.cardPreview.textContent = JSON.stringify({ name, skills, 'capabilities.extensions': capabilities.extensions }, null, 2);
}

async function openSkills(agentId) {
  const res = await fetch(`/api/agents/${agentId}/skills`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    els.formError.textContent = body.error ?? `Could not load ${AGENT_NAMES[agentId]} skills.`;
    return;
  }
  editing = { agentId, revision: body.revision, rules: body.rules, dirty: false };
  els.skillsErrors.replaceChildren();
  els.skillsDirty.hidden = true;
  els.dialogTitle.textContent = `Edit skills — ${AGENT_NAMES[agentId]}`;
  els.dialogIdentity.textContent = `${body.agentName} · ID “${body.agentId}” · revision ${body.revision} · ${body.matchesTestedDefault ? 'matches the tested default' : 'changed since tests (not verified)'}`;
  els.skillsEditor.replaceChildren(...body.config.skills.map((s) => skillCard(s, { isNew: false })));
  els.cardPreviewBox.open = false;
  els.cardPreview.textContent = '';
  els.skillsSave.disabled = false;
  els.dialog.showModal();
}

function closeSkills({ confirmDiscard }) {
  if (confirmDiscard && editing?.dirty && !window.confirm('Discard your unsaved changes?')) return false;
  editing = null;
  els.dialog.close();
  return true;
}

els.cardPreviewBox.addEventListener('toggle', preview);
els.addSkill.addEventListener('click', () => {
  if (!editing) return;
  const card = skillCard({ id: '', kind: 'answer', enabled: true, name: '', description: '', tags: [], examples: [], scope: { allowed: [], excluded: [] }, knowledge: '' }, { isNew: true });
  els.skillsEditor.append(card);
  markDirty();
  card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  card.querySelector('[name="name"]').focus({ preventScroll: true });
});
// Cancel / Esc discard local edits (after confirming if there are any); nothing is sent.
els.skillsCancel.addEventListener('click', () => closeSkills({ confirmDiscard: true }));
els.dialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeSkills({ confirmDiscard: true });
});
els.skillsSave.addEventListener('click', async () => {
  if (!editing) return;
  els.skillsSave.disabled = true;
  const res = await fetch(`/api/agents/${editing.agentId}/skills`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: collectConfig(), baseRevision: editing.revision }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    showErrors(body.errors ?? [{ path: '', message: body.error ?? `HTTP ${res.status}` }]);
    els.skillsSave.disabled = false;
    return;
  }
  // Saved on the agent. Notification and Student refresh are shown separately as they happen.
  closeSkills({ confirmDiscard: false });
});
for (const gear of document.querySelectorAll('.gear')) gear.addEventListener('click', () => openSkills(gear.dataset.agent));
els.refreshSkills.addEventListener('click', async () => {
  els.refreshSkills.disabled = true;
  await fetch('/api/registry/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  setTimeout(() => { els.refreshSkills.disabled = false; }, 800);
});

const ROUTER_TEXT = { direct: 'Router: off (everything to Tutor)', mock: 'Router: mock heuristic (no external calls)', live: 'Router: LIVE · claude-haiku-5-5' };
function renderRouter(router) {
  if (!router) return;
  els.routerMode.dataset.mode = router.mode === 'live' ? 'live' : router.mode === 'mock' ? 'mock' : 'direct';
  els.routerMode.textContent = ROUTER_TEXT[router.mode] ?? `Router: ${router.mode}`;
}

// ---- event handling -----------------------------------------------------

function handle(event) {
  const { source, type, runId, at, data } = event;
  const run = runId ? runId.slice(0, 8) : null;
  const isCurrent = runId === currentRunId;
  const student = (item) => appendTo(els.studentLog, messageItem({ at, ...item }));
  const tutor = (item) => appendTo(els.tutorLog, messageItem({ at, ...item }));
  const library = (item) => appendTo(els.libraryLog, messageItem({ at, ...item }));
  const agentName = (id) => AGENT_NAMES[id] ?? id;

  if (source === 'system') {
    if (type === 'tutor_feed') {
      setBadge(els.tutorFeed, data.connected, data.connected ? 'Tutor feed: connected' : 'Tutor feed: offline');
    } else if (type === 'conversation_reset') {
      // Replayed in order on reload too, so a cleared screen stays cleared.
      clearScreen();
    } else if (type === 'tutor_status') {
      renderMode(data);
    } else if (type === 'agent_status') {
      if (data.agentId === 'library') {
        document.getElementById('library-role').textContent = `A2A server · answers from saved content · ${data.mode === 'live' ? `LIVE ${data.model}` : 'mock (no model)'}`;
      }
      if (agents[data.agentId] && data.skills) {
        agents[data.agentId].advertised = data.skills;
        renderSkillsBox(data.agentId);
      }
    } else if (type === 'agent_feed') {
      if (data.agentId === 'library') setBadge(els.libraryFeed, data.connected, data.connected ? 'Library feed: connected' : 'Library feed: offline');
    } else if (type === 'run_started') {
      currentRunId = runId;
      const kind = data.kind === 'chat' && data.routerMode && data.routerMode !== 'direct' ? 'chatRouted'
        : data.kind === 'chat' && data.tutorMode && data.tutorMode !== 'fixed' ? 'chatModel' : data.kind ?? 'chat';
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
      case 'route_decided': {
        const d = data;
        if (d.decision === 'route') {
          student({ dir: 'sent', label: `Routing → ${agentName(d.agentId)}`, text: d.reason, ids: { skill: d.skillId, router: d.model, routerUsage: d.usage ? `${d.usage.inputTokens} in / ${d.usage.outputTokens} out tokens` : null, run } });
        } else {
          student({ dir: 'info', label: d.decision === 'clarify' ? 'Clarification needed' : 'No matching service', text: d.decision === 'clarify' ? d.clarificationQuestion : d.reason, ids: { router: d.model, rejectedChoice: d.rejectedChoice ? `${d.rejectedChoice.agentId} / ${d.rejectedChoice.skillId}` : null, run } });
          if (isCurrent) els.timelineError.textContent = 'No service was called for this message.';
        }
        break;
      }
      case 'route_failed':
        student({ dir: 'error', label: 'Routing failed', text: `${data.message} No service was called.`, ids: { code: data.code, run } });
        if (isCurrent) els.timelineError.textContent = `Routing failed: ${data.message}`;
        break;
      case 'request_sent':
        student({ dir: 'sent', label: data.agentId ? `Sent to ${agentName(data.agentId)}` : 'Sent', text: data.text, ids: { messageId: data.messageId, contextId: data.contextId, run } });
        break;
      case 'reply_received':
        student({ dir: 'received', label: data.servedBy ? `Received from ${agentName(data.servedBy)}` : 'Received', text: data.text, ids: { model: fmtUsage(data.tutor), outcome: data.tutor?.outcome ?? data.library?.outcome, messageId: data.messageId, inReplyTo: data.inReplyTo, contextId: data.contextId, taskId: data.taskId || '(none — direct Message reply)', anthropicRequest: data.tutor?.requestId, run } });
        break;
      case 'registry_updated':
      case 'registry_refresh_failed':
        if (agents[data.agentId]) {
          agents[data.agentId].registry = data;
          renderSkillsBox(data.agentId);
        }
        break;
      case 'card_notification_received':
        if (agents[data.agentId]) agents[data.agentId].received = data;
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
  } else if (source === 'library') {
    switch (type) {
      case 'message_received':
        library({ dir: 'received', label: 'Received', text: data.text, ids: { messageId: data.messageId, contextId: data.contextId, run } });
        break;
      case 'scope_checked':
        library({ dir: data.verdict === 'in_scope' ? 'received' : 'info', label: 'Scope check', text: `${data.verdict}${data.handler ? ` (handler: ${data.handler})` : ''}`, ids: { policyRevision: data.policyRevision, run } });
        break;
      case 'reply_published':
        library({ dir: 'sent', label: 'Sent', text: data.text, ids: { outcome: data.library?.outcome, messageId: data.messageId, contextId: data.contextId, inReplyTo: data.inReplyTo, run } });
        break;
      case 'skills_saved':
        agents.library.saved = { ...data, at };
        loadAdvertised('library');
        break;
      case 'card_notification':
        agents.library.notification = data;
        renderSkillsBox('library');
        break;
    }
    if (isCurrent) markStep(type, at);
  } else if (source === 'tutor') {
    switch (type) {
      case 'skills_saved':
        agents.tutor.saved = { ...data, at };
        loadAdvertised('tutor');
        break;
      case 'card_notification':
        agents.tutor.notification = data;
        renderSkillsBox('tutor');
        break;
      case 'scope_checked':
        tutor({ dir: data.verdict === 'in_scope' ? 'received' : 'info', label: data.stage === 'release' ? 'Release check' : 'Scope check', text: `${data.verdict}${data.reason ? ` — ${data.reason}` : ''}`, ids: { policyRevision: data.policyRevision, run } });
        break;
      case 'answer_checked':
        tutor({ dir: data.violates ? 'error' : 'received', label: 'Answer check', text: data.violates ? `Withheld — ${data.reason}` : 'Within scope', ids: { run } });
        break;
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
  renderRouter(hello.router);
  const lib = hello.agents?.library;
  if (lib) setBadge(els.libraryFeed, lib.feedConnected, lib.feedConnected ? 'Library feed: connected' : 'Library feed: offline');
  for (const [id, a] of Object.entries(hello.agents ?? {})) if (agents[id] && a.status?.skills) agents[id].advertised = a.status.skills;
  for (const r of hello.registry ?? []) if (agents[r.agentId]) agents[r.agentId].registry = r;
  for (const id of Object.keys(agents)) renderSkillsBox(id);
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
