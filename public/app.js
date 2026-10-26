// Browser side of the monitor. Renders only events published by the UI server;
// it never decides on its own that a step happened. Text is set with textContent.
//
// Forms (Parts 3 and 6) are drawn by the official A2UI v0.9 Lit renderer from the A2UI messages an
// agent sent over A2A in reply to a chat message (delivered here by the event stream); see
// forms-ui.js. Draft values live only in the renderer's local data model until Submit.
import { createFormsUi } from './forms-ui.js';
import { WORKFLOWS, prettyDate } from '/shared/forms.js';

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
  tutorMode: $('tutor-mode'),
  conversation: $('conversation'),
  newConversation: $('new-conversation'),
  formError: $('form-error'),
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
  idle: 'idle', routing: 'routing', sending: 'sending', waiting: 'waiting for response', completed: 'completed', failed: 'failed',
  uncertain: 'outcome uncertain',
};
const BUSY = new Set(['routing', 'sending', 'waiting']); // blocks Send

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
  // One action on a form (Part 6), always sent to the agent that issued the form.
  form_action: [
    ['form_action_sent', 'Action sent', 'over A2A to the issuing agent'],
    ['form_action_received', 'Agent received', 'confirmed by that agent'],
    ['form_action_result', 'Result returned', 'from the agent’s handler, over A2A'],
  ],
};

let bootId = null;
let seen = new Set(); // event seq numbers already rendered (history is replayed on reconnect)
let currentRunId = null;
let currentState = 'idle';
let awaitingRunId = null; // set between clicking Send and that run leaving a busy state
const formsUi = createFormsUi({ log: els.studentLog, agentName: (id) => AGENT_NAMES[id] ?? id, onChange: () => renderState() });
let currentContextId = null; // the chat conversation follow-up questions belong to (null → start a new one)

const MODE_TEXT = {
  live: (s) => `Tutor: live (${s.model})`,
  mock: () => 'Tutor: mock model (no external calls)',
  fixed: () => 'Tutor: fixed reply (no model)',
};

function renderMode(status) {
  if (!status) return;
  els.tutorMode.dataset.mode = status.mode;
  els.tutorMode.textContent = (MODE_TEXT[status.mode]?.(status) ?? `Tutor: ${status.mode}`) + (status.mode === 'live' && !status.keyConfigured ? ', no API key set' : '');
}

function renderConversation() {
  els.conversation.textContent = currentContextId ? `Conversation ${currentContextId.slice(0, 8)}` : 'New conversation';
  els.conversation.title = currentContextId ? `Conversation ${currentContextId}: follow-ups use its history` : 'Your next message starts a fresh conversation';
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

// speaker: who produced the line (student | tutor | library | router) — it sets the line's color.
// kind "note": a routing/system line, shown small and centered in the chat.
function messageItem({ dir, label, at, text, values, ids, speaker, kind }) {
  const li = document.createElement('li');
  li.className = kind === 'note' ? 'msg note' : 'msg';
  li.dataset.dir = dir;
  if (speaker) li.dataset.speaker = speaker;

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
  // Offered whenever there's something on screen to clear; unavailable mid-request.
  els.newConversation.hidden = !currentContextId && ![els.studentLog, els.tutorLog, els.libraryLog].some((log) => log.children.length);
  els.newConversation.disabled = busy || formsUi.busy;
}

// Empty every conversation panel and forget the current conversation (not the event
// bookkeeping). Each agent's skills box stays: that's agent configuration, not conversation.
function clearScreen() {
  currentRunId = null;
  currentState = 'idle';
  formsUi.clear();
  els.studentLog.replaceChildren();
  els.tutorLog.replaceChildren();
  els.libraryLog.replaceChildren();
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

// ---- Part 5: advertised skills, Student's cached view, propagation ---------

const AGENT_NAMES = { tutor: 'Tutor Agent', library: 'Library Agent' };
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
      el('span', { className: 'tested', textContent: a.advertised.matchesTestedDefault ? 'Matches the tested default.' : 'Changed since tests; not verified.' })));
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
      ? section('How it answers', null, el('p', { className: 'note', textContent: 'Built-in workflow form, handled by code: the agent sends it when a student asks for it in chat. You can rename, re-describe, or turn it off (then no form is sent or accepted); it has no answer content.' }))
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
  els.dialogIdentity.textContent = `${body.agentName} (ID “${body.agentId}”), revision ${body.revision}. ${body.matchesTestedDefault ? 'Matches the tested default.' : 'Changed since tests; not verified.'}`;
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

