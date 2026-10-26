// Browser side of the monitor. Renders only events published by the UI server;
// it never decides on its own that a step happened. Text is set with textContent.
//
// Forms (Parts 3 and 6) are drawn by the official A2UI v0.9 Lit renderer from the A2UI messages an
// agent sent over A2A in reply to a chat message (delivered here by the event stream); see
// forms-ui.js. Draft values live only in the renderer's local data model until Submit.
// Part 7: three tabs. Conversation (you and the university), Agent activity (one console per agent)
// and Topology (the live switchboard, public/topology.js).
import { createFormsUi } from './forms-ui.js';
import { createTopology } from './topology.js';
import { createClassroom } from './classroom.js';
import { WORKFLOWS, prettyDate } from '/shared/forms.js';

const $ = (id) => document.getElementById(id);
const els = {
  browserFeed: $('browser-feed'),
  hubFeed: $('hub-feed'),
  liveBanner: $('live-banner'),
  universityName: $('university-name'),
  studentConsole: $('studentc-log'),
  hubLog: $('hub-log'),
  hubBox: $('hub-box'),
  tabPulse: $('tab-pulse'),
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
  professorLog: $('professor-log'),
  inspectorLog: $('inspector-log'),
  routerMode: $('router-mode'),
  refreshSkills: $('refresh-skills'),
  skillsBox: { tutor: $('tutor-skills'), library: $('library-skills'), professor: $('professor-skills') },
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

const topology = createTopology({
  svg: $('topo'), detail: $('topo-detail'), list: $('topo-events'), count: $('topo-count'), traceSelect: $('topo-trace'),
  truncatedNote: $('topo-truncated'), clockEl: $('topo-clock'),
  controls: { heartbeats: $('topo-heartbeats'), reduce: $('topo-reduce'), pause: $('topo-pause') },
  agentColor: (id) => ({ student: 'var(--student)', hub: 'var(--hub)', tutor: 'var(--tutor)', library: 'var(--library)', professor: 'var(--professor)', model: 'var(--model)' })[id] ?? 'var(--muted)',
  // A small dot on the Topology tab when traffic happens while another tab is showing.
  onActivity: () => { if ($('view-topology').hidden) $('tab-pulse').dataset.on = 'true'; },
});

// Part 9: the course inbox, lesson view and toast (Conversation) and the Professor view.
const classroom = createClassroom({
  sendChat: (text, extra) => { chatFollow.pin(); return startRun('/api/runs', { text, contextId: currentContextId, ...extra }); },
  showConversation: () => { if ($('view-conversation').hidden) showTab(tabs[0], { history: 'push' }); },
  focusComposer: () => { showTab(tabs[0], { history: 'push' }); els.message.focus(); },
});

const STATE_LABELS = {
  idle: 'idle', sending: 'sending', waiting: 'waiting for response', completed: 'completed', failed: 'failed',
  uncertain: 'outcome uncertain',
};
const BUSY = new Set(['sending', 'waiting']); // blocks Send

// Timeline steps per run kind: [key, label, note]. A key is "<who>:<event>" where who is student, hub or
// specialist (whichever service the Hub chose). A step is marked only when its real event arrives; steps
// the flow really didn't take (the Hub answered itself, the Student asked you first, a failure) are
// marked skipped with the reason. The strip resets for every new question or form action.
const STEPS = {
  chat: [
    ['student:request_planned', 'Student checked', 'what the question needs'],
    ['student:request_sent', 'Student sent', 'to the university Hub, over A2A'],
    ['hub:message_received', 'Hub received', 'confirmed by the Hub'],
    ['hub:route_decided', 'Hub routed', 'destination chosen and checked'],
    ['hub:forward_attempted', 'Hub forwarded', 'to the specialist, over A2A'],
    ['specialist:message_received', 'Specialist received', 'confirmed by that service'],
    ['specialist:reply_published', 'Specialist replied', 'answer or form, over A2A'],
    ['hub:forward_completed', 'Hub got the reply', 'relayed back to the Student'],
    ['student:reply_received', 'Student received', 'A2A result from the Hub'],
  ],
  // One action on a form, always forwarded to the service that issued it.
  form_action: [
    ['student:form_action_sent', 'Action sent', 'to the Hub, with its form reference'],
    ['hub:form_action_received', 'Hub received', 'reference checked'],
    ['hub:form_forwarded', 'Hub forwarded', 'to the issuing service'],
    ['specialist:form_action_received', 'Issuer received', 'confirmed by that service'],
    ['specialist:form_reply_sent', 'Issuer replied', 'authoritative result'],
    ['hub:form_result_relayed', 'Hub relayed', 'back to the Student'],
    ['student:form_action_result', 'Student received', 'result over A2A'],
  ],
};
const STEP_ALIASES = { 'student:tutor_error': 'student:reply_received', 'student:form_received': 'student:reply_received', 'specialist:form_sent': 'specialist:reply_published' };
const stepKey = (source, type) => {
  const who = source === 'tutor' || source === 'library' || source === 'professor' ? 'specialist' : source;
  const key = `${who}:${type}`;
  return STEP_ALIASES[key] ?? key;
};

let bootId = null;
let seen = new Set(); // event seq numbers already rendered (history is replayed on reconnect)
let currentRunId = null;
let currentRunKind = null;
let currentState = 'idle';
let awaitingRunId = null; // set between clicking Send and that run leaving a busy state
const follow = new Map([els.studentLog, els.studentConsole, els.hubLog, els.tutorLog, els.libraryLog, els.professorLog].map((log) => [log, followBottom(log)]));
const chatFollow = follow.get(els.studentLog);
window.__chatFollow = chatFollow; // read-only hook for browser tests (following state)
const formsUi = createFormsUi({ log: els.studentLog, agentName: (id) => viaUniversity(id), onChange: () => renderState(), pinToBottom: () => chatFollow.pin() });
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
  if (pending.el && log === els.studentLog && item !== pending.el) log.append(pending.el); // the indicator stays last
}

// A log follows its newest item while the reader is at the bottom — including when an item keeps
// growing after it was added (A2UI surfaces render asynchronously, receipts and reopened forms expand,
// a replay after a reload adds many items). Scrolling up stops following, so a reader is never pulled
// away from what they're reading; scrolling back to the bottom, sending a message or starting a new
// conversation follows again. Works while the log is hidden too: it catches up when its tab is shown.
const BOTTOM_SLACK_PX = 40;
function followBottom(log) {
  const state = { following: true, lastTop: 0 };
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK_PX;
  const toBottom = () => {
    if (!state.following) return;
    log.scrollTop = log.scrollHeight;
    state.lastTop = log.scrollTop;
  };
  log.addEventListener('scroll', () => {
    // Content growth never lowers scrollTop; only the reader scrolling up does (or content shrinking,
    // which leaves us at the bottom anyway).
    if (log.scrollTop < state.lastTop - 1) state.following = nearBottom();
    else if (nearBottom()) state.following = true;
    state.lastTop = log.scrollTop;
  }, { passive: true });
  // The reader's intent to go up stops following at once (before the scroll event, so growth arriving
  // in between can't pull them back down).
  log.addEventListener('wheel', (e) => { if (e.deltaY < 0) state.following = false; }, { passive: true });
  let touchY = null;
  log.addEventListener('touchstart', (e) => { touchY = e.touches[0]?.clientY ?? null; }, { passive: true });
  log.addEventListener('touchmove', (e) => { const y = e.touches[0]?.clientY; if (touchY !== null && y > touchY + 4) state.following = false; }, { passive: true });
  log.addEventListener('keydown', (e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) state.following = false; });
  const sizes = new ResizeObserver(toBottom);
  sizes.observe(log);
  for (const child of log.children) sizes.observe(child);
  new MutationObserver((records) => {
    for (const r of records) for (const node of r.addedNodes) if (node.nodeType === 1) sizes.observe(node);
    toBottom();
  }).observe(log, { childList: true });
  return {
    pin() { state.following = true; toBottom(); },
    get following() { return state.following; },
  };
}

