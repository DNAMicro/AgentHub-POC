// UI backend. Hosts the Student Agent (its A2A client functions) and serves a
// browser page that visualizes the exchange.
//
// Three different things are involved — keep them distinct:
//   * A2A:           student-agent.js → Tutor's JSON-RPC endpoint (all agent communication)
//   * A2UI:          the form description the Tutor sends inside A2A, rendered by the browser
//   * Visualization: Tutor /viz/events → this server → browser /api/events (SSE). It reports
//                    real events and delivers the received A2UI payload to the browser; it never
//                    carries agent-to-agent messages.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { askTutor, requestForm, submitForm } from './student-agent.js';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { A2UI_VERSION, validateAction } from './student-form.js';

const HOST = '127.0.0.1';
const MAX_TEXT_LENGTH = 2000;
const MAX_HISTORY = 1000;
const FEED_RETRY_MS = 1000;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const SHARED_FORM_MODULE = fileURLToPath(new URL('./student-form.js', import.meta.url));
const ACTION_KEYS = ['name', 'surfaceId', 'sourceComponentId', 'timestamp', 'context'];

// Allowed forward transitions per run kind. Late events can never move a run backwards.
const NEXT_STATES = {
  // chat run (Part 1/2)
  sending: ['waiting', 'completed', 'failed'],
  waiting: ['completed', 'failed'],
  completed: [],
  // form run (Part 3)
  requesting: ['awaiting_input', 'failed'],
  awaiting_input: ['submitting'],
  submitting: ['accepted', 'awaiting_input', 'uncertain'],
  uncertain: ['submitting'],
  accepted: [],
  failed: [],
};