const ROUTER_TEXT = { direct: 'Router: off (everything to Tutor)', mock: 'Router: mock heuristic (no external calls)', live: 'Router: live (claude-haiku-5-5)' };
function renderRouter(router) {
  if (!router) return;
  els.routerMode.dataset.mode = router.mode === 'live' ? 'live' : router.mode === 'mock' ? 'mock' : 'direct';
  els.routerMode.textContent = ROUTER_TEXT[router.mode] ?? `Router: ${router.mode}`;
}

// In the chat, color says who spoke and position says direction: your messages on the right,
// agents' replies on the left, routing/system lines small in the middle.
function chatRole({ label = '', dir }) {
  if (/^Sent/.test(label)) return { speaker: 'student' };
  if (/Tutor Agent/.test(label) && /^Received|Tutor error/.test(label)) return { speaker: 'tutor' };
  if (/Library Agent/.test(label) && /^Received/.test(label)) return { speaker: 'library' };
  if (/^(Routing|No matching|Clarification needed|Routing failed)/.test(label)) return { speaker: 'router', kind: dir === 'error' ? undefined : 'note' };
  return {};
}

// ---- event handling -----------------------------------------------------

function handle(event) {
  const { source, type, runId, at, data } = event;
  const run = runId ? runId.slice(0, 8) : null;
  const isCurrent = runId === currentRunId;
  const student = (item) => appendTo(els.studentLog, messageItem({ at, ...chatRole(item), ...item }));
  const tutor = (item) => appendTo(els.tutorLog, messageItem({ at, speaker: 'tutor', ...item }));
  const library = (item) => appendTo(els.libraryLog, messageItem({ at, speaker: 'library', ...item }));
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
        document.getElementById('library-role').textContent = `A2A server, answers from saved content (${data.mode === 'live' ? `live, ${data.model}` : 'mock, no model'})`;
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
    } else if (type === 'form_lifecycle') {
      formsUi.lifecycle({ ...data, at });
      if (data.state === 'confirmation_pending') {
        student({ dir: 'error', label: 'Confirmation pending', text: 'No reply in time; the outcome is unknown until it is checked.', ids: { form: data.formId, operation: data.operationId, run } });
      }
    } else if (type === 'form_note') {
      student({ dir: 'info', label: 'Form', text: data.text, ids: { form: data.formId, run } });
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
      // forms (Part 6): only ever sent by an agent in reply to a chat message
      // The form is itself a chat item (forms-ui.js): it arrives as the agent's message, becomes the
      // student's submitted summary, and the agent's reply to the final action follows it here.
      // Lookups and review steps stay inside the form (and in the agent's panel), not in the chat.
      case 'form_received':
        formsUi.received({ ...data, at });
        break;
      case 'form_action_sent':
        break;
      case 'form_action_result': {
        formsUi.actionResult(data);
        if (!WORKFLOWS[data.workflowId]?.actions[data.actionName]?.final) break;
        const r = data.body?.receipt;
        const values = r?.bookingId
          ? { 'Booking ID': r.bookingId, Room: r.room, Date: prettyDate(r.date), Time: `${r.start}–${r.end}`, 'Group size': r.groupSize, Timezone: r.timezone, Note: r.note }
          : r?.requestId ? { 'Request ID': r.requestId, Status: r.status, 'Preferred date': prettyDate(r.preferences.preferredDate), 'Time of day': r.preferences.period, 'Specific time': r.preferences.specificTime ?? 'none', Timezone: r.timezone, Note: r.note } : undefined;
        const flagged = data.body?.status === 'needs_review';
        student({ dir: data.body?.status === 'rejected' || data.body?.status === 'conflict' ? 'error' : 'received', label: `Received from ${agentName(data.agentId)}${data.duplicate ? ' (already recorded)' : ''}${flagged ? ' (please check)' : ''}`, text: data.text || data.body?.status, values, ids: { form: data.formId, operation: data.operationId, messageId: data.messageId, taskId: data.taskId ? `${data.taskId}` : '(direct Message reply)', a2uiUpdate: data.a2uiUpdate?.length ? `${data.a2uiUpdate.length} message(s)` : null, run } });
        break;
      }
      case 'form_action_failed':
        if (!WORKFLOWS[data.workflowId]?.actions[data.actionName]?.final) {
          formsUi.actionFailed(data);
          break;
        }
        student({ dir: 'error', label: data.outcome === 'uncertain' ? 'Uncertain' : 'Failed', text: `${data.actionName}: ${data.outcome === 'uncertain' ? 'no reply in time — outcome unknown' : 'not delivered'} (${data.error}${data.code ? `, ${data.code}` : ''})`, ids: { form: data.formId, operation: data.operationId, run } });
        formsUi.actionFailed(data);
        break;
    }
    // A Tutor-reported error still arrived as an A2A response; a form is the A2A response of a chat run.
    if (isCurrent) markStep(type === 'tutor_error' || type === 'form_received' ? 'reply_received' : type, at);
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
      default:
        formAgentEvent(library, type, data, run);
    }
    if (isCurrent) markStep(type === 'form_sent' ? 'reply_published' : type === 'intent_decided' ? 'scope_checked' : type, at);
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
      default:
        formAgentEvent(tutor, type, data, run);
    }
    if (isCurrent) markStep(type === 'form_sent' ? 'reply_published' : type === 'intent_decided' ? 'scope_checked' : type, at);
  }
  renderState();
}

