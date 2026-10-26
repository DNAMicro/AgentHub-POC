// UI backend. Hosts the Student Agent (its A2A client, router, trusted registry, and A2A
// receiving endpoint) and serves a browser page that visualizes the exchange.
//
// Keep these distinct:
//   * A2A:           Student → Tutor/Library JSON-RPC (questions, form actions), and Tutor/Library →
//                    Student's endpoint (agent_card_changed notifications). All agent messages.
//   * Routing:       this application's choice of service (src/router.js), not an A2A feature.
//   * A2UI:          a form an agent decides to send inside A2A (Part 6: only in reply to a chat
//                    request — there is no "request form" shortcut), rendered by the browser.
//   * Visualization: agents' /viz/events → this server → browser /api/events (SSE). Reports real
//                    events and delivers received A2UI payloads; never carries agent messages.
//   * Settings:      local developer controls proxied to each agent's /settings/skills (HTTP, not A2A).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { askTutor, sendFormAction } from './student-agent.js';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { A2UI_VERSION, WORKFLOWS, checkAction, validateBookingCriteria, validateFinal } from './forms.js';
import { createRegistry, trustedPeers } from './student-registry.js';
import { ROUTER_MODE, decideRoute, routerStatus } from './router.js';
import { startStudentEndpoint } from './student-endpoint.js';

const HOST = '127.0.0.1';
const MAX_TEXT_LENGTH = 2000;
const MAX_HISTORY = 1000;
const FEED_RETRY_MS = 1000;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const SHARED_FORM_MODULE = fileURLToPath(new URL('./forms.js', import.meta.url));
const ACTION_KEYS = ['name', 'surfaceId', 'sourceComponentId', 'timestamp', 'context'];
const CONTEXT_ID_PATTERN = /^[\w-]{8,100}$/;
const CONFIG_EVENTS = new Set(['skills_saved', 'card_notification']); // agent events not tied to a run
const MAX_CONVERSATIONS = 100;
const ROUTING_TURNS = 6;