export function startUiServer({ port = 3000, tutorUrl = 'http://127.0.0.1:41241' } = {}) {
  const bootId = randomUUID();
  const history = []; // every published event, replayed to (re)connecting browsers
  const clients = new Set();
  const runs = new Map(); // runId → { state, form? }
  const forms = new Map(); // formId → runId
  let activeRunId = null; // a chat run or form request in flight (one at a time)
  let seq = 0;
  let tutorFeedConnected = false;

  function publish(event) {
    const stamped = { seq: ++seq, at: new Date().toISOString(), ...event };
    history.push(stamped);
    if (history.length > MAX_HISTORY) history.shift();
    for (const res of clients) writeEvent(res, stamped);
  }

  function setState(runId, state, data = {}) {
    const run = runs.get(runId);
    if (!run || !NEXT_STATES[run.state].includes(state)) return false;
    run.state = state;
    publish({ source: 'system', type: 'state', runId, data: { state, ...data } });
    return true;
  }

  function setFeedConnected(connected) {
    if (connected === tutorFeedConnected) return;
    tutorFeedConnected = connected;
    publish({ source: 'system', type: 'tutor_feed', runId: null, data: { connected } });
  }

  // Subscribe to the Tutor process's visualization feed; reconnect while the server runs.
  const feedAbort = new AbortController();
  (async function followTutorFeed() {
    while (!feedAbort.signal.aborted) {
      try {
        const res = await fetch(`${tutorUrl}/viz/events`, { signal: feedAbort.signal });
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
            if (data) relayTutorEvent(JSON.parse(data.slice(6)));
          }
        }
      } catch {
        // Tutor not running or connection dropped; reported through tutor_feed below.
      }
      setFeedConnected(false);
      if (!feedAbort.signal.aborted) await new Promise((r) => setTimeout(r, FEED_RETRY_MS));
    }
  })();

  function relayTutorEvent(event) {
    if (!runs.has(event.runId)) return; // only runs started from this UI (CLI runs have no runId)
    // Keep the Tutor's own timestamp: it records when the Tutor observed the event.
    publish({ source: 'tutor', type: event.type, runId: event.runId, data: event.data, at: event.at });
    if (event.type === 'message_received') setState(event.runId, 'waiting');
  }

  const startRun = (kind, state) => {
    const runId = randomUUID();
    runs.set(runId, { kind, state });
    return runId;
  };

  // Both guards need the real port (tests listen on port 0), so they're set in the listen callback.
  // No request can arrive before then.
  let guardHost;
  let guardOrigin;

  const app = express();
  app.use((req, res, next) => guardHost(req, res, next));
  app.use(express.json({ limit: '16kb' }));
  app.get('/shared/student-form.js', (req, res) => res.type('text/javascript').sendFile(SHARED_FORM_MODULE));
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/status', (req, res) => {
    res.json({ tutorUrl, tutorFeedConnected, activeRunId });
  });

  const apiPost = express.Router();
  apiPost.use((req, res, next) => guardOrigin(req, res, next));

  // Chat run (Part 1/2). Only POSTs start A2A requests; reconnecting browsers use GET /api/events.
  apiPost.post('/runs', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Message text is required.' });
    if (text.length > MAX_TEXT_LENGTH) return res.status(400).json({ error: `Message exceeds ${MAX_TEXT_LENGTH} characters.` });
    if (activeRunId) return res.status(409).json({ error: 'A request is already in progress.', activeRunId });

    const runId = startRun('chat', 'sending');
    activeRunId = runId;
    publish({ source: 'system', type: 'run_started', runId, data: { kind: 'chat', text } });
    publish({ source: 'system', type: 'state', runId, data: { state: 'sending' } });
    res.status(202).json({ runId });

    askTutor(tutorUrl, text, {
      runId,
      onEvent: (type, data) => publish({ source: 'student', type, runId, data }),
    })
      .then(() => setState(runId, 'completed'))
      .catch(() => setState(runId, 'failed'))
      .finally(() => {
        if (activeRunId === runId) activeRunId = null;
      });
  });

  // Form run (Part 3), step 1: ask the Tutor for the A2UI form over A2A.
  apiPost.post('/forms', (req, res) => {
    if (activeRunId) return res.status(409).json({ error: 'A request is already in progress.', activeRunId });
    const runId = startRun('form', 'requesting');
    activeRunId = runId;
    publish({ source: 'system', type: 'run_started', runId, data: { kind: 'form' } });
    publish({ source: 'system', type: 'state', runId, data: { state: 'requesting' } });
    res.status(202).json({ runId });

    requestForm(tutorUrl, {
      runId,
      onEvent: (type, data) => {
        // form_received carries the validated A2UI messages to the browser for rendering.
        publish({ source: 'student', type, runId, data });
      },
    })
      .then((form) => {
        runs.get(runId).form = { ...form, inFlight: false };
        forms.set(form.formId, runId);
        setState(runId, 'awaiting_input', { formId: form.formId, taskId: form.taskId, contextId: form.contextId });
      })
      .catch(() => setState(runId, 'failed'))
      .finally(() => {
        if (activeRunId === runId) activeRunId = null;
      });
  });

  // Form run, step 2: forward the renderer's submit action to the Tutor over A2A.
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

    submitForm(tutorUrl, {
      form,
      action,
      submissionId,
      runId,
      onEvent: (type, data) => publish({ source: 'student', type, runId, data }),
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
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId, tutorFeedConnected, activeRunId })}\n\n`);
    for (const event of history) writeEvent(res, event);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST, () => {
      const actualPort = server.address().port;
      guardHost = hostGuard(actualPort);
      guardOrigin = sameOriginGuard(actualPort);
      const baseUrl = `http://${HOST}:${actualPort}`;
      const close = () => {
        feedAbort.abort();
        for (const res of clients) res.end();
        return new Promise((r) => server.close(r));
      };
      resolve({ server, baseUrl, close });
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
  const { baseUrl } = await startUiServer({ port, tutorUrl });
  console.log(`[UI] listening on ${baseUrl}`);
  console.log(`[UI] Student Agent will contact Tutor Agent at ${tutorUrl}`);
}