// "Waiting for an answer…": a small in-chat spinner when a chat question has been in flight for more than
// a second. It goes away as soon as anything answers the question (reply, form, clarifying question,
// the Student's own answer, an error) and is never shown for fast answers.
const PENDING_AFTER_MS = 1000;
let pending = { runId: null, timer: null, el: null };
function showPending() {
  const li = document.createElement('li');
  li.className = 'chat-pending';
  li.setAttribute('role', 'status');
  const spin = document.createElement('span');
  spin.className = 'spinner';
  spin.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = 'Waiting for an answer…';
  li.append(spin, label);
  pending.el = li;
  appendTo(els.studentLog, li);
}
function answerArrived(runId) {
  if (pending.runId !== runId) return;
  clearTimeout(pending.timer);
  pending.el?.remove();
  pending.timer = null;
  pending.el = null; // runId kept: this question is answered, so no indicator again
}
function updatePending() {
  const waiting = currentRunKind === 'chat' && currentRunId !== null && BUSY.has(currentState);
  if (waiting && pending.runId === currentRunId) return;
  clearTimeout(pending.timer);
  pending.el?.remove();
  pending = { runId: null, timer: null, el: null };
  if (waiting) pending = { runId: currentRunId, timer: setTimeout(showPending, PENDING_AFTER_MS), el: null };
}

function resetTimeline(runId, kind) {
  els.runId.textContent = `${kind} run ${runId}`;
  els.timelineError.textContent = '';
  els.timeline.replaceChildren(...STEPS[kind].map(([key, label, note]) => {
    const li = document.createElement('li');
    li.dataset.step = key;
    li.dataset.state = 'pending'; // pending → done | skipped | failed | unknown
    li.dataset.actor = key.split(':')[0]; // colors the step by the agent that does it
    const l = document.createElement('span');
    l.className = 'step-label';
    l.textContent = label;
    const n = document.createElement('span');
    n.className = 'step-note';
    n.textContent = note;
    const status = document.createElement('span');
    status.className = 'step-status';
    li.append(l, n, status);
    return li;
  }));
  updateActiveStep();
}

const STEP_STATUS = { done: '✓', failed: '✕ failed', unknown: '? outcome unknown', skipped: 'skipped' };
// Mark one step from its real event. Never moves a step that is already settled back to pending.
function markStep(step, at, { state = 'done', note } = {}) {
  const li = [...els.timeline.children].find((x) => x.dataset.step === step);
  if (!li) return;
  li.dataset.state = state;
  if (note) li.querySelector('.step-note').textContent = note;
  const status = li.querySelector('.step-status');
  status.replaceChildren();
  if (state === 'done' && at) {
    const t = document.createElement('time');
    t.dateTime = at;
    t.textContent = shortTime(at);
    status.append(t);
  } else status.textContent = STEP_STATUS[state] ?? '';
  updateActiveStep();
}
// Steps the flow really didn't take: marked skipped with the reason (only if not already observed).
function skipSteps(keys, reason) {
  for (const key of keys) {
    const li = [...els.timeline.children].find((x) => x.dataset.step === key);
    if (li && li.dataset.state === 'pending') markStep(key, null, { state: 'skipped', note: reason });
  }
}
// The specialist steps take the color of the service the Hub actually chose.
function setSpecialist(agentId) {
  for (const li of els.timeline.children) if (li.dataset.actor === 'specialist') li.dataset.agent = agentId;
}
// While the run is in flight, the first step not yet settled is the one happening now.
function updateActiveStep() {
  const busy = BUSY.has(currentState) || awaitingRunId !== null;
  const next = busy ? [...els.timeline.children].find((x) => x.dataset.state === 'pending') : null;
  for (const li of els.timeline.children) {
    const on = li === next;
    li.dataset.active = String(on);
    if (on) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    if (li.dataset.state === 'pending') li.querySelector('.step-status').textContent = on ? 'in progress…' : 'not yet';
  }
}

const CHAT_AFTER = (key) => STEPS.chat.slice(STEPS.chat.findIndex(([k]) => k === key) + 1).map(([k]) => k);
const SPECIALIST_LEG = ['hub:forward_attempted', 'specialist:message_received', 'specialist:reply_published', 'hub:forward_completed'];
const FORM_LEG = ['hub:form_forwarded', 'specialist:form_action_received', 'specialist:form_reply_sent', 'hub:form_result_relayed'];
const DECISION_TEXT = { clarify: 'it asked a clarifying question', unsupported: 'not supported', unavailable: 'service unavailable', rejected: 'request refused', failed: 'routing failed' };

// One real event of the current run → its step, with what actually happened.
function flowStep(source, type, data, at) {
  const key = stepKey(source, type);
  const name = (id) => AGENT_NAMES[id] ?? id;
  switch (key) {
    case 'student:request_planned': {
      const how = data.action === 'clarify' ? 'asked you to clarify first' : data.action === 'decline' ? 'not a university service — answered here'
        : data.capability ? `needs ${data.capabilityName ?? data.capability} (${data.by === 'model' ? 'its model' : data.by})`
          : { uncertain: 'your answer didn’t settle it — the Hub decides', rule: 'obvious — the Hub routes it', context: 'reply to the university — sent as-is', off: 'sent as-is (Student model off)', heuristic: 'the Hub decides', model: 'the Hub decides', model_failed: 'its model failed — the Hub decides' }[data.by] ?? 'sent as-is';
      markStep(key, at, { note: how });
      if (data.action === 'clarify') skipSteps(CHAT_AFTER(key), 'not sent — your Student agent asked you first');
      if (data.action === 'decline') skipSteps(CHAT_AFTER(key), 'not sent — your Student agent answered (not offered)');
      return;
    }
    case 'student:request_failed':
      markStep('student:request_sent', at, { state: data.outcome === 'uncertain' ? 'unknown' : 'failed', note: data.outcome === 'uncertain' ? 'no reply in time' : 'not delivered' });
      skipSteps(CHAT_AFTER('student:request_sent'), data.outcome === 'uncertain' ? 'outcome unknown' : 'not delivered');
      return;
    case 'hub:route_decided':
      if (data.decision === 'route') {
        setSpecialist(data.agentId);
        markStep(key, at, { note: `→ ${data.destination}${{ student: ' (Student’s choice)', lesson: ' (lesson you received)' }[data.decidedBy] ?? ''}` });
        for (const k of ['specialist:message_received', 'specialist:reply_published']) {
          const li = [...els.timeline.children].find((x) => x.dataset.step === k);
          if (li && li.dataset.state === 'pending') li.querySelector('.step-note').textContent = name(data.agentId);
        }
      } else {
        markStep(key, at, { note: `not routed: ${DECISION_TEXT[data.decision] ?? data.decision}` });
        skipSteps(SPECIALIST_LEG, `Hub answered itself (${DECISION_TEXT[data.decision] ?? data.decision})`);
      }
      return;
    case 'hub:route_failed':
      markStep('hub:route_decided', at, { state: 'failed', note: 'routing failed' });
      skipSteps(SPECIALIST_LEG, 'not forwarded — routing failed');
      return;
    case 'hub:forward_failed': {
      const unknown = data.outcome === 'unknown';
      if (data.outcome === 'answered_with_error') {
        markStep('hub:forward_completed', at, { state: 'failed', note: `${name(data.agentId)} reported an error` });
        return;
      }
      markStep('hub:forward_attempted', at, { state: unknown ? 'unknown' : 'failed', note: unknown ? `${name(data.agentId)} didn’t answer in time` : `${name(data.agentId)} unreachable` });
      skipSteps(['specialist:message_received', 'specialist:reply_published'], unknown ? 'outcome unknown' : 'not delivered');
      markStep('hub:forward_completed', at, { state: unknown ? 'unknown' : 'failed', note: 'the Hub told the Student' });
      return;
    }
    case 'student:reply_received':
      markStep(key, at, type === 'tutor_error' ? { state: 'failed', note: 'a service error came back' } : {});
      return;
    case 'hub:form_action_rejected':
      markStep('hub:form_action_received', at, { state: 'failed', note: 'reference refused' });
      skipSteps(FORM_LEG, 'not forwarded — refused by the Hub');
      return;
    case 'hub:form_action_duplicate':
      markStep('hub:form_action_received', at, { note: 'same operation ID — stored result' });
      skipSteps(FORM_LEG, 'not forwarded — stored result returned');
      return;
    case 'hub:form_forwarded':
      setSpecialist(data.agentId);
      markStep(key, at, { note: `to ${name(data.agentId)}` });
      return;
    case 'hub:form_forward_failed': {
      const unknown = data.outcome === 'unknown';
      markStep('hub:form_forwarded', at, { state: unknown ? 'unknown' : 'failed', note: unknown ? 'issuer didn’t confirm in time' : 'issuer unreachable' });
      skipSteps(['specialist:form_action_received', 'specialist:form_reply_sent'], unknown ? 'outcome unknown' : 'not delivered');
      markStep('hub:form_result_relayed', at, { state: unknown ? 'unknown' : 'failed', note: 'the Hub told the Student' });
      return;
    }
    case 'student:form_action_failed':
      markStep('student:form_action_sent', at, { state: data.outcome === 'uncertain' ? 'unknown' : 'failed' });
      skipSteps(STEPS.form_action.slice(1).map(([k]) => k), data.outcome === 'uncertain' ? 'outcome unknown' : 'not delivered');
      return;
    default:
      markStep(key, at);
  }
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
  topology.studentBusy(BUSY.has(currentState));
  // Offered whenever there's something on screen to clear; unavailable mid-request.
  els.newConversation.hidden = !currentContextId && ![els.studentLog, els.tutorLog, els.libraryLog, els.hubLog, els.studentConsole].some((log) => log.children.length);
  els.newConversation.disabled = busy || formsUi.busy;
  updateActiveStep();
  updatePending();
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
  els.hubLog.replaceChildren();
  els.studentConsole.replaceChildren();
  els.inspectorLog.replaceChildren();
  inspections.clear();
  for (const f of follow.values()) f.pin();
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
  topology.reset();
}