// Part 6 events from the issuing agent (Tutor or Library), shown in that agent's panel.
function formAgentEvent(panel, type, data, run) {
  switch (type) {
    case 'intent_decided':
      panel({ dir: 'info', label: 'Intent', text: { offer: 'Workflow request → send the form', info: 'Question about the workflow → explain it', clarify: 'Unclear → ask a question' }[data.outcome] ?? data.outcome, ids: { decidedBy: data.by, reason: data.reason, run } });
      break;
    case 'form_sent':
      panel({ dir: 'sent', label: data.repeat ? 'Sent (same form again)' : 'Sent form', text: `${data.workflowId}: A2UI form in a task awaiting input${data.prefilled?.length ? ` (prefilled: ${data.prefilled.join(', ')})` : ''}${data.supersedes ? ` — replaces ${data.supersedes}` : ''}.`, ids: { form: data.formId, taskId: data.taskId, contextId: data.contextId, messageId: data.messageId, run } });
      break;
    case 'form_action_received':
      panel({ dir: 'received', label: 'Form action', text: `“${data.actionName}”${data.lookup ? ' — scheduling fields only:' : data.receivedValues && Object.keys(data.receivedValues).length ? ' — values exactly as received:' : ''}`, values: data.receivedValues ?? data.criteria ?? undefined, ids: { form: data.formId, operation: data.operationId, messageId: data.messageId, taskId: data.taskId, resumedTask: data.resumedTask, run } });
      break;
    case 'form_review':
      panel({ dir: data.flags?.length ? 'info' : 'received', label: 'Review', text: data.acknowledged ? 'Student chose to send anyway; the flagged values were not re-reviewed.' : data.unavailable ? `Review unavailable (${data.unavailable}); the submission continues.` : data.flags?.length ? `${data.reviewer} flagged: ${data.flags.map((f) => f.message).join(' ')}` : `${data.reviewer} found nothing to flag.`, ids: { form: data.formId, run } });
      break;
    case 'form_reply_sent': {
      const r = data.receipt;
      const detail = r?.bookingId ? ` Booking ${r.bookingId}: ${r.room}, ${r.date} ${r.start}–${r.end} (${r.timezone}).` : r?.requestId ? ` Request ${r.requestId}: ${r.status}.` : '';
      panel({ dir: data.status === 'rejected' || data.status === 'conflict' ? 'error' : 'sent', label: data.duplicate ? 'Sent (stored result again)' : 'Sent', text: `${data.text}${detail}`, ids: { form: data.formId, operation: data.operationId, action: data.actionName, task: data.taskState, contextId: data.contextId, run } });
      break;
    }
    case 'form_action_result': {
      const r = data.receipt;
      const text = data.duplicate ? `Same operation ID as before — returned the stored ${data.status} result; nothing re-executed.`
        : data.status === 'accepted' ? (r?.requestId ? `Recorded request ${r.requestId} (${r.status}).` : `Reserved demo booking ${r?.bookingId}.`)
          : data.status === 'rejected' || data.status === 'conflict' ? `${data.status}: ${errorText(data.errors)}` : `${data.actionName}: ${data.status}`;
      panel({ dir: data.status === 'rejected' || data.status === 'conflict' ? 'error' : 'sent', label: data.status === 'accepted' ? 'Accepted' : 'Result', text, values: data.status === 'accepted' && !data.duplicate ? data.values ?? undefined : undefined, ids: { form: data.formId, operation: data.operationId, run } });
      break;
    }
  }
}

// ---- connections --------------------------------------------------------

// Visualization stream only. EventSource reconnects automatically with a GET;
// that can never start an A2A request or submit a form (only the POST endpoints can).
const stream = new EventSource('/api/events');
stream.addEventListener('open', () => setBadge(els.browserFeed, true, 'Browser stream: connected'));
stream.addEventListener('error', () => setBadge(els.browserFeed, false, 'Browser stream: reconnecting…'));
stream.addEventListener('hello', (e) => {
  const hello = JSON.parse(e.data);
  formsUi.setReplaying(true); // history follows; forms are reconstructed when it ends
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
stream.addEventListener('replayed', () => formsUi.replayDone());
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

renderConversation();
renderState();
