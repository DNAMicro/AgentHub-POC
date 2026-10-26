// UI backend. Hosts the Student Agent (its existing A2A client, askTutor) and
// serves a browser page that visualizes the exchange.
//
// Two different connections are involved — keep them distinct:
//   * A2A:           askTutor() → Tutor's JSON-RPC endpoint (the real agent communication)
//   * Visualization: Tutor's /viz/events feed → this server → browser /api/events (SSE, read-only)
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { askTutor } from './student-agent.js';

const HOST = '127.0.0.1';
const MAX_TEXT_LENGTH = 2000;
const MAX_HISTORY = 1000;
const FEED_RETRY_MS = 1000;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

// Allowed forward transitions. A late Tutor event can never move a finished run backwards.
const NEXT_STATES = {
  sending: ['waiting', 'completed', 'failed'],
  waiting: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function startUiServer({ port = 3000, tutorUrl = 'http://127.0.0.1:41241' } = {}) {
  const bootId = randomUUID();
  const history = []; // every published event, replayed to (re)connecting browsers
  const clients = new Set();
  const runs = new Map(); // runId → { state }
  let activeRunId = null;
  let seq = 0;
  let tutorFeedConnected = false;

  function publish(event) {
    const stamped = { seq: ++seq, at: new Date().toISOString(), ...event };
    history.push(stamped);
    if (history.length > MAX_HISTORY) history.shift();
    for (const res of clients) writeEvent(res, stamped);
  }

  function setState(runId, state) {
    const run = runs.get(runId);
    if (!run || !NEXT_STATES[run.state].includes(state)) return;
    run.state = state;
    publish({ source: 'system', type: 'state', runId, data: { state } });
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

  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/status', (req, res) => {
    res.json({ tutorUrl, tutorFeedConnected, activeRunId });
  });

  // The ONLY place an A2A request is started. Reconnecting browsers use GET /api/events and never reach here.
  app.post('/api/runs', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Message text is required.' });
    if (text.length > MAX_TEXT_LENGTH) return res.status(400).json({ error: `Message exceeds ${MAX_TEXT_LENGTH} characters.` });
    if (activeRunId) return res.status(409).json({ error: 'A request is already in progress.', activeRunId });

    const runId = randomUUID();
    activeRunId = runId;
    runs.set(runId, { state: 'sending' });
    publish({ source: 'system', type: 'run_started', runId, data: { text } });
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

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId, tutorFeedConnected, activeRunId })}\n\n`);
    for (const event of history) writeEvent(res, event);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST, () => {
      const baseUrl = `http://${HOST}:${server.address().port}`;
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