function reconcileButton(runId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inline-action';
  button.textContent = 'Check for answer';
  button.title = 'Re-sends the same request ID; the university returns its earlier result instead of routing or calling a service again.';
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

const AGENT_NAMES = { tutor: 'Tutor Agent', library: 'Library Agent', professor: 'Marketing 101 Professor', hub: 'University Hub', student: 'Student agent' };
let universityName = 'California State University Fullerton';
// Replies come from the university; the specialist that produced one is shown as attribution.
const viaUniversity = (id) => (id && id !== 'hub' ? `${universityName} · ${AGENT_NAMES[id] ?? id}` : universityName);
// Per agent: what it advertises (its own settings), the last save, the notification outcome,
// what Student received, and Student's cached registry view. Each comes from a real event.
const agents = {
  tutor: { advertised: null, saved: null, notification: null, received: null, registry: null },
  library: { advertised: null, saved: null, notification: null, received: null, registry: null },
  professor: { advertised: null, saved: null, notification: null, received: null, registry: null },
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
    rows.push(el('div', { className: 'skills-row' }, el('span', { className: 'label', textContent: `Hub’s view (rev ${r.revision ?? '?'}, ${r.status}):` }), ...(chips.length ? chips : [el('span', { textContent: 'none' })])));
  }
  if (a.saved) {
    const n = a.notification?.revision === a.saved.revision ? a.notification : null;
    const updated = r && r.revision === a.saved.revision && r.status === 'ready';
    rows.push(el('ul', { className: 'propagation', ariaLabel: 'Save and propagation' },
      el('li', { dataset: { status: 'ok' }, textContent: `Configuration saved — revision ${a.saved.revision} (${clock(a.saved.at)})` }),
      el('li', { dataset: { status: !n ? 'wait' : n.outcome === 'delivered' ? 'ok' : n.outcome === 'pending' ? 'pending' : 'bad' }, textContent: !n ? 'Notification: not sent yet' : `Notification ${n.outcome}: ${n.detail}` }),
      el('li', { dataset: { status: updated ? 'ok' : r?.status === 'stale' ? 'bad' : 'wait' }, textContent: updated ? `Hub routing updated — revision ${r.revision} (${clock(r.lastSuccessAt)})` : `Hub routing not updated yet${r?.lastError ? ` (${r.lastError})` : ''}` }),
    ));
  }
  const details = el('details', {}, el('summary', { textContent: 'Card details' }),
    definitionList('ids', [
      ['card revision', a.advertised?.revision], ['card ETag', a.advertised?.etag],
      ['Hub cached revision', r?.revision], ['Hub cached ETag', r?.etag],
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

const ROUTER_TEXT = { direct: 'Router: off (everything to tutoring)', mock: 'Router: mock heuristic (no external calls)' };
function renderRouter(router) {
  if (!router) return;
  els.routerMode.dataset.mode = router.mode === 'live' ? 'live' : router.mode === 'mock' ? 'mock' : 'direct';
  els.routerMode.textContent = router.mode === 'live' ? `Router: live (${router.model ?? 'model not reported'})` : ROUTER_TEXT[router.mode] ?? `Router: ${router.mode}`;
}

// In the chat, color says who produced the line and position says direction: your messages on the
// right, the university's replies on the left (colored by the specialist that answered, or the Hub's
// own color when it answered itself — a clarifying question, or "can't help" / "unavailable").

// ---- event handling -----------------------------------------------------

function handle(event, { live = true } = {}) {
  const { source, type, runId, at, data } = event;
  const run = runId ? runId.slice(0, 8) : null;
  const isCurrent = runId === currentRunId;
  const student = (item) => appendTo(els.studentLog, messageItem({ at, ...item }));
  const studentConsole = (item) => appendTo(els.studentConsole, messageItem({ at, speaker: 'student', ...item }));
  const hub = (item) => appendTo(els.hubLog, messageItem({ at, speaker: 'hub', ...item }));
  const tutor = (item) => appendTo(els.tutorLog, messageItem({ at, speaker: 'tutor', ...item }));
  const library = (item) => appendTo(els.libraryLog, messageItem({ at, speaker: 'library', ...item }));
  const professor = (item) => appendTo(els.professorLog, messageItem({ at, speaker: 'professor', ...item }));
  const agentName = (id) => AGENT_NAMES[id] ?? id;

  topology.event(event, { live });
  classroom.event(event, { live });
  if (source === 'system') {
    if (type === 'hub_feed') {
      setBadge(els.hubFeed, data.connected, data.connected ? 'Hub telemetry: connected' : 'Hub telemetry: lost');
      topology.hubFeed(data.connected);
      hub({ dir: data.connected ? 'received' : 'error', label: data.connected ? 'Telemetry connected' : 'Telemetry lost', text: data.connected ? 'Following the Hub’s event feed.' : 'The Hub’s event feed is unreachable; its state below may be out of date.', ids: {} });
    } else if (type === 'topology') {
      applyTopology(data);
    } else if (type === 'conversation_reset') {
      // Replayed in order on reload too, so a cleared screen stays cleared.
      clearScreen();
    } else if (type === 'agent_status') {
      topology.agentMode(data.agentId, { mode: data.mode, model: data.model, keyConfigured: data.keyConfigured });
      if (data.agentId === 'tutor') renderMode(data);
      if (data.agentId === 'professor') {
        document.getElementById('professor-role').textContent = `Marketing 101 · answers from the course pack (${data.mode === 'live' ? `live, ${data.model}` : 'mock, no model'})`;
      }
      if (data.agentId === 'library') {
        document.getElementById('library-role').textContent = `Specialist behind the Hub · answers from saved content (${data.mode === 'live' ? `live, ${data.model}` : 'mock, no model'})`;
      }
      if (agents[data.agentId] && data.skills) {
        agents[data.agentId].advertised = data.skills;
        renderSkillsBox(data.agentId);
      }
    } else if (type === 'run_started') {
      currentRunId = runId;
      currentRunKind = data.kind ?? 'chat';
      topology.runStarted(runId, data);
      resetTimeline(runId, data.kind ?? 'chat');
      if (data.kind === 'chat') {
        currentContextId = data.contextId;
        renderConversation();
      }
    } else if (type === 'state') {
      topology.runState(runId, data.state);
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
    if (['reply_received', 'tutor_error', 'request_failed', 'form_received', 'clarification_asked', 'request_declined'].includes(type)) answerArrived(runId);
    switch (type) {
      case 'card_discovered':
        topology.studentCard(true);
        if (data.reason) studentConsole({ dir: 'received', label: 'University card verified', text: `${data.name}: name, endpoint and protocol match this Student’s configuration.`, ids: { endpoint: data.url, skills: data.skills?.join(', ') } });
        break;
      case 'hub_card_failed':
        topology.studentCard(false);
        studentConsole({ dir: 'error', label: 'University card not available', text: data.error, ids: { reason: data.reason } });
        break;
      // The Student's own model (STUDENT_MODE): its plan before anything is sent, and its calls.
      case 'request_planned': {
        const how = { uncertain: 'your answer didn’t settle it — the Hub decides', rule: 'obvious from the words — the Hub routes it', model: 'decided by the Student’s model', heuristic: 'mock heuristic', context: 'reply to the university’s question', off: 'Student model off', model_failed: 'Student model failed', lesson: 'about a lesson you received — routed by its delivery record', course: 'asked for this course' }[data.by] ?? data.by;
        const text = data.action === 'clarify' ? 'Not clear enough to send yet — asking you first.' : data.action === 'decline' ? 'Clearly not a university service — answering you here; nothing sent.' : data.capability ? `Needs ${data.capabilityName ?? data.capability}; the Hub will be asked for that capability.` : 'No capability chosen; the Hub routes it.';
        const relation = data.relation === 'new_request' ? ' (A new request — my earlier question was dropped.)' : data.relation === 'answers_question' ? ' (Your answer to my question — sent together with your earlier message.)' : '';
        studentConsole({ dir: data.error ? 'error' : 'info', label: `Plan: ${data.action === 'clarify' ? 'clarify first' : data.action === 'decline' ? 'answer here (not offered)' : data.capability ? `send to ${data.capabilityName ?? data.capability}` : 'send as-is'}`, text: `${text} ${data.reason ?? ''}${relation}`.trim(), ids: { how, matched: data.matched?.map((m) => `${m.id}: ${m.terms.join(', ')}`).join('; ') || null, model: data.usage ? `${data.model} · ${data.usage.inputTokens} in / ${data.usage.outputTokens} out tokens` : null, run } });
        break;
      }
      // Part 9: the Student agent's inbound side — its session with the Hub and what the Hub delivered.
      case 'student_session':
        studentConsole({ dir: data.status === 'registered' ? 'received' : 'error', label: data.status === 'registered' ? 'Session with the university' : 'Session not registered', text: data.status === 'registered' ? 'Registered its inbound endpoint and answered the Hub’s challenge; its requests are now signed.' : `The Hub didn’t accept the session (${data.reason ?? data.status}); retrying.`, ids: {} });
        break;
      case 'lesson_received':
        studentConsole({ dir: 'received', label: 'Lesson delivered', text: `“${data.title || 'Untitled lesson'}” (${data.courseTitle}) — saved in the inbox before confirming to the Hub.`, ids: { delivery: data.deliveryId, lesson: data.lessonId, revision: data.revision } });
        break;
      case 'lesson_opened':
        studentConsole({ dir: 'sent', label: 'Lesson opened', text: 'You opened it; a signed receipt goes to the Hub.', ids: { delivery: data.deliveryId } });
        break;
      case 'course_available':
        studentConsole({ dir: 'received', label: 'Course available', text: `${data.courseTitle} is now available.`, ids: { notice: data.noticeId } });
        break;
      case 'clarification_asked':
        student({ dir: 'sent', speaker: 'student', label: 'You (held by your Student agent, not sent yet)', text: data.question, ids: { contextId: data.contextId, run } });
        student({ dir: 'received', speaker: 'student', label: 'Your Student agent asks', text: data.text, ids: { note: 'Your answer is sent to the university together with your question.', run } });
        break;
      case 'request_declined':
        student({ dir: 'sent', speaker: 'student', label: 'You (not sent — answered by your Student agent)', text: data.question, ids: { contextId: data.contextId, run } });
        student({ dir: 'info', speaker: 'student', label: 'Your Student agent — not offered by the university', text: data.text, ids: { note: 'Nothing was sent to the university.', run } });
        break;
      case 'model_call_started':
        studentConsole({ dir: 'sent', label: 'Model call', text: `Calling ${data.model} to ${data.purpose}.`, ids: { mode: data.mode, run } });
        break;
      case 'model_response_received':
        studentConsole({ dir: 'received', label: 'Model reply', text: `${data.model} responded in ${(data.latencyMs / 1000).toFixed(1)} s (${data.usage?.inputTokens ?? '?'} input / ${data.usage?.outputTokens ?? '?'} output tokens).`, ids: { anthropicRequest: data.requestId, run } });
        break;
      case 'model_call_failed':
        studentConsole({ dir: 'error', label: 'Model error', text: data.message, ids: { code: data.code, anthropicRequest: data.requestId, run } });
        break;
      case 'request_sent':
        student({ dir: 'sent', speaker: 'student', label: `Sent to ${universityName}`, text: data.text, ids: { messageId: data.messageId, contextId: data.contextId, run } });
        studentConsole({ dir: 'sent', label: 'A2A request to the Hub', text: `message/send (${data.text?.length ?? 0} characters)`, ids: { messageId: data.messageId, contextId: data.contextId, run } });
        break;
      case 'reply_received': {
        const decision = data.hub?.decision;
        const own = decision && decision !== 'route';
        const label = own ? `${universityName}${decision === 'clarify' ? ' asks' : decision === 'unavailable' ? ' — service unavailable' : decision === 'unsupported' ? ' — not supported' : ''}` : viaUniversity(data.servedBy);
        student({ dir: own && decision !== 'clarify' ? 'info' : 'received', speaker: own ? 'hub' : data.servedBy ?? 'hub', label, text: data.text, ids: { answeredBy: own ? 'the Hub itself (no service called)' : agentName(data.servedBy), destination: data.hub?.destination, model: fmtUsage(data.tutor), outcome: data.tutor?.outcome ?? data.library?.outcome, messageId: data.messageId, inReplyTo: data.inReplyTo, contextId: data.contextId, taskId: data.taskId || '(none — direct Message reply)', run } });
        studentConsole({ dir: 'received', label: 'A2A reply from the Hub', text: own ? `Answered by the Hub (${decision}).` : `Relayed from ${agentName(data.servedBy)}.`, ids: { messageId: data.messageId, contextId: data.contextId, run } });
        break;
      }
      case 'tutor_error':
        student({ dir: 'error', speaker: 'hub', label: `${universityName} — service error`, text: data.message, ids: { code: data.code, anthropicRequest: data.requestId, messageId: data.messageId, contextId: data.contextId, run } });
        if (isCurrent) els.timelineError.textContent = `The Tutor could not answer: ${data.message}`;
        break;
      case 'request_failed': {
        const detail = data.code ? `${data.error} (${data.code})` : data.error;
        if (data.outcome === 'uncertain') {
          const item = messageItem({ at, dir: 'error', label: 'Uncertain', text: `No reply in time — the university may still be working on it. ${detail}`, ids: { request: data.messageId, run } });
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
        studentConsole({ dir: 'received', label: 'Form relayed by the Hub', text: `${data.workflowId} from ${agentName(data.issuer)} (task awaiting input).`, ids: { form: data.formId, formRef: data.formRef, taskId: data.taskId, run } });
        break;
      case 'form_action_sent':
        studentConsole({ dir: 'sent', label: 'Form action to the Hub', text: `“${data.actionName}” with the Hub’s form reference.`, ids: { form: data.formId, operation: data.operationId, run } });
        break;
      case 'form_action_result': {
        formsUi.actionResult(data);
        if (!WORKFLOWS[data.workflowId]?.actions[data.actionName]?.final) break;
        const r = data.body?.receipt;
        const values = r?.renewalId
          ? { 'Renewal ID': r.renewalId, Book: r.title, 'Loan ID': r.loanId, 'Previous due date': prettyDate(r.previousDueDate), 'New due date': prettyDate(r.newDueDate), 'Renewals used': r.renewalsUsed, Note: r.note }
          : r?.bookingId
          ? { 'Booking ID': r.bookingId, Room: r.room, Date: prettyDate(r.date), Time: `${r.start}–${r.end}`, 'Group size': r.groupSize, Timezone: r.timezone, Note: r.note }
          : r?.requestId ? { 'Request ID': r.requestId, Status: r.status, 'Preferred date': prettyDate(r.preferences.preferredDate), 'Time of day': r.preferences.period, 'Specific time': r.preferences.specificTime ?? 'none', Timezone: r.timezone, Note: r.note } : undefined;
        const flagged = data.body?.status === 'needs_review';
        student({ dir: data.body?.status === 'rejected' || data.body?.status === 'conflict' ? 'error' : 'received', speaker: data.agentId, label: `${viaUniversity(data.agentId)}${data.duplicate ? ' (already recorded)' : ''}${flagged ? ' (please check)' : ''}`, text: data.text || data.body?.status, values, ids: { form: data.formId, operation: data.operationId, messageId: data.messageId, taskId: data.taskId ? `${data.taskId}` : '(direct Message reply)', a2uiUpdate: data.a2uiUpdate?.length ? `${data.a2uiUpdate.length} message(s)` : null, run } });
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
    if (isCurrent) flowStep(source, type, data, at);
  } else if (source === 'hub') {
    hubEvent(hub, type, data, run);
    if (isCurrent) flowStep(source, type, data, at);
  } else if (source === 'library') {
    if (type === 'ui_generated' || type === 'loan_operation' || (type === 'form_action_result' && data.workflowId === 'loan-renewal')) inspectorEvent(type, data, runId, at);
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
    if (isCurrent) flowStep(source, type, data, at);
  } else if (source === 'professor') {
    // Part 9: the Marketing 101 Professor — student questions in, answers out, and lessons it posted.
    switch (type) {
      case 'message_received':
        professor({ dir: 'received', label: 'Received', text: data.text, ids: { messageId: data.messageId, contextId: data.contextId, run } });
        break;
      case 'reply_published':
        professor({ dir: 'sent', label: 'Sent', text: data.text, ids: { outcome: data.professor?.outcome, lesson: data.professor?.lessonId, model: data.professor?.model, messageId: data.messageId, inReplyTo: data.inReplyTo, run } });
        break;
      case 'model_call_started':
        professor({ dir: 'sent', label: 'Model call', text: `Calling ${data.model} (${data.purpose}).`, ids: { mode: data.mode, run } });
        break;
      case 'model_response_received':
        professor({ dir: 'received', label: 'Model reply', text: `${data.model} responded in ${(data.latencyMs / 1000).toFixed(1)} s (${data.usage?.inputTokens ?? '?'} input / ${data.usage?.outputTokens ?? '?'} output tokens).`, ids: { anthropicRequest: data.requestId, run } });
        break;
      case 'model_call_failed':
        professor({ dir: 'error', label: 'Model error', text: data.message, ids: { code: data.code, run } });
        break;
      case 'lesson_posted':
        professor({ dir: 'sent', label: 'Lesson posted', text: 'Sent to the university Hub over A2A (a new interaction, signed).', ids: { lesson: data.lessonId, revision: data.revision, operation: data.operationId } });
        break;
      case 'lesson_publish_result':
        professor({ dir: data.status === 'rejected' ? 'error' : 'received', label: 'Hub answered', text: `Lesson ${data.status}${data.reason ? ` (${data.reason})` : ''}${data.duplicate ? ' — stored result, nothing sent twice' : ''}.`, ids: { lesson: data.lessonId, revision: data.revision } });
        break;
      case 'skills_saved':
        agents.professor.saved = { ...data, at };
        loadAdvertised('professor');
        break;
      case 'card_notification':
        agents.professor.notification = data;
        renderSkillsBox('professor');
        break;
      default:
        break;
    }
    if (isCurrent) flowStep(source, type, data, at);
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
    if (isCurrent) flowStep(source, type, data, at);
  }
  renderState();
}

// The Hub's own events, in its console. Specialist registry state also feeds the skills boxes.
function hubEvent(panel, type, data, run) {
  const name = (id) => AGENT_NAMES[id] ?? id;
  switch (type) {
    case 'message_received':
      panel({ dir: 'received', label: 'Received from Student', text: `Question (${data.chars} characters).`, ids: { operation: data.operationId, messageId: data.messageId, contextId: data.contextId, run } });
      break;
    case 'request_repeat':
      panel({ dir: 'info', label: 'Repeat request', text: data.note, ids: { messageId: data.messageId, run } });
      break;
    case 'route_decided':
      panel({ dir: data.decision === 'route' ? 'sent' : 'info', label: data.decision === 'route' ? `Routed → ${data.destination}${{ student: ' (Student’s choice)', lesson: ' (lesson you received)' }[data.decidedBy] ?? ''}` : `Not routed: ${data.decision}`, text: data.decision === 'clarify' ? `Asks: ${data.clarificationQuestion}` : data.reason, ids: { decidedBy: data.decidedBy === 'student' ? 'the Student (capability checked by the Hub; no Hub router call)' : null, worker: data.agentId ? name(data.agentId) : null, skill: data.skillId, router: data.model, routerUsage: data.usage ? `${data.usage.inputTokens} in / ${data.usage.outputTokens} out tokens` : null, invalidChoice: data.invalid ? 'model choice refused by code' : null, operation: data.operationId, run } });
      break;
    // Part 9: lessons (Professor → Hub → Student), student sessions and course notices.
    case 'lesson_publish_received':
      panel({ dir: 'received', label: 'Lesson from the Professor', text: 'Signature, course, professor and enrollment checked; delivering to the student.', ids: { lesson: data.lessonId, revision: data.revision, delivery: data.deliveryId } });
      break;
    case 'lesson_rejected':
      panel({ dir: 'error', label: 'Lesson refused', text: data.reason, ids: { from: data.agentId, lesson: data.lessonId } });
      break;
    case 'lesson_delivery_attempted':
      panel({ dir: 'sent', label: 'Lesson sent to the Student', text: `Attempt ${data.attempt}, signed with the Student’s session.`, ids: { delivery: data.deliveryId } });
      break;
    case 'lesson_delivered':
      panel({ dir: 'received', label: 'Lesson delivered', text: data.duplicate ? 'Already in the Student’s inbox — not stored twice.' : 'The Student agent committed it to its inbox.', ids: { delivery: data.deliveryId } });
      break;
    case 'lesson_queued':
      panel({ dir: 'info', label: 'Lesson queued', text: `The Student agent is offline (${data.reason}); it will be delivered when it returns.`, ids: { delivery: data.deliveryId } });
      break;
    case 'lesson_uncertain':
      panel({ dir: 'error', label: 'Delivery outcome unknown', text: `${data.reason}. The Hub will ask the Student before sending again.`, ids: { delivery: data.deliveryId } });
      break;
    case 'lesson_reconciled':
      panel({ dir: 'info', label: 'Delivery reconciled', text: data.found ? 'The Student already had it — marked delivered, nothing re-sent.' : 'The Student didn’t have it — sending again.', ids: { delivery: data.deliveryId } });
      break;
    case 'lesson_failed':
      panel({ dir: 'error', label: 'Delivery refused', text: data.reason, ids: { delivery: data.deliveryId } });
      break;
    case 'lesson_opened':
      panel({ dir: 'received', label: 'Lesson opened', text: 'Signed receipt from the Student; the Professor will see it.', ids: { delivery: data.deliveryId } });
      break;
    case 'lesson_route_rejected':
      panel({ dir: 'error', label: 'Lesson question refused', text: 'That lesson wasn’t delivered to this student.', ids: { run } });
      break;
    case 'course_available_sent':
      panel({ dir: 'sent', label: 'Course announced', text: `Course availability delivered to ${data.studentId} (once).`, ids: { notice: data.noticeId } });
      break;
    case 'student_session':
      panel({ dir: data.status === 'registered' ? 'received' : 'error', label: data.status === 'registered' ? 'Student session' : 'Student session refused', text: data.status === 'registered' ? `${data.studentId}: challenge answered at the configured endpoint.` : `${data.studentId}: ${data.reason}`, ids: {} });
      break;
    case 'capability_rejected':
      panel({ dir: 'error', label: 'Capability not recognised', text: data.reason, ids: { requested: data.capability, operation: data.operationId, run } });
      break;
    case 'route_failed':
      panel({ dir: 'error', label: 'Routing failed', text: `${data.message} No service was called.`, ids: { code: data.code, run } });
      break;
    case 'forward_attempted':
      panel({ dir: 'sent', label: `Forwarding to ${name(data.agentId)}`, text: `A2A message/send to the configured ${data.destination} endpoint.`, ids: { operation: data.operationId, downstreamContext: data.downstreamContextId, downstreamMessage: data.downstreamMessageId, upstreamContext: data.upstreamContextId, run } });
      break;
    case 'forward_completed':
      panel({ dir: 'received', label: `Reply from ${name(data.agentId)}`, text: data.kind === 'form_offer' ? `A form (${data.workflowId}); relayed with Hub reference ${data.formRef?.slice(0, 11)}…` : 'Answer; relaying to the Student.', ids: { operation: data.operationId, downstreamTask: data.downstreamTaskId, formRef: data.formRef, run } });
      break;
    case 'forward_failed':
      panel({ dir: 'error', label: `${name(data.agentId)}: ${data.outcome.replaceAll('_', ' ')}`, text: data.message, ids: { code: data.code, operation: data.operationId, run } });
      break;
    case 'relay_sent':
      panel({ dir: 'sent', label: 'Sent to Student', text: data.repeat ? 'The earlier result, again.' : data.kind === 'form_offer' ? 'Form, as a task awaiting input.' : `Reply (${data.kind}).`, ids: { servedBy: data.servedBy, operation: data.operationId, run } });
      break;
    case 'form_ref_created':
      panel({ dir: 'info', label: 'Form reference created', text: `${data.workflowId} from ${name(data.agentId)}: bound to this student, conversation and downstream task.`, ids: { formRef: data.formRef, downstreamTask: data.downstreamTaskId } });
      break;
    case 'form_action_received':
      panel({ dir: 'received', label: 'Form action from Student', text: `“${data.actionName}”`, ids: { formRef: data.formRef, operation: data.operationId, issuer: data.agentId, run } });
      break;
    case 'form_action_rejected':
      panel({ dir: 'error', label: 'Form action refused', text: data.reason, ids: { formRef: data.formRef, operation: data.operationId, run } });
      break;
    case 'form_action_duplicate':
      panel({ dir: 'info', label: 'Duplicate operation', text: `Same operation ID — returned the stored ${data.status} result; nothing forwarded.`, ids: { operation: data.operationId, run } });
      break;
    case 'form_forwarded':
      panel({ dir: 'sent', label: `Forwarded to issuer ${name(data.agentId)}`, text: `“${data.actionName}” — follows the recorded mapping, no re-routing.`, ids: { formRef: data.formRef, downstreamTask: data.downstreamTaskId, operation: data.operationId, run } });
      break;
    case 'form_result_relayed':
      panel({ dir: ['rejected', 'conflict'].includes(data.status) ? 'error' : 'received', label: `Result from ${name(data.agentId)}: ${data.status}`, text: data.receipt?.id ? `Receipt ${data.receipt.id}.` : 'Relayed to the Student.', ids: { operation: data.operationId, formRef: data.formRef, run } });
      break;
    case 'form_forward_failed':
      panel({ dir: 'error', label: `Issuer ${data.outcome === 'unknown' ? 'outcome unknown' : 'unreachable'}`, text: data.message, ids: { operation: data.operationId, run } });
      break;
    case 'registration_accepted':
      panel({ dir: 'received', label: `${name(data.agentId)} registered`, text: `Instance ${data.instance}; verifying its card from the configured URL before dispatch.`, ids: { enabled: String(data.enabled) } });
      break;
    case 'registration_rejected':
      panel({ dir: 'error', label: 'Registration refused', text: data.reason, ids: { claimed: data.claimedAgentId } });
      break;
    case 'deregistered':
      panel({ dir: 'info', label: `${name(data.agentId)} signed out`, text: 'No new requests will be sent to it.', ids: {} });
      break;
    case 'registry_status':
      panel({ dir: data.status === 'ready' ? 'received' : 'error', label: `${name(data.agentId)}: ${data.status.replaceAll('_', ' ')}`, text: `Was ${data.from.replaceAll('_', ' ')} (${data.reason.replaceAll('_', ' ')}).${data.lastError && data.status !== 'ready' ? ` ${data.lastError}` : ''}`, ids: { revision: data.revision } });
      if (agents[data.agentId]) {
        agents[data.agentId].registry = { ...agents[data.agentId].registry, status: data.status, revision: data.revision, etag: data.etag, skills: data.skills, lastError: data.lastError, lastSuccessAt: agents[data.agentId].registry?.lastSuccessAt ?? null };
        renderSkillsBox(data.agentId);
      }
      break;
    case 'card_refreshed':
      if (data.changed) panel({ dir: 'received', label: `${name(data.agentId)} card fetched`, text: `Revision ${data.revision}: ${data.skills.map((k) => k.name).join(', ')}.`, ids: { reason: data.reason } });
      if (agents[data.agentId]) {
        const r = agents[data.agentId].registry ?? {};
        agents[data.agentId].registry = { ...r, revision: data.revision ?? r.revision, etag: data.etag ?? r.etag, skills: data.skills ?? r.skills ?? [], lastSuccessAt: new Date().toISOString(), lastError: null, status: r.status ?? 'ready' };
        renderSkillsBox(data.agentId);
      }
      break;
    case 'card_refresh_failed':
      panel({ dir: 'error', label: `${name(data.agentId)} card fetch failed`, text: data.error, ids: { reason: data.reason } });
      break;
    case 'card_notification_received':
      panel({ dir: 'received', label: `Card-change notice from ${name(data.agentId)}`, text: data.duplicate ? 'Duplicate notice — ignored.' : 'A hint only: re-fetching the card from the configured URL.', ids: { notification: data.notificationId, revision: data.revision } });
      break;
    case 'card_notification_rejected':
      panel({ dir: 'error', label: 'Card-change notice refused', text: data.reason, ids: { claimed: data.agentId } });
      break;
    case 'specialist_feed':
      panel({ dir: data.connected ? 'received' : 'error', label: `${name(data.agentId)} telemetry ${data.connected ? 'connected' : 'lost'}`, text: data.connected ? 'The Hub is relaying this service’s events.' : 'The Hub can’t read this service’s events right now.', ids: {} });
      break;
  }
}

function applyTopology(snap) {
  if (!snap) return;
  topology.snapshot(snap);
  if (snap.hub?.name) {
    universityName = snap.hub.name;
    els.universityName.textContent = universityName;
  }
  renderRouter(snap.hub?.router);
  if (snap.hub?.router) topology.agentMode('hub', { mode: snap.hub.router.mode === 'live' ? 'live' : snap.hub.router.mode, model: snap.hub.router.model, keyConfigured: snap.hub.router.keyConfigured });
  const hubBox = [el('div', { className: 'skills-row' }, el('span', { className: 'label', textContent: 'Destinations:' }),
    ...(snap.hub?.destinations ?? []).map((d) => el('span', { className: 'chip', textContent: `${d.destination} → ${d.workerName}` })))];
  els.hubBox.replaceChildren(...hubBox);
  for (const s of snap.specialists ?? []) {
    if (!agents[s.agentId]) continue;
    agents[s.agentId].registry = { status: s.status, revision: s.revision, etag: s.etag, skills: s.skills, lastError: s.lastError, lastSuccessAt: s.registeredAt };
    renderSkillsBox(s.agentId);
  }
}

// Part 6 events from the issuing agent (Tutor or Library), shown in that agent's panel.
function formAgentEvent(panel, type, data, run) {
  switch (type) {
    case 'intent_decided':
      panel({ dir: 'info', label: 'Intent', text: { offer: 'Workflow request → send the form', info: 'Question about the workflow → explain it', clarify: 'Unclear → ask a question', my_loans: 'About the student’s own loans → loan service + model' }[data.outcome] ?? data.outcome, ids: { decidedBy: data.by, reason: data.reason, run } });
      break;
    case 'ui_generated':
      panel({ dir: data.fallback ? 'error' : 'sent', label: data.kind === 'ui' ? 'Generated an interface' : data.fallback ? 'Generated UI failed checks' : data.kind === 'clarify' ? 'Asked a question' : 'Answered', text: data.kind === 'ui' ? `Composed from the catalog and validated (revision ${data.inspector?.surface?.revision ?? '?'}). See the Generated UI inspector.` : data.fallback ? 'The generated interface didn’t pass the checks; the student got a text reply instead.' : 'Replied in text from the loan records.', ids: { model: data.model, attempts: data.inspector?.validation?.length ?? null, run } });
      break;
    case 'loan_operation':
      panel({ dir: data.ok ? 'received' : 'error', label: data.ok ? 'Loan service: renewed' : 'Loan service: refused', text: `${data.operation} ${data.loanId}: ${data.code}${data.duplicate ? ' (stored outcome — nothing renewed twice)' : ''}`, ids: { form: data.formId, run } });
      break;
    case 'form_sent':
      panel({ dir: 'sent', label: data.repeat ? 'Sent (same form again)' : 'Sent form', text: `${data.workflowId}: A2UI form in a task awaiting input${Array.isArray(data.prefilled) && data.prefilled.length ? ` (prefilled: ${data.prefilled.join(', ')})` : ''}${data.supersedes ? ` — replaces ${data.supersedes}` : ''}.`, ids: { form: data.formId, taskId: data.taskId, contextId: data.contextId, messageId: data.messageId, run } });
      break;
    case 'form_action_received':
      panel({ dir: 'received', label: 'Form action', text: `“${data.actionName}”${data.lookup ? ' — scheduling fields only:' : data.receivedValues && Object.keys(data.receivedValues).length ? ' — values exactly as received:' : ''}`, values: data.receivedValues ?? data.criteria ?? undefined, ids: { form: data.formId, operation: data.operationId, messageId: data.messageId, taskId: data.taskId, resumedTask: data.resumedTask, run } });
      break;
    case 'form_review':
      {
        // The Hub redacts review flags by default: a list arrives as "[n items redacted]".
        const hidden = typeof data.flags === 'string' ? Number(/^\[(\d+) items? redacted\]$/.exec(data.flags)?.[1] ?? 0) : null;
        const count = Array.isArray(data.flags) ? data.flags.length : hidden ?? 0;
        const what = Array.isArray(data.flags) ? data.flags.map((f) => f.message).join(' ') : `${count} item${count === 1 ? '' : 's'} (details hidden by the Hub's redaction)`;
        panel({ dir: count ? 'info' : 'received', label: 'Review', text: data.acknowledged ? 'Student chose to send anyway; the flagged values were not re-reviewed.' : data.unavailable ? `Review unavailable (${data.unavailable}); the submission continues.` : count ? `${data.reviewer} flagged: ${what}` : `${data.reviewer} found nothing to flag.`, ids: { form: data.formId, run } });
      }
      break;
    case 'form_reply_sent': {
      const r = data.receipt;
      // The Hub reduces relayed receipts to their ID and status unless content is shown for debugging.
      const detail = r?.bookingId ? ` Booking ${r.bookingId}${r.room ? `: ${r.room}, ${r.date} ${r.start}–${r.end} (${r.timezone})` : ''}.` : r?.requestId ? ` Request ${r.requestId}: ${r.status}.` : '';
      panel({ dir: data.status === 'rejected' || data.status === 'conflict' ? 'error' : 'sent', label: data.duplicate ? 'Sent (stored result again)' : 'Sent', text: `${data.text}${detail}`, ids: { form: data.formId, operation: data.operationId, action: data.actionName, task: data.taskState, contextId: data.contextId, run } });
      break;
    }
    case 'form_action_result': {
      const r = data.receipt;
      const text = data.duplicate ? `Same operation ID as before — returned the stored ${data.status} result; nothing re-executed.`
        : data.status === 'accepted' ? (r?.requestId ? `Recorded request ${r.requestId} (${r.status}).` : r?.renewalId ? `Renewed loan ${r.loanId ?? ''} (${r.renewalId}).` : `Reserved demo booking ${r?.bookingId}.`)
          : data.status === 'rejected' || data.status === 'conflict' ? `${data.status}: ${errorText(data.errors)}` : `${data.actionName}: ${data.status}`;
      panel({ dir: data.status === 'rejected' || data.status === 'conflict' ? 'error' : 'sent', label: data.status === 'accepted' ? 'Accepted' : 'Result', text, values: data.status === 'accepted' && !data.duplicate ? data.values ?? undefined : undefined, ids: { form: data.formId, operation: data.operationId, run } });
      break;
    }
  }
}

// ---- connections --------------------------------------------------------

// Visualization stream only. EventSource reconnects automatically with a GET and the last event ID,
// so the server replays only what was missed; that can never start an A2A request or submit a form.
let replaying = false;
const stream = new EventSource('/api/events');
function liveView(connected) {
  setBadge(els.browserFeed, connected, connected ? 'Live view: connected' : 'Live view: reconnecting…');
  els.liveBanner.hidden = connected;
  els.liveBanner.textContent = connected ? '' : 'Live view disconnected — reconnecting. What you see is the last known state; the agents may still be working.';
  topology.liveView(connected);
}
stream.addEventListener('open', () => liveView(true));
stream.addEventListener('error', () => liveView(false));
stream.addEventListener('hello', (e) => {
  const hello = JSON.parse(e.data);
  if (bootId !== null && hello.bootId !== bootId) resetAll(); // UI server restarted: seq numbers restart too
  bootId = hello.bootId;
  replaying = !hello.resumed;
  if (replaying) formsUi.setReplaying(true); // full history follows; forms are reconstructed when it ends
  setBadge(els.hubFeed, hello.hubFeedConnected, hello.hubFeedConnected ? 'Hub telemetry: connected' : 'Hub telemetry: lost');
  topology.hubFeed(hello.hubFeedConnected);
  topology.studentCard(hello.university?.cardValid ?? null);
  renderMode(hello.agents?.tutor);
  for (const [id, a] of Object.entries(hello.agents ?? {})) {
    if (agents[id] && a?.skills) agents[id].advertised = a.skills;
    if (a?.mode) topology.agentMode(id, { mode: a.mode, model: a.model, keyConfigured: a.keyConfigured });
  }
  applyTopology(hello.topology);
  for (const id of ['tutor', 'library']) renderSkillsBox(id);
});
stream.addEventListener('truncated', (e) => topology.truncated(JSON.parse(e.data)));
stream.addEventListener('replayed', () => {
  if (replaying) formsUi.replayDone();
  replaying = false;
});
stream.addEventListener('message', (e) => {
  const event = JSON.parse(e.data);
  if (seen.has(event.seq)) return;
  seen.add(event.seq);
  handle(event, { live: !replaying });
});

// ---- tabs (WAI-ARIA tabs: arrow keys move between them) ---------------------------------
// Each tab is a link with its own address (/conversation, /activity, /topology), so it can be opened in
// its own browser tab and bookmarked. The plain address / always opens Conversation.
const tabs = [...document.querySelectorAll('[role="tab"]')];
const tabForPath = (path) => tabs.find((t) => t.getAttribute('href') === path) ?? tabs[0];
function showTab(tab, { focus = false, history: how = null } = {}) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (tab.id === 'tab-topology') els.tabPulse.dataset.on = 'false';
  if (tab.id === 'tab-professor') classroom.professorShown();
  if (focus) tab.focus();
  const path = tab.getAttribute('href');
  if (how && location.pathname !== path) window.history[how === 'push' ? 'pushState' : 'replaceState'](null, '', path);
}
for (const t of tabs) {
  t.addEventListener('click', (e) => {
    // Cmd/Ctrl/Shift/middle-click: let the browser open the link in a new tab or window.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    showTab(t, { history: 'push' });
  });
  t.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(t);
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : null;
    if (next) {
      e.preventDefault();
      showTab(next, { focus: true, history: 'replace' });
    }
  });
}
showTab(tabForPath(location.pathname));
window.addEventListener('popstate', () => showTab(tabForPath(location.pathname))); // Back / Forward

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
    renderState();
    return true;
  } catch (err) {
    awaitingRunId = null;
    els.formError.textContent = `Could not start request: ${err.message}`;
    renderState();
    return false;
  }
}

// Enter sends; Shift+Enter starts a new line. Enter that confirms an input-method composition
// (e.g. accented or CJK text) is left alone.
els.message.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  els.form.requestSubmit();
});
els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.message.value;
  if (els.send.disabled || !text.trim()) return;
  els.message.value = ''; // cleared on send…
  chatFollow.pin(); // your own message: always show the newest part of the conversation
  const started = await startRun('/api/runs', { text, contextId: currentContextId, ...classroom.composerContext() });
  if (!started && !els.message.value) els.message.value = text; // …and given back if the request never started
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

// ---- Part 8: Generated UI inspector ---------------------------------------------------------------
// One entry per Library loan reply. Three separate sections: what the MODEL produced, what the
// APPLICATION's validation decided, and what the BACKEND (loan service) holds and did. Built only from
// the Library's real telemetry; no hidden reasoning, prompts or keys are shown.
const inspections = new Map(); // formId or runId → { results }
const pre = (value) => el('pre', { className: 'inspector-json', textContent: JSON.stringify(value, null, 2) });
const section = (title, ...children) => el('section', { className: 'inspector-part' }, el('h4', { textContent: title }), ...children);
function inspectorEvent(type, data, runId, at) {
  if (type !== 'ui_generated') {
    const entry = inspections.get(data.formId);
    if (!entry) return;
    const line = type === 'loan_operation'
      ? `${clock(at)} — loan service ${data.ok ? 'renewed' : 'refused'} ${data.loanId} (${data.code}${data.duplicate ? ', stored outcome' : ''})`
      : `${clock(at)} — form result: ${data.status}${data.receipt?.renewalId ? ` (${data.receipt.renewalId})` : ''}${data.duplicate ? ' (duplicate operation, nothing re-executed)' : ''}`;
    entry.results.append(el('li', { textContent: line }));
    return;
  }
  const i = data.inspector ?? {};
  const s = i.surface;
  const decision = el('span', { className: 'inspector-kind', dataset: { kind: data.fallback ? 'fallback' : data.kind }, textContent: i.decision ?? data.kind });
  const results = el('ol', { className: 'inspector-results' });
  const rows = (pairs) => {
    const d = el('dl', { className: 'kv' });
    for (const [k, v] of pairs) if (v !== undefined && v !== null && v !== '') d.append(el('dt', { textContent: k }), el('dd', { textContent: String(v) }));
    return d;
  };
  const attempts = el('ol', { className: 'inspector-attempts' }, ...(i.validation ?? []).map((a) => el('li', { dataset: { ok: String(a.ok) } },
    el('span', { textContent: `Attempt ${a.attempt} (${a.kind ?? 'invalid'}): ${a.ok ? 'passed' : 'rejected'}` }),
    ...(a.ok ? [] : [el('ul', {}, ...a.errors.map((e) => el('li', { textContent: e })))]))));
  const facts = el('table', { className: 'inspector-facts' },
    el('thead', {}, el('tr', {}, ...['Loan', 'Due', 'Renewable', 'Permitted return dates', 'Version', 'Source'].map((h) => el('th', { textContent: h })))),
    el('tbody', {}, ...(i.authoritative ?? []).map((l) => el('tr', { className: i.loanIds?.includes(l.loanId) ? 'is-subject' : '' },
      el('td', { textContent: l.loanId }), el('td', { textContent: l.dueDate }), el('td', { textContent: l.eligible ? 'yes' : `no (${l.code})` }),
      el('td', { textContent: l.permittedReturnDates ? `${l.permittedReturnDates.earliest} → ${l.permittedReturnDates.latest}` : '—' }),
      el('td', { textContent: l.version }), el('td', { textContent: l.source })))));
  const item = el('li', { className: 'inspector-entry' }, el('details', { open: true },
    el('summary', {}, el('time', { textContent: clock(at) }), decision, el('span', { textContent: s ? `surface ${s.formId} · revision ${s.revision}` : 'no surface (text reply)' })),
    el('div', { className: 'inspector-grid' },
      section('Model output', rows([['decision', i.decision], ['model', data.model], ['tokens', data.usage ? `${data.usage.inputTokens} in / ${data.usage.outputTokens} out` : null], ['about loans', i.loanIds?.join(', ')]]), pre(i.modelOutput ?? {})),
      section('Application validation', rows([['catalog', i.catalog?.catalogId], ['A2UI version', i.catalog?.version], ['renderer', i.catalog?.renderer]]), attempts,
        rows(s ? [['surface', s.formId], ['revision', s.revision], ['replaces', s.supersedes], ['issuing agent', s.issuer], ['Library task', s.taskId], ['Library context', s.contextId], ['renew actions bound to', Object.entries(s.renewable ?? {}).map(([k, v]) => `${k} @ v${v}`).join(', ') || 'none']] : [['surface', 'none — replied in text']])),
      section('Backend (loan service)', el('p', { className: 'hint', textContent: 'Due dates, eligibility and permitted dates come only from here. Highlighted rows are the loans this reply is about.' }), facts,
        el('h4', { textContent: 'Results' }), results))));
  if (s?.formId) inspections.set(s.formId, { results });
  els.inspectorLog.prepend(item);
  while (els.inspectorLog.children.length > 20) els.inspectorLog.lastChild.remove();
}
