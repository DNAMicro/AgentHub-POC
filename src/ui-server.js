// UI backend. Hosts the Student Agent (its A2A client, router, trusted registry, and A2A
// receiving endpoint) and serves a browser page that visualizes the exchange.
//
// Keep these distinct:
//   * A2A:           Student → Tutor/Library JSON-RPC (questions, forms), and Tutor/Library →
//                    Student's endpoint (agent_card_changed notifications). All agent messages.
//   * Routing:       this application's choice of service (src/router.js), not an A2A feature.
//   * A2UI:          the form description the Tutor sends inside A2A, rendered by the browser.
//   * Visualization: agents' /viz/events → this server → browser /api/events (SSE). Reports real
//                    events and delivers received A2UI payloads; never carries agent messages.
//   * Settings:      local developer controls proxied to each agent's /settings/skills (HTTP, not A2A).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { askTutor, requestForm, submitForm } from './student-agent.js';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { A2UI_VERSION, validateAction } from './student-form.js';
import { createRegistry, trustedPeers } from './student-registry.js';
import { ROUTER_MODE, decideRoute, routerStatus } from './router.js';
import { startStudentEndpoint } from './student-endpoint.js';

const HOST = '127.0.0.1';
const MAX_TEXT_LENGTH = 2000;
const MAX_HISTORY = 1000;
const FEED_RETRY_MS = 1000;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const SHARED_FORM_MODULE = fileURLToPath(new URL('./student-form.js', import.meta.url));
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
  form: {
    requesting: ['awaiting_input', 'failed'],
    awaiting_input: ['submitting'],
    submitting: ['accepted', 'awaiting_input', 'uncertain'],
    uncertain: ['submitting'],
    accepted: [],
    failed: [],
  },
};

export async function startUiServer({ port = 3000, tutorUrl = 'http://127.0.0.1:41241', libraryUrl = 'http://127.0.0.1:41242', studentPort = 41240 } = {}) {
  const bootId = randomUUID();
  const history = []; // every published event, replayed to (re)connecting browsers
  const clients = new Set();
  const runs = new Map(); // runId → { kind, state, ... }
  const forms = new Map(); // formId → runId
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
  app.get('/shared/student-form.js', (req, res) => res.type('text/javascript').sendFile(SHARED_FORM_MODULE));
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
      onEvent: (type, data) => publish({ source: 'student', type, runId, data: { ...data, agentId } }),
    })
      .then(() => setState(runId, 'completed', { agentId }))
      .catch((err) => setState(runId, err.outcome === 'uncertain' ? 'uncertain' : 'failed', { agentId, ...(err.tutorError ? { tutorError: err.tutorError.code } : {}) }))
      .finally(() => {
        if (activeRunId === runId) activeRunId = null;
      });
  }

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
    conv.turns = [...conv.turns, { question: run.text, agentId: decision.agentId, skillId: decision.skillId }].slice(-ROUTING_TURNS);
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
    const submitting = [...runs.values()].some((r) => r.form?.inFlight);
    if (activeRunId || submitting) return res.status(409).json({ error: 'Wait for the current request to finish.' });
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

  // Form run (Part 3), step 1: ask the form-issuing agent (the Tutor) for the A2UI form over A2A.
  apiPost.post('/forms', (req, res) => {
    if (activeRunId) return res.status(409).json({ error: 'A request is already in progress.', activeRunId });
    const runId = startRun('form', 'requesting');
    activeRunId = runId;
    publish({ source: 'system', type: 'run_started', runId, data: { kind: 'form', agentId: 'tutor' } });
    publish({ source: 'system', type: 'state', runId, data: { state: 'requesting' } });
    res.status(202).json({ runId });

    requestForm(peers.tutor.baseUrl, {
      runId,
      onEvent: (type, data) => {
        // form_received carries the validated A2UI messages to the browser for rendering.
        publish({ source: 'student', type, runId, data });
      },
    })
      .then((form) => {
        // Record the issuing agent: submissions always return to it, never re-routed.
        runs.get(runId).form = { ...form, agentId: 'tutor', inFlight: false };
        forms.set(form.formId, runId);
        setState(runId, 'awaiting_input', { formId: form.formId, taskId: form.taskId, contextId: form.contextId });
      })
      .catch(() => setState(runId, 'failed'))
      .finally(() => {
        if (activeRunId === runId) activeRunId = null;
      });
  });

  // Form run, step 2: forward the renderer's submit action to the issuing agent over A2A.
  apiPost.post('/forms/:formId/submissions', (req, res) => {
    const runId = forms.get(req.params.formId);
    const run = runs.get(runId);
    if (!run) return res.status(404).json({ error: 'Unknown form.' });
    const { form } = run;

    const { submissionId, action } = req.body ?? {};
    const bodyKeys = Object.keys(req.body ?? {});
    if (bodyKeys.some((k) => k !== 'submissionId' && k !== 'action')) return res.status(400).json({ errors: { _form: 'Unexpected request fields.' } });
    if (typeof submissionId !== 'string' || !/^[\w-]{8,100}$/.test(submissionId)) return res.status(400).json({ errors: { _form: 'Missing or malformed submissionId.' } });
    if (!action || typeof action !== 'object' || Object.keys(action).some((k) => !ACTION_KEYS.includes(k))) {
      return res.status(400).json({ errors: { _form: 'Unexpected action fields.' } });
    }
    // Same rules the Tutor applies; invalid data is never sent over A2A.
    const check = validateAction({ version: A2UI_VERSION, action }, form.formId);
    if (!check.ok) return res.status(400).json({ errors: check.errors });

    if (form.inFlight) return res.status(409).json({ error: 'A submission is already in progress.' });
    if (run.state === 'accepted') return res.status(409).json({ error: 'This form was already submitted and accepted.' });
    // A retry after an uncertain delivery must reuse the same submissionId so the Tutor can dedupe.
    if (run.state === 'uncertain' && submissionId !== form.uncertainSubmissionId) {
      return res.status(409).json({ error: 'Delivery of the previous submission is uncertain; retry it with the same submission ID.' });
    }
    if (!setState(runId, 'submitting', { submissionId })) return res.status(409).json({ error: `Cannot submit while ${run.state}.` });

    form.inFlight = true;
    res.status(202).json({ runId, submissionId });

    submitForm(registry.peer(form.agentId).baseUrl, {
      form,
      action,
      submissionId,
      runId,
      onEvent: (type, data) => publish({ source: 'student', type, runId, data: { ...data, agentId: form.agentId } }),
    })
      .then((result) => {
        if (result.body?.status === 'accepted') setState(runId, 'accepted', { submissionId, ackId: result.body.ackId });
        else setState(runId, 'awaiting_input', { formId: form.formId, rejected: true });
      })
      .catch((err) => {
        if (err.outcome === 'uncertain') {
          form.uncertainSubmissionId = submissionId;
          setState(runId, 'uncertain', { submissionId });
        } else {
          setState(runId, 'awaiting_input', { formId: form.formId, notDelivered: true, error: err.message, code: err.cause?.code ?? null });
        }
      })
      .finally(() => {
        form.inFlight = false;
      });
  });

  app.use('/api', apiPost);

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId, ...statusBody() })}\n\n`);
    for (const event of history) writeEvent(res, event);
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
