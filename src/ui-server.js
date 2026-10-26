// UI backend. Hosts the Student Agent and serves the browser page that visualizes the exchange.
//
// Part 7: the Student connects ONLY to its university — the "California State University Fullerton"
// Hub. It discovers the Hub's public card, sends every chat message and form action to the Hub over
// A2A, and never learns specialist endpoints. The Hub routes, forwards to the Tutor or Library and
// relays their replies.
//
// The Student's own model (src/student-assistant.js, STUDENT_MODE): before sending, it picks which of
// the university's public capabilities a non-obvious question needs, or asks the student a clarifying
// question first. It only names a capability ID from the Hub's card; the Hub owns the destinations.
//
// Keep these distinct:
//   * A2A:           Student → Hub JSON-RPC (questions, form actions). All agent messages.
//   * A2UI:          forms a specialist decided to send, relayed inside A2A by the Hub, rendered here.
//   * Telemetry:     Hub /viz/events (its own events plus the specialists' feeds, redacted by the Hub)
//                    → this server → browser /api/events (SSE). Reports real events only; each is
//                    labelled for the topology graph (src/topology.js). Never carries agent messages.
//   * Settings:      local developer controls proxied through the Hub's /dev endpoints (HTTP, not A2A).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { askTutor, sendFormAction } from './student-agent.js';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { A2UI_VERSION, WORKFLOWS, checkAction, validateBookingCriteria, validateFinal } from './forms.js';
import { loadStudentConfig } from './config.js';
import { getCard, validateCard } from './cards.js';
import { topologyLabel } from './topology.js';
import { apiHost, keyEnvName, useModel } from './llm.js';
import { planRequest, studentAssistantStatus } from './student-assistant.js';

const HOST = '127.0.0.1';
const MAX_TEXT_LENGTH = 2000;
const MAX_HISTORY = Number(process.env.UI_HISTORY_LIMIT ?? 1000); // bounded; older events are dropped with a notice
const FEED_RETRY_MS = 1000;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const SHARED_FORM_MODULE = fileURLToPath(new URL('./forms.js', import.meta.url));
const ACTION_KEYS = ['name', 'surfaceId', 'sourceComponentId', 'timestamp', 'context'];
const CONTEXT_ID_PATTERN = /^[\w-]{8,100}$/;
const CONFIG_EVENTS = new Set(['skills_saved', 'card_notification', 'hub_registration']); // specialist events not tied to a run
const EPHEMERAL = new Set(['heartbeat']); // shown live (if the viewer wants them) but not kept in history

// Allowed forward transitions per run kind. Late events can never move a run backwards.
const NEXT_STATES = {
  chat: {
    sending: ['waiting', 'completed', 'failed', 'uncertain'],
    waiting: ['completed', 'failed', 'uncertain'],
    // A timeout leaves the outcome unknown; "check for answer" re-sends the same request ID.
    uncertain: ['sending'],
    completed: [],
    failed: [],
  },
  // One A2A request carrying a form action (lookup, review, submit, confirm, cancel).
  form_action: {
    sending: ['completed', 'failed', 'uncertain'],
    completed: [],
    failed: [],
    uncertain: [],
  },
};

// A form's lifecycle in the Student view, separate from the A2A runs that act on it.
// editing → submitting → accepted | rejected | confirmation_pending;  editing → cancelled | superseded
// rejected → editing (explicit "Edit and retry");  confirmation_pending → submitting (reconcile, same operation ID)
const CLOSED_FORM_STATES = new Set(['accepted', 'cancelled', 'superseded']);

