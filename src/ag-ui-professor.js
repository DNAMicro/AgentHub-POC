// Part 10: AG-UI for the Professor view — its OWN agent stream (GET /api/ag-ui/professor/stream), separate
// from the student's: a STATE_SNAPSHOT replaces an agent's whole state, and the two sides' runs must not
// collide. The route stays browser → UI server → Hub's developer proxy → Professor agent.
//
// State: { professor: <the Professor's /author/state>, error } — fetched by the UI server (through the
// Hub) every 3 s while at least one Professor stream is connected, and when an event that changes it
// arrives; a STATE_SNAPSHOT goes out only when it changed. A professor message is one run:
// RUN_STARTED → CUSTOM professor_result (the Professor's answer to the post/chat) → STATE_SNAPSHOT →
// RUN_FINISHED, or RUN_ERROR if it wasn't processed. One message at a time (a second gets 409).
// The same run rules as the student stream: everything inside a run; a refresh that arrives while a run
// is open goes inside it; a tab that connects mid-run first gets that run's events so far.
import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';

const encoder = new EventEncoder();
const POLL_MS = 3000;
const THREAD = 'professor';

export function createProfessorAgUi({ bootId, getState, postChat, unreachable }) {
  const clients = new Set();
  let counter = 0;
  let state = null; // last snapshot sent: { professor, error }
  let open = null; // { runId, events: [...] } — the run in progress (replayed to a tab that connects mid-run)
  let timer = null;
  let refreshing = null;

  const stamp = (event) => ({ ...event, metadata: { ...(event.metadata ?? {}), id: `${bootId}:p${++counter}` } });
  const write = (res, event) => res.write(`id: ${event.metadata.id}\n${encoder.encodeSSE(event)}`);
  function emit(event) {
    const stamped = stamp(event);
    if (open) open.events.push(stamped);
    for (const res of clients) write(res, stamped);
  }
  function runStart() {
    const runId = `prof-${randomUUID()}`;
    open = { runId, events: [] };
    emit({ type: EventType.RUN_STARTED, threadId: THREAD, runId });
    return runId;
  }
  function runEnd(error = null) {
    const { runId } = open;
    if (error) emit({ type: EventType.RUN_ERROR, message: error.message, ...(error.code ? { code: error.code } : {}) });
    else emit({ type: EventType.RUN_FINISHED, threadId: THREAD, runId });
    open = null;
  }

  async function fetchState() {
    try {
      const r = await getState();
      return r.ok ? { professor: r.json, error: null } : { professor: state?.professor ?? null, error: r.json?.error ?? 'The Professor agent isn’t reachable right now.' };
    } catch {
      return { professor: state?.professor ?? null, error: unreachable };
    }
  }
  // Fetch and, if it changed, send a STATE_SNAPSHOT (inside the open run, or in its own short run).
  function refresh() {
    if (!clients.size && !open) return Promise.resolve();
    refreshing ??= (async () => {
      const next = await fetchState();
      refreshing = null;
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next;
      if (open) emit({ type: EventType.STATE_SNAPSHOT, snapshot: state });
      else {
        runStart();
        emit({ type: EventType.STATE_SNAPSHOT, snapshot: state });
        runEnd();
      }
    })();
    return refreshing;
  }

  async function connect(req, res) {
    res.writeHead(200, { 'Content-Type': encoder.getContentType(), 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (!state) state = await fetchState();
    if (open) {
      for (const e of open.events) write(res, e); // the run in progress, from its RUN_STARTED
      write(res, stamp({ type: EventType.STATE_SNAPSHOT, snapshot: state }));
    } else {
      const runId = `prof-conn-${randomUUID()}`;
      write(res, stamp({ type: EventType.RUN_STARTED, threadId: THREAD, runId }));
      write(res, stamp({ type: EventType.STATE_SNAPSHOT, snapshot: state }));
      write(res, stamp({ type: EventType.RUN_FINISHED, threadId: THREAD, runId }));
    }
    clients.add(res);
    timer ??= setInterval(refresh, POLL_MS);
    req.on('close', () => {
      clients.delete(res);
      if (!clients.size) { clearInterval(timer); timer = null; }
    });
  }

  // POST /api/ag-ui/professor/runs — one professor message as AG-UI run input. The server owns the run.
  function startRun(input) {
    if (open) return { status: 409, json: { error: 'One message at a time — the last one is still being handled.' } };
    if (typeof input?.threadId !== 'string' || !Array.isArray(input?.messages)) return { status: 400, json: { error: 'Not AG-UI run input (threadId, runId, messages).' } };
    const last = [...input.messages].reverse().find((m) => m?.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : '';
    const props = input.forwardedProps && typeof input.forwardedProps === 'object' ? input.forwardedProps : {};
    const body = { operationId: props.operationId, text, ...(props.replyTo ? { replyTo: props.replyTo } : {}), ...(props.answers ? { answers: props.answers } : {}) };
    const runId = runStart();
    (async () => {
      let result;
      try {
        result = await postChat(body);
      } catch {
        result = { ok: false, status: 502, json: { error: unreachable } };
      }
      emit({ type: EventType.CUSTOM, name: 'professor_result', value: { runId, ok: result.ok, status: result.status, json: result.json } });
      const next = await fetchState();
      state = next;
      emit({ type: EventType.STATE_SNAPSHOT, snapshot: state });
      runEnd(result.ok ? null : { message: result.json?.error ?? 'Not processed.', code: `http_${result.status}` });
    })();
    return { status: 202, json: { runId } };
  }

  // App events that change the Professor's state (a delivery, an open, a student's reply, a reset).
  function onAppEvent({ source, type }) {
    if (/^lesson_|^course_available/.test(type) || (source === 'professor' && type === 'student_reply') || type === 'conversation_reset' || type === 'classroom_reset') refresh();
  }

  const close = () => { clearInterval(timer); for (const res of clients) res.end(); };
  return { connect, startRun, onAppEvent, close };
}