// Allowed forward transitions per run kind. Late events can never move a run backwards.
const NEXT_STATES = {
  chat: {
    routing: ['sending', 'completed', 'failed'],
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

export async function startUiServer({ port = 3000, tutorUrl = 'http://127.0.0.1:41241', libraryUrl = 'http://127.0.0.1:41242', studentPort = 41240 } = {}) {
  const bootId = randomUUID();
  const history = []; // every published event, replayed to (re)connecting browsers
  const clients = new Set();
  const runs = new Map(); // runId → { kind, state, ... }
  const forms = new Map(); // formId → { workflowId, agentId, conversationId, contextId, taskId, state, … }
  const conversations = new Map(); // conversationId → { turns, contexts: { agentId → A2A contextId } }
  let activeRunId = null; // a chat run or form request in flight (one at a time)
  let seq = 0;

  const peers = trustedPeers({ tutorUrl, libraryUrl });
  const feeds = Object.fromEntries(Object.keys(peers).map((id) => [id, { connected: false, status: null }]));

  function publish(event) {
    const stamped = { seq: ++seq, at: new Date().toISOString(), ...event };
    history.push(stamped);
    if (history.length > MAX_HISTORY) history.shift();
    for (const res of clients) writeEvent(res, stamped);
  }

  function setState(runId, state, data = {}) {
    const run = runs.get(runId);
    if (!run || !NEXT_STATES[run.kind][run.state]?.includes(state)) return false;
    run.state = state;
    publish({ source: 'system', type: 'state', runId, data: { state, ...data } });
    return true;
  }

  // Student's trusted registry. Its events (refresh started/updated/failed) are real outcomes.
  const registry = createRegistry({ peers, onEvent: (type, data) => publish({ source: 'student', type, runId: null, data }) });

  function setFeedConnected(agentId, connected) {
    if (feeds[agentId].connected === connected) return;
    feeds[agentId].connected = connected;
    if (agentId === 'tutor') publish({ source: 'system', type: 'tutor_feed', runId: null, data: { connected } });
    publish({ source: 'system', type: 'agent_feed', runId: null, data: { agentId, connected } });
    // An agent that (re)appears may have restarted with different skills: refresh its card.
    if (connected) registry.refresh(agentId, 'reconnect');
  }

  // Subscribe to each agent's visualization feed; reconnect while the server runs.
  const feedAbort = new AbortController();
  for (const peer of Object.values(peers)) {
    (async function followFeed() {
      while (!feedAbort.signal.aborted) {
        try {
          const res = await fetch(peer.vizUrl, { signal: feedAbort.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setFeedConnected(peer.agentId, true);
          let buffer = '';
          for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame.split('\n').find((line) => line.startsWith('data: '));
              if (data) relayAgentEvent(peer.agentId, JSON.parse(data.slice(6)));
            }
          }
        } catch {
          // Agent not running or connection dropped; reported through agent_feed below.
        }
        setFeedConnected(peer.agentId, false);
        if (!feedAbort.signal.aborted) await new Promise((r) => setTimeout(r, FEED_RETRY_MS));
      }
    })();
  }

  function relayAgentEvent(agentId, event) {
    if (event.type === 'status') {
      // Mode, whether a key is present (boolean), current skills. Sent once per feed connection.
      feeds[agentId].status = event.data;
      if (agentId === 'tutor') publish({ source: 'system', type: 'tutor_status', runId: null, data: event.data });
      publish({ source: 'system', type: 'agent_status', runId: null, data: { agentId, ...event.data } });
      return;
    }
    if (event.runId == null && CONFIG_EVENTS.has(event.type)) {
      publish({ source: agentId, type: event.type, runId: null, data: event.data, at: event.at });
      return;
    }
    if (!runs.has(event.runId)) return; // only runs started from this UI (CLI runs have no runId)
    // Keep the agent's own timestamp: it records when the agent observed the event.
    publish({ source: agentId, type: event.type, runId: event.runId, data: event.data, at: event.at });
    if (event.type === 'message_received') setState(event.runId, 'waiting');
  }

  function conversation(id) {
    let c = conversations.get(id);
    if (!c) {
      c = { turns: [], contexts: {} };
      conversations.set(id, c);
      if (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
    }
    return c;
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
  app.use(express.static(PUBLIC_DIR));

  const statusBody = () => ({
    tutorUrl, tutorFeedConnected: feeds.tutor.connected, activeRunId, tutorStatus: feeds.tutor.status,
    agents: Object.fromEntries(Object.entries(feeds).map(([id, f]) => [id, { feedConnected: f.connected, status: f.status }])),
    router: routerStatus(), registry: registry.summaries(), studentEndpoint: studentEndpointUrl,
  });
  app.get('/api/status', (req, res) => res.json(statusBody()));
  app.get('/api/registry', (req, res) => res.json(registry.summaries()));

  const apiPost = express.Router();
  apiPost.use((req, res, next) => guardOrigin(req, res, next));

  // Send one chat request over A2A to the run's service. `run` holds the per-service A2A
  // contextId and the request ID (messageId); a reconcile re-sends the same ones.
  function sendChat(runId, run) {
    activeRunId = runId;
    const agentId = run.agentId ?? 'tutor';
    const peer = registry.peer(agentId);
    let card;
    if (run.routed) {
      card = registry.entry(agentId)?.card;
      if (!card) {
        publish({ source: 'student', type: 'request_failed', runId, data: { error: `${peer.displayName} has no validated Agent Card right now, so nothing was sent.`, outcome: 'not_delivered', agentId } });
        setState(runId, 'failed', { agentId });
        activeRunId = null;
        return;
      }
    }
    askTutor(peer.baseUrl, run.text, {
      runId,
      card, // routed: the registry's validated card (vetted endpoint); direct: fetched as in Parts 2–4
      contextId: run.agentContextId ?? run.contextId,
      messageId: run.messageId,
      onEvent: (type, data) => {
        // A form decided by the agent: register it (issuer, workflow, conversation) before showing it.
        const extra = type === 'form_received' ? registerForm(data, { agentId, conversationId: run.contextId, runId }) : {};
        publish({ source: 'student', type, runId, data: { ...data, agentId, ...extra } });
      },
    })
      .then((reply) => {
        // Remember a snippet of the service's reply, so a short follow-up ("yes") can be routed.
        const turn = conversations.get(run.contextId)?.turns.at(-1);
        if (run.routed && turn && turn.question === run.text) turn.answer = String(reply?.text ?? '').slice(0, 300);
        setState(runId, 'completed', { agentId });
      })
      .catch((err) => setState(runId, err.outcome === 'uncertain' ? 'uncertain' : 'failed', { agentId, ...(err.tutorError ? { tutorError: err.tutorError.code } : {}) }))
      .finally(() => {
        if (activeRunId === runId) activeRunId = null;
      });
  }

  // ---- Part 6: forms the agents decided to send --------------------------------------------

  function setLifecycle(formId, state, extra = {}) {
    const form = forms.get(formId);
    form.state = state;
    publish({ source: 'system', type: 'form_lifecycle', runId: extra.runId ?? null, data: { formId, workflowId: form.workflowId, agentId: form.agentId, state, ...extra } });
  }

  // Returns { lifecycle } for the form_received event: 'editing' to render it, anything else to not.
  function registerForm(data, { agentId, conversationId, runId }) {
    const workflow = WORKFLOWS[data.workflowId];
    // Form-origin check: an agent may only issue its own workflows.
    if (!workflow || workflow.agentId !== agentId) return { lifecycle: 'refused', refusedReason: `${agentId} can’t issue the “${data.workflowId}” workflow.` };
    const known = forms.get(data.formId);
    if (known) return { lifecycle: known.state, repeat: true }; // the same form re-sent (retry): never a second copy
    const record = {
      formId: data.formId, workflowId: data.workflowId, agentId, conversationId, contextId: data.contextId, taskId: data.taskId,
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
    const peer = registry.peer(form.agentId);
    sendFormAction(peer.baseUrl, {
      form, action, operationId, runId, acknowledgeReview, card: registry.entry(form.agentId)?.card,
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
        else setLifecycle(form.formId, 'rejected', { runId, notDelivered: true, errors: { _form: /task not found/i.test(err.message) ? 'The agent no longer knows this form (it keeps records in memory, so a restart clears them).' : `Not delivered: ${err.message}` } });
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

  // Routed chat: decide (model or heuristic), validate, then send to exactly one service — or none.
  async function routeAndSend(runId, run) {
    activeRunId = runId;
    const conv = conversation(run.contextId);
    const services = registry.routingView();
    publish({ source: 'student', type: 'route_requested', runId, data: { routerMode: ROUTER_MODE, services: services.map((s) => ({ agentId: s.agentId, skills: s.skills.map((k) => k.id), stale: s.stale })) } });
    let decision;
    try {
      decision = await decideRoute({ question: run.text, recentTurns: conv.turns, services });
    } catch (err) {
      publish({ source: 'student', type: 'route_failed', runId, data: { code: err.code ?? 'internal_error', message: err.message } });
      setState(runId, 'failed', { noServiceCalled: true });
      activeRunId = null;
      return;
    }
    publish({ source: 'student', type: 'route_decided', runId, data: decision });
    conv.turns = [...conv.turns, { question: run.text, agentId: decision.agentId, skillId: decision.skillId, answer: decision.decision === 'clarify' ? decision.clarificationQuestion ?? '' : '' }].slice(-ROUTING_TURNS);
    if (decision.decision !== 'route') {
      setState(runId, 'completed', { noServiceCalled: true, decision: decision.decision });
      activeRunId = null;
      return;
    }
    run.agentId = decision.agentId;
    run.skillId = decision.skillId;
    // Separate A2A context per service: never reuse one service's context/task IDs with another.
    run.agentContextId = conv.contexts[decision.agentId] ??= randomUUID();
    setState(runId, 'sending', { agentId: decision.agentId });
    sendChat(runId, run);
  }

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

    // contextId names the student's conversation. Direct mode uses it as the Tutor's A2A contextId
    // (Part 4); routed mode keeps a separate A2A contextId per service under it.
    const routed = ROUTER_MODE !== 'direct';
    const run = { kind: 'chat', state: routed ? 'routing' : 'sending', routed, text, contextId: requestedContext ?? randomUUID(), messageId: randomUUID(), agentId: routed ? null : 'tutor' };
    const runId = randomUUID();
    runs.set(runId, run);
    publish({ source: 'system', type: 'run_started', runId, data: { kind: 'chat', text, contextId: run.contextId, newConversation: !requestedContext, messageId: run.messageId, tutorMode: feeds.tutor.status?.mode ?? null, routerMode: ROUTER_MODE } });
    publish({ source: 'system', type: 'state', runId, data: { state: run.state } });
    res.status(202).json({ runId, contextId: run.contextId });
    if (routed) routeAndSend(runId, run);
    else sendChat(runId, run);
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

  // After an uncertain outcome: ask the SAME service again for the result of the same request.
  // No new routing decision; the service returns its stored or in-flight answer (no new model call).
  apiPost.post('/runs/:runId/reconcile', (req, res) => {
    const run = runs.get(req.params.runId);
    if (!run || run.kind !== 'chat') return res.status(404).json({ error: 'Unknown chat run.' });
    if (run.state !== 'uncertain') return res.status(409).json({ error: `Nothing to reconcile: the run is ${run.state}.` });
    if (activeRunId) return res.status(409).json({ error: 'A request is already in progress.', activeRunId });
    setState(req.params.runId, 'sending', { reconcile: true, messageId: run.messageId, agentId: run.agentId });
    res.status(202).json({ runId: req.params.runId, messageId: run.messageId });
    sendChat(req.params.runId, run);
  });

  // Manual "Refresh skills": re-fetch registered cards (conditional, coalesced). No model calls.
  apiPost.post('/registry/refresh', (req, res) => {
    const agentId = req.body?.agentId;
    if (agentId !== undefined && !registry.has(agentId)) return res.status(404).json({ error: 'Unknown agent.' });
    if (agentId) registry.refresh(agentId, 'manual');
    else registry.refreshAll('manual');
    res.status(202).json({});
  });

  // Skill settings: proxied to the registered agent's own settings API (local developer controls).
  // The destination comes from the trusted registry; the browser can't choose a URL.
  async function proxySettings(req, res, path, method) {
    const peer = registry.peer(req.params.agentId);
    if (!peer) return res.status(404).json({ error: 'Unknown agent.' });
    try {
      const upstream = await fetch(peer.settingsUrl + path, {
        method,
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(5000),
      });
      res.status(upstream.status).json(await upstream.json());
    } catch {
      res.status(502).json({ error: `${peer.displayName} is not reachable, so its settings can’t be read or saved.` });
    }
  }
  app.get('/api/agents/:agentId/skills', (req, res) => proxySettings(req, res, '', 'GET'));
  apiPost.post('/agents/:agentId/skills/preview', (req, res) => proxySettings(req, res, '/preview', 'POST'));
  apiPost.put('/agents/:agentId/skills', (req, res) => proxySettings(req, res, '', 'PUT'));

  app.use('/api', apiPost);

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId, ...statusBody() })}\n\n`);
    for (const event of history) writeEvent(res, event);
    // End of replay: the browser now reconstructs each form's CURRENT lifecycle state (rendering only
    // forms that are still editable) instead of re-rendering old form-creation events one by one.
    res.write(`event: replayed\ndata: {}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // Student's A2A receiving endpoint for agent_card_changed notifications (localhost only).
  const emitStudent = (type, data) => publish({ source: 'student', type, runId: null, data });
  let endpoint;
  try {
    endpoint = await startStudentEndpoint({ port: studentPort, registry, emit: emitStudent });
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || studentPort === 0) throw err;
    // Port taken (e.g. another UI server). Agents configured for that port can't reach this
    // Student, so their notifications will show as pending; startup/manual refresh still work.
    endpoint = await startStudentEndpoint({ port: 0, registry, emit: emitStudent });
    console.warn(`[UI] Student A2A port ${studentPort} is in use; listening on ${endpoint.baseUrl} instead. Agents notifying ${studentPort} won't reach this Student.`);
  }
  const studentEndpointUrl = endpoint.baseUrl;
  // Startup: fetch every registered card (also recovers updates sent while Student was offline).
  registry.refreshAll('startup');

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
        endpoint.server.close();
        return new Promise((r) => server.close(r));
      };
      resolve({ server, baseUrl, close, studentEndpointUrl });
    });
    server.on('error', reject);
  });
}

function writeEvent(res, event) {
  res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.UI_PORT === undefined ? 3000 : Number(process.env.UI_PORT);
  const tutorUrl = process.env.TUTOR_URL ?? 'http://127.0.0.1:41241';
  const libraryUrl = process.env.LIBRARY_URL ?? 'http://127.0.0.1:41242';
  const studentPort = process.env.STUDENT_A2A_PORT === undefined ? 41240 : Number(process.env.STUDENT_A2A_PORT);
  process.env.STUDENT_LOG_CONTENT ??= '0'; // keep chat text out of this server's logs by default
  const { baseUrl, studentEndpointUrl } = await startUiServer({ port, tutorUrl, libraryUrl, studentPort });
  console.log(`[UI] listening on ${baseUrl}`);
  console.log(`[UI] Student Agent will contact Tutor Agent at ${tutorUrl} and Library Agent at ${libraryUrl}`);
  console.log(`[UI] Student Agent A2A endpoint (card-change notifications): ${studentEndpointUrl}`);
  const r = routerStatus();
  console.log(`[UI] router: ${r.mode}${r.model ? ` (${r.model})` : ''}${r.mode === 'live' ? `, API key: ${r.keyConfigured ? 'configured' : 'NOT SET'}` : ''}`);
}