export async function startUiServer({ port = 3000 } = {}) {
  const cfg = loadStudentConfig(); // throws a clear error on invalid configuration
  useModel(cfg.model); // the Student's own model and key variable (used only when STUDENT_MODE=live)
  const hub = { name: cfg.university.name, baseUrl: cfg.university.hubUrl, cardUrl: cfg.university.cardUrl, rpcUrl: `${cfg.university.hubUrl}/a2a/jsonrpc`, vizUrl: `${cfg.university.hubUrl}/viz/events`, devUrl: `${cfg.university.hubUrl}/dev` };
  const identity = { studentId: cfg.agentId };
  const bootId = randomUUID();
  const history = []; // every published event, replayed to (re)connecting browsers
  let dropped = 0; // events that fell out of the bounded history
  const clients = new Set();
  const runs = new Map(); // runId → { kind, state, ... }
  const forms = new Map(); // formId → { workflowId, agentId, conversationId, contextId, taskId, formRef, state, … }
  let activeRunId = null; // a chat run or form request in flight (one at a time)
  let seq = 0;

  // Telemetry state shown on (re)connect: Hub feed, the Hub's topology snapshot, specialist modes.
  const feeds = { hub: { connected: false } };
  const agentStatus = {}; // agentId → the specialist's own status (mode, skills), relayed by the Hub
  let topology = null;
  let hubCard = null; // the validated public card of the university Hub
  let capabilities = []; // its public capability skills (validated view): { id, name, description, tags, examples }
  // Per conversation (Student↔Hub contextId): recent turns for the Student's planner, and a question
  // held back while the student answers our clarifying question.
  const conversations = new Map(); // contextId → { turns: [{ question, capability, answer }], pending: { original } | null }
  const conversationFor = (contextId) => {
    if (!conversations.has(contextId)) conversations.set(contextId, { turns: [], pending: null });
    return conversations.get(contextId);
  };
  let hubCardError = null;

  function publish(event) {
    seq += 1;
    const stamped = { seq, id: `${bootId}:${seq}`, at: new Date().toISOString(), ...event };
    const topo = topologyLabel(stamped);
    if (topo) stamped.topo = topo;
    if (!EPHEMERAL.has(event.type)) {
      history.push(stamped);
      if (history.length > MAX_HISTORY) {
        history.shift();
        dropped += 1;
      }
    }
    for (const res of clients) writeEvent(res, stamped);
  }

  function setState(runId, state, data = {}) {
    const run = runs.get(runId);
    if (!run || !NEXT_STATES[run.kind][run.state]?.includes(state)) return false;
    run.state = state;
    publish({ source: 'system', type: 'state', runId, data: { state, ...data } });
    return true;
  }

  // Discover and validate the Hub's PUBLIC card (the Student's only destination).
  async function discoverHub(reason) {
    try {
      const res = await getCard(hub.cardUrl, null);
      if (res.status !== 200) throw new Error(`HTTP ${res.status} from the university card URL`);
      const card = JSON.parse(res.body);
      const checked = validateCard(card, { expectedName: hub.name, rpcUrl: hub.rpcUrl });
      if (!checked.ok) throw new Error(checked.error);
      hubCard = card;
      capabilities = checked.view.skills;
      hubCardError = null;
      publish({ source: 'student', type: 'card_discovered', runId: null, data: { name: card.name, url: hub.rpcUrl, skills: checked.view.skills.map((s) => s.id), reason } });
    } catch (err) {
      hubCardError = err.code === 'ECONNREFUSED' ? 'University Hub offline (connection refused)' : err.message;
      publish({ source: 'student', type: 'hub_card_failed', runId: null, data: { error: hubCardError, reason } });
    }
    return hubCard;
  }

  function setFeedConnected(connected) {
    if (feeds.hub.connected === connected) return;
    feeds.hub.connected = connected;
    publish({ source: 'system', type: 'hub_feed', runId: null, data: { connected } });
    if (connected) discoverHub('reconnect'); // the Hub may have restarted
  }

  // Follow the Hub's telemetry feed (its events plus the specialists' redacted feeds).
  const feedAbort = new AbortController();
  (async function followFeed() {
    while (!feedAbort.signal.aborted) {
      try {
        const res = await fetch(hub.vizUrl, { signal: feedAbort.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setFeedConnected(true);
        let buffer = '';
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (data) relayEvent(JSON.parse(data.slice(6)));
          }
        }
      } catch {
        // Hub not running or connection dropped; reported through hub_feed below.
      }
      setFeedConnected(false);
      if (!feedAbort.signal.aborted) await new Promise((r) => setTimeout(r, FEED_RETRY_MS));
    }
  })();

  function relayEvent(event) {
    const { source, type } = event;
    if (source === 'hub' && type === 'status') {
      topology = event.data;
      publish({ source: 'system', type: 'topology', runId: null, data: topology });
      return;
    }
    if (type === 'status') {
      // A specialist's mode, whether a key is present (boolean), current skills.
      agentStatus[source] = event.data;
      publish({ source: 'system', type: 'agent_status', runId: null, data: { agentId: source, ...event.data } });
      return;
    }
    if (event.runId == null) {
      // Hub configuration/registry events, and specialists' configuration events.
      if (source === 'hub' || CONFIG_EVENTS.has(type)) publish({ source, type, runId: null, data: event.data, at: event.at });
      return;
    }
    if (!runs.has(event.runId)) return; // only runs started from this UI
    // Keep the agent's own timestamp: it records when the agent observed the event.
    publish({ source, type, runId: event.runId, data: event.data, at: event.at });
    if (source === 'hub' && type === 'message_received') setState(event.runId, 'waiting');
  }

  const startRun = (kind, state) => {
    const runId = randomUUID();
    runs.set(runId, { kind, state });
    return runId;
  };

  // Both guards need the real port (tests listen on port 0), so they're set in the listen callback.
  let guardHost;
  let guardOrigin;

  const app = express();
  app.use((req, res, next) => guardHost(req, res, next));
  app.use(express.json({ limit: '64kb' }));
  app.get('/shared/forms.js', (req, res) => res.type('text/javascript').sendFile(SHARED_FORM_MODULE));
  // Each tab has its own address; the page picks the tab from the path. Only these three exist.
  app.get(['/conversation', '/activity', '/topology'], (req, res) => res.sendFile('index.html', { root: PUBLIC_DIR }));
  app.use(express.static(PUBLIC_DIR));

  agentStatus.student = studentAssistantStatus(); // the Student's own model (mode, model, key present)
  publish({ source: 'system', type: 'agent_status', runId: null, data: { agentId: 'student', ...agentStatus.student } });
  const statusBody = () => ({
    student: { agentId: cfg.agentId, displayName: cfg.displayName, relationship: cfg.university.relationship },
    university: { name: hub.name, cardUrl: hub.cardUrl, cardValid: Boolean(hubCard), cardError: hubCardError, capabilities: capabilities.map((c) => ({ id: c.id, name: c.name })) },
    hubFeedConnected: feeds.hub.connected, activeRunId, topology, agents: agentStatus,
    tutorStatus: agentStatus.tutor ?? null,
  });
  app.get('/api/status', (req, res) => res.json(statusBody()));

  const apiPost = express.Router();
  apiPost.use((req, res, next) => guardOrigin(req, res, next));

  // Send one chat request over A2A to the Hub. `run` holds the conversation's A2A contextId and the
  // request ID (messageId); a reconcile re-sends the same ones.
  async function sendChat(runId, run) {
    activeRunId = runId;
    const card = hubCard ?? (await discoverHub('send'));
    if (!card) {
      publish({ source: 'student', type: 'request_failed', runId, data: { error: `${hub.name} is not reachable (${hubCardError}), so nothing was sent.`, outcome: 'not_delivered' } });
      setState(runId, 'failed');
      activeRunId = null;
      return;
    }
    askTutor(hub.baseUrl, run.text, {
      runId, card, contextId: run.contextId, messageId: run.messageId, timeoutMs: cfg.timeouts.chatMs,
      metadata: { ...identity, ...(run.requestedCapability ? { requestedCapability: run.requestedCapability } : {}) },
      onEvent: (type, data) => {
        // A relayed form: register it (issuer, workflow, conversation, Hub reference) before showing it.
        const extra = type === 'form_received' ? registerForm(data, { conversationId: run.contextId, runId }) : {};
        publish({ source: 'student', type, runId, data: { ...data, ...(type === 'form_received' ? { agentId: data.issuer } : {}), ...extra } });
      },
    })
      .then((reply) => {
        const conv = conversationFor(run.contextId);
        conv.turns = [...conv.turns, { question: run.text, capability: reply?.hub?.destination ?? null, answer: String(reply?.text ?? '').slice(0, 300) }].slice(-6);
        setState(runId, 'completed', { servedBy: reply?.servedBy ?? null, decision: reply?.hub?.decision ?? null });
      })
      .catch((err) => setState(runId, err.outcome === 'uncertain' ? 'uncertain' : 'failed', err.tutorError ? { tutorError: err.tutorError.code } : {}))
      .finally(() => {
        if (activeRunId === runId) activeRunId = null;
      });
  }

  // The Student's own step before sending: pick a capability for a non-obvious question, or ask the
  // student to clarify (then nothing is sent until they answer).
  async function planAndSend(runId, run) {
    activeRunId = runId;
    const conv = conversationFor(run.contextId);
    if (hubCard || (await discoverHub('send'))) {
      const last = conv.turns.at(-1);
      const plan = await planRequest({
        question: run.text, capabilities, recentTurns: conv.turns, clarifiedAlready: run.clarified, clarificationAnswer: run.clarified ? run.typed : '',
        followsQuestion: Boolean(last && /\?\s*$/.test(last.answer ?? '')),
        onModelEvent: (type, data) => publish({ source: 'student', type, runId, data }),
      });
      const name = capabilities.find((c) => c.id === plan.capability)?.name ?? null;
      publish({ source: 'student', type: 'request_planned', runId, data: { action: plan.action, capability: plan.capability, capabilityName: name, by: plan.by, reason: plan.reason, matched: plan.matched?.map((m) => ({ id: m.id, terms: m.terms })) ?? [], model: plan.model ?? null, usage: plan.usage ?? null, error: plan.error ?? null } });
      if (plan.action === 'clarify') {
        conv.pending = { original: run.text };
        publish({ source: 'student', type: 'clarification_asked', runId, data: { question: run.text, text: plan.clarificationQuestion, contextId: run.contextId } });
        setState(runId, 'completed', { decision: 'student_clarify' });
        activeRunId = null;
        return;
      }
      if (plan.action === 'decline') {
        // Clearly not a university service: the Student answers itself and nothing is sent.
        const offered = capabilities.map((c) => c.name ?? c.id).join(' and ');
        const text = `${plan.reason}${offered ? ` The university can help with: ${offered}.` : ''}`;
        conv.turns = [...conv.turns, { question: run.text, capability: null, answer: text.slice(0, 300) }].slice(-6);
        publish({ source: 'student', type: 'request_declined', runId, data: { question: run.text, text, contextId: run.contextId } });
        setState(runId, 'completed', { decision: 'student_decline' });
        activeRunId = null;
        return;
      }
      run.requestedCapability = plan.capability;
    }
    sendChat(runId, run);
  }

  // ---- Part 6: forms the agents decided to send --------------------------------------------

  function setLifecycle(formId, state, extra = {}) {
    const form = forms.get(formId);
    form.state = state;
    publish({ source: 'system', type: 'form_lifecycle', runId: extra.runId ?? null, data: { formId, workflowId: form.workflowId, agentId: form.agentId, state, ...extra } });
  }

  // Returns { lifecycle } for the form_received event: 'editing' to render it, anything else to not.
  function registerForm(data, { conversationId, runId }) {
    const agentId = data.issuer;
    const workflow = WORKFLOWS[data.workflowId];
    // Form-origin check: a service may only issue its own workflows, and a relayed form needs the Hub's reference.
    if (!workflow || workflow.agentId !== agentId) return { lifecycle: 'refused', refusedReason: `${agentId} can’t issue the “${data.workflowId}” workflow.` };
    if (!data.formRef) return { lifecycle: 'refused', refusedReason: 'The form has no university reference, so its actions could not be routed.' };
    const known = forms.get(data.formId);
    if (known) return { lifecycle: known.state, repeat: true }; // the same form re-sent (retry): never a second copy
    const record = {
      formId: data.formId, workflowId: data.workflowId, agentId, conversationId, contextId: data.contextId, taskId: data.taskId, formRef: data.formRef,
      formVersion: data.formVersion, a2uiMessages: data.a2uiMessages, updates: [], state: 'editing', inFlight: false,
      lastOperation: null, lastSubmitted: null, issuedRunId: runId,
    };
    // Explicit replacement: the old form is superseded (its editable UI is removed, records kept).
    const replaced = data.supersedes && forms.get(data.supersedes);
    forms.set(record.formId, record);
    if (replaced && replaced.agentId === agentId && replaced.conversationId === conversationId && !CLOSED_FORM_STATES.has(replaced.state) && !replaced.inFlight) {
      setLifecycle(replaced.formId, 'superseded', { runId, by: record.formId });
    }
    // Never stack two editable forms of one workflow in one conversation (the agent asks first; this is a backstop).
    const other = [...forms.values()].find((f) => f !== record && f.workflowId === record.workflowId && f.conversationId === conversationId && f.state === 'editing');
    if (other) {
      record.state = 'superseded';
      return { lifecycle: 'superseded', duplicateOf: other.formId };
    }
    return { lifecycle: 'editing' };
  }

  // Send one action of a form to its issuing agent (never re-routed). `final`: submit/confirm.
  function runAction(form, { operationId, action, spec, acknowledgeReview = false }) {
    const runId = startRun('form_action', 'sending');
    form.inFlight = true;
    publish({ source: 'system', type: 'run_started', runId, data: { kind: 'form_action', formId: form.formId, workflowId: form.workflowId, actionName: action.name, operationId, agentId: form.agentId } });
    publish({ source: 'system', type: 'state', runId, data: { state: 'sending' } });
    // Always to the Hub, with its opaque form reference; the Hub forwards to the issuing specialist.
    sendFormAction(hub.baseUrl, {
      form, action, operationId, runId, acknowledgeReview, card: hubCard ?? undefined, metadata: identity, timeoutMs: cfg.timeouts.formActionMs,
      onEvent: (type, data) => publish({ source: 'student', type, runId, data: { ...data, agentId: form.agentId, workflowId: form.workflowId } }),
    })
      .then((result) => {
        form.updates.push(...result.a2uiUpdate.filter((m) => !m.deleteSurface));
        setState(runId, 'completed');
        const status = result.body?.status;
        if (spec.final) {
          if (status === 'accepted') setLifecycle(form.formId, 'accepted', { runId, receipt: result.body.receipt, duplicate: result.duplicate });
          // The agent's review flagged something: back to the student with the values and the flags.
          else if (status === 'needs_review') setLifecycle(form.formId, 'editing', { runId, restored: true, review: true, flags: result.body.flags ?? [], values: form.lastSubmitted });
          else {
            form.lastConflict = status === 'conflict';
            setLifecycle(form.formId, 'rejected', { runId, errors: result.body?.errors ?? { _form: 'Not accepted.' }, conflict: status === 'conflict' });
          }
        } else if (spec.cancel && status !== 'cancelled') {
          publish({ source: 'system', type: 'form_note', runId, data: { formId: form.formId, text: `The agent didn’t confirm the cancellation: ${JSON.stringify(result.body?.errors ?? {})}` } });
        }
      })
      .catch((err) => {
        setState(runId, err.outcome === 'uncertain' ? 'uncertain' : 'failed');
        if (!spec.final) return; // lookups/review/cancel: the browser shows the failure; nothing to reconcile
        // Possibly accepted: never offer a blind resubmission — only a reconcile with the same operation ID.
        if (err.outcome === 'uncertain') setLifecycle(form.formId, 'confirmation_pending', { runId, operationId });
        else setLifecycle(form.formId, 'rejected', { runId, notDelivered: true, errors: { _form: /task not found/i.test(err.message) ? 'The university no longer knows this form (records are in memory, so a restart clears them).' : `Not delivered: ${err.message}` } });
      })
      .finally(() => {
        form.inFlight = false;
      });
    return runId;
  }

  apiPost.post('/forms/:formId/actions', (req, res) => {
    const form = forms.get(req.params.formId);
    if (!form) return res.status(404).json({ error: 'Unknown form.' });
    const { operationId, action, acknowledgeReview = false } = req.body ?? {};
    if (Object.keys(req.body ?? {}).some((k) => !['operationId', 'action', 'acknowledgeReview'].includes(k))) return res.status(400).json({ errors: { _form: 'Unexpected request fields.' } });
    if (typeof acknowledgeReview !== 'boolean') return res.status(400).json({ errors: { _form: 'acknowledgeReview must be true or false.' } });
    if (typeof operationId !== 'string' || !/^[\w-]{8,100}$/.test(operationId)) return res.status(400).json({ errors: { _form: 'Missing or malformed operation ID.' } });
    if (!action || typeof action !== 'object' || Object.keys(action).some((k) => !ACTION_KEYS.includes(k))) return res.status(400).json({ errors: { _form: 'Unexpected action fields.' } });
    const checked = checkAction({ version: A2UI_VERSION, action }, { workflowId: form.workflowId, surfaceId: form.formId });
    if (!checked.ok) return res.status(400).json({ errors: { _form: checked.error } });
    if (form.inFlight) return res.status(409).json({ error: 'This form already has a request in progress.' });
    if (form.state === 'confirmation_pending') return res.status(409).json({ error: 'The outcome of the last submission is unknown. Use “Check status” first; nothing is resent automatically.' });
    if (form.state !== 'editing') return res.status(409).json({ error: `This form is ${form.state}.` });
    const { spec } = checked;
    // Same rules the issuing agent applies; invalid data is never sent over A2A.
    if (spec.final || checked.name === 'reviewBooking') {
      const v = validateFinal(form.workflowId, checked.context);
      if (!v.ok) return res.status(400).json({ errors: v.errors });
    } else if (checked.name === 'checkAvailability') {
      const v = validateBookingCriteria(checked.context);
      if (!v.ok) return res.status(400).json({ errors: v.errors });
    }
    if (spec.cancel) setLifecycle(form.formId, 'cancelled');
    if (spec.final) {
      form.lastOperation = { operationId, action, spec, acknowledgeReview }; // a reconcile resends exactly this
      form.lastSubmitted = checked.context; // for explicit recovery only
      // `submitted` lets the chat show what was sent (also after a reload); the agents' panels already show these values.
      setLifecycle(form.formId, 'submitting', { operationId, submitted: checked.context });
    }
    const runId = runAction(form, { operationId, action, spec, acknowledgeReview: spec.final && acknowledgeReview });
    res.status(202).json({ runId, operationId });
  });

  // After a known rejection or failure: explicitly reopen the form with the saved values.
  apiPost.post('/forms/:formId/edit', (req, res) => {
    const form = forms.get(req.params.formId);
    if (!form) return res.status(404).json({ error: 'Unknown form.' });
    if (form.state !== 'rejected') return res.status(409).json({ error: `Nothing to edit: the form is ${form.state}.` });
    // The values that were sent come back with the reopened form (a taken slot must be chosen again).
    const values = form.lastSubmitted && form.lastConflict ? { ...form.lastSubmitted, slot: [] } : form.lastSubmitted;
    setLifecycle(form.formId, 'editing', { restored: true, values });
    res.json({ formId: form.formId, a2uiMessages: form.a2uiMessages, updates: form.updates, values });
  });

  // After an unknown outcome: ask the issuing agent again with the SAME operation ID. It returns the
  // stored result if it already processed it, or processes it once now. Never a new operation.
  apiPost.post('/forms/:formId/reconcile', (req, res) => {
    const form = forms.get(req.params.formId);
    if (!form) return res.status(404).json({ error: 'Unknown form.' });
    if (form.state !== 'confirmation_pending' || !form.lastOperation) return res.status(409).json({ error: `Nothing to reconcile: the form is ${form.state}.` });
    if (form.inFlight) return res.status(409).json({ error: 'A check is already in progress.' });
    setLifecycle(form.formId, 'submitting', { operationId: form.lastOperation.operationId, reconcile: true });
    const runId = runAction(form, form.lastOperation);
    res.status(202).json({ runId, operationId: form.lastOperation.operationId });
  });

  // Chat run. Only POSTs start A2A requests; reconnecting browsers use GET /api/events.
  apiPost.post('/runs', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Message text is required.' });
    if (text.length > MAX_TEXT_LENGTH) return res.status(400).json({ error: `Message exceeds ${MAX_TEXT_LENGTH} characters.` });
    const requestedContext = req.body?.contextId;
    if (requestedContext !== undefined && requestedContext !== null && (typeof requestedContext !== 'string' || !CONTEXT_ID_PATTERN.test(requestedContext))) {
      return res.status(400).json({ error: 'Malformed contextId.' });
    }
    if (activeRunId) return res.status(409).json({ error: 'A request is already in progress.', activeRunId });

    // contextId names the student's conversation: it is the Student↔Hub A2A contextId. The Hub keeps
    // separate downstream contexts per specialist under it.
    const run = { kind: 'chat', state: 'sending', text, typed: text, contextId: requestedContext ?? randomUUID(), messageId: randomUUID(), clarified: false };
    // Answering the Student's own clarifying question: send the held-back question together with it.
    const conv = requestedContext ? conversations.get(requestedContext) : null;
    if (conv?.pending) {
      run.text = `${conv.pending.original}\n${text}`.slice(0, MAX_TEXT_LENGTH);
      run.clarified = true;
      conv.pending = null;
    }
    const runId = randomUUID();
    runs.set(runId, run);
    publish({ source: 'system', type: 'run_started', runId, data: { kind: 'chat', text, contextId: run.contextId, newConversation: !requestedContext, messageId: run.messageId, routerMode: topology?.hub?.router?.mode ?? null, studentMode: agentStatus.student.mode, clarifies: run.clarified } });
    publish({ source: 'system', type: 'state', runId, data: { state: run.state } });
    res.status(202).json({ runId, contextId: run.contextId });
    planAndSend(runId, run);
  });

  // "New conversation": a visualization-only marker. Browsers clear their panels when they see it,
  // including on replay after a reload. No A2A traffic; the next chat simply gets a new contextId.
  apiPost.post('/conversation/new', (req, res) => {
    const busy = [...forms.values()].some((f) => f.inFlight || f.state === 'submitting');
    if (activeRunId || busy) return res.status(409).json({ error: 'Wait for the current request to finish.' });
    // Open forms of the old conversation are closed (UI only — no handler is called, records are kept).
    for (const f of forms.values()) if (f.state === 'editing' || f.state === 'rejected') setLifecycle(f.formId, 'cancelled', { reason: 'new_conversation' });
    publish({ source: 'system', type: 'conversation_reset', runId: null, data: {} });
    res.status(202).json({});
  });

  // After an uncertain outcome: ask the Hub again for the result of the same request (same request ID).
  // The Hub returns its stored or in-flight result — no second routing decision or dispatch.
  apiPost.post('/runs/:runId/reconcile', (req, res) => {
    const run = runs.get(req.params.runId);
    if (!run || run.kind !== 'chat') return res.status(404).json({ error: 'Unknown chat run.' });
    if (run.state !== 'uncertain') return res.status(409).json({ error: `Nothing to reconcile: the run is ${run.state}.` });
    if (activeRunId) return res.status(409).json({ error: 'A request is already in progress.', activeRunId });
    setState(req.params.runId, 'sending', { reconcile: true, messageId: run.messageId });
    res.status(202).json({ runId: req.params.runId, messageId: run.messageId });
    sendChat(req.params.runId, run);
  });

  // Manual "Refresh skills": the Hub re-fetches specialist cards; the Student re-reads the Hub's card.
  apiPost.post('/registry/refresh', async (req, res) => {
    discoverHub('manual');
    try {
      await fetch(`${hub.devUrl}/registry/refresh`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      res.status(202).json({});
    } catch {
      res.status(502).json({ error: `${hub.name} is not reachable.` });
    }
  });

  // Skill settings: local developer controls, proxied through the Hub to the specialist's own settings
  // API. The Hub picks the destination from its configuration; the browser can't choose a URL.
  async function proxySettings(req, res, path, method) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(req.params.agentId)) return res.status(404).json({ error: 'Unknown agent.' });
    try {
      const upstream = await fetch(`${hub.devUrl}/agents/${req.params.agentId}/skills${path}`, {
        method,
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(6000),
      });
      res.status(upstream.status).json(await upstream.json());
    } catch {
      res.status(502).json({ error: `${hub.name} is not reachable, so settings can’t be read or saved.` });
    }
  }
  app.get('/api/agents/:agentId/skills', (req, res) => proxySettings(req, res, '', 'GET'));
  apiPost.post('/agents/:agentId/skills/preview', (req, res) => proxySettings(req, res, '/preview', 'POST'));
  apiPost.put('/agents/:agentId/skills', (req, res) => proxySettings(req, res, '', 'PUT'));

  app.use('/api', apiPost);

  // Event IDs are "<bootId>:<seq>". A reconnecting browser sends Last-Event-ID (or ?after=) and gets only
  // what it missed; a different bootId (server restarted) or a cursor older than the kept history gets
  // a full replay plus a truncation notice. The browser also dedupes by seq.
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const cursor = String(req.headers['last-event-id'] ?? req.query.after ?? '');
    const [cursorBoot, cursorSeq] = cursor.split(':');
    const after = cursorBoot === bootId && Number.isInteger(Number(cursorSeq)) ? Number(cursorSeq) : null;
    const oldest = history[0]?.seq ?? seq + 1;
    const resumed = after !== null && after >= oldest - 1;
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId, resumed, ...statusBody() })}\n\n`);
    if (!resumed && dropped > 0) res.write(`event: truncated\ndata: ${JSON.stringify({ missed: dropped, kept: history.length })}\n\n`);
    if (after !== null && !resumed) res.write(`event: truncated\ndata: ${JSON.stringify({ missed: oldest - after - 1, kept: history.length })}\n\n`);
    for (const event of history) if (!resumed || event.seq > after) writeEvent(res, event);
    // End of replay: the browser now reconstructs each form's CURRENT lifecycle state (rendering only
    // forms that are still editable) instead of re-rendering old form-creation events one by one.
    res.write(`event: replayed\ndata: {}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // Startup: discover the university's public card (retried on send and when the Hub feed reconnects).
  discoverHub('startup');

  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      guardHost = hostGuard(actualPort);
      guardOrigin = sameOriginGuard(actualPort);
      const baseUrl = `http://${HOST}:${actualPort}`;
      const close = () => {
        feedAbort.abort();
        for (const res of clients) res.end();
        return new Promise((r) => server.close(r));
      };
      resolve({ server, baseUrl, close, hubUrl: hub.baseUrl, universityName: hub.name });
    });
    server.on('error', reject);
  });
}

function writeEvent(res, event) {
  res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.UI_PORT === undefined ? 3000 : Number(process.env.UI_PORT);
  process.env.STUDENT_LOG_CONTENT ??= '0'; // keep chat text out of this server's logs by default
  const { baseUrl, hubUrl, universityName } = await startUiServer({ port });
  console.log(`[UI] listening on ${baseUrl}`);
  console.log(`[UI] Student Agent connects only to ${universityName} at ${hubUrl}`);
  const s = studentAssistantStatus();
  console.log(`[UI] Student model: ${s.mode}${s.model ? ` (${s.model})` : ''}${s.mode === 'live' ? `, API key (${keyEnvName()}): ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}`);
}
