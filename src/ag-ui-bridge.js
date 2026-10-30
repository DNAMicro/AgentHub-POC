// Part 10: AG-UI (Agent–User Interaction protocol, @ag-ui/* 1.0.3) between the Student agent and the
// browser's Conversation and Agent activity tabs. A second VIEW of the UI server's real events — the
// monitoring stream /api/events stays complete and unchanged (Topology, the hop-by-hop strip and the
// tests read it). Nothing here invents an event or reorders a run.
//
// The installed client checks every stream: it must start with RUN_STARTED, a run can't start while
// another is open, and nothing may arrive between runs (a violation ends the stream). So one strict run
// sequence is kept and shared by every connected tab:
//   - an app run (run_started) opens an AG-UI run; its terminal state closes it (RUN_FINISHED/RUN_ERROR);
//   - anything that arrives while a run is open goes inside it (CUSTOM / ACTIVITY_SNAPSHOT / STATE_DELTA);
//   - anything that arrives between runs is batched into one short server-opened run (a reconcile of an
//     earlier run carries parentRunId).
// Mapping: the reply as TEXT_MESSAGE_START/CONTENT/END (it arrives whole: one block) + a CUSTOM with its
// metadata; agent telemetry (hub, tutor, library, professor) as ACTIVITY_SNAPSHOT; a form's lifecycle as
// STATE_DELTA on /forms/<formId> (state: { forms }); everything else as CUSTOM named by the event type.
// Every AG-UI event carries metadata.id (written as the SSE id: line too; the encoder writes only data:).
import { randomUUID } from 'node:crypto';
import { EventType } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';

const encoder = new EventEncoder();
const ACTIVITY_SOURCES = new Set(['hub', 'tutor', 'library', 'professor']);
const TERMINAL = { chat: new Set(['completed', 'failed', 'uncertain']), form_action: new Set(['completed', 'failed', 'uncertain']) };
const BATCH_MS = 150;
const MAX_FORMS = 200;
const pointer = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

export function createAgUiBridge({ bootId, historyLimit = 1000, hello = () => ({}) }) {
  const log = []; // { event, runStart } — runStart: the index (in `counter` terms) of its run's RUN_STARTED
  const clients = new Set();
  const forms = new Map(); // formId → the latest form_lifecycle data (the shared state snapshot)
  const appRuns = new Map(); // app runId → kind (to know when a run ends, and what a reconcile refers to)
  let counter = 0; // AG-UI event sequence (separate from the app's seq)
  let open = null; // { runId, threadId, kind: 'app' | 'server', startN, timer }
  let thread = 'ui'; // the current conversation (contextId), used as threadId for server-opened runs
  let dropped = 0; // AG-UI events trimmed from the front (always whole runs)
  let conn = 0;

  const stampLive = (event) => {
    counter += 1;
    const id = `${bootId}:a${counter}`;
    return { n: counter, event: { ...event, metadata: { ...(event.metadata ?? {}), id } } };
  };
  function emit(event) {
    const { n, event: stamped } = stampLive(event);
    const runStart = event.type === EventType.RUN_STARTED ? n : open?.startN ?? n;
    log.push({ n, runStart, event: stamped });
    trim();
    for (const res of clients) write(res, stamped);
    return n;
  }
  // Keep the log bounded by dropping WHOLE runs from the front (a resume never starts mid-run).
  function trim() {
    while (log.length > historyLimit) {
      const next = log.findIndex((e, i) => i > 0 && e.event.type === EventType.RUN_STARTED);
      if (next <= 0 || (open && log[0].n === open.startN)) break; // never cut into the run that is still open
      dropped += next;
      log.splice(0, next);
    }
  }

  function startRun({ runId, threadId, kind, parentRunId, cause }) {
    const n = emit({ type: EventType.RUN_STARTED, threadId, runId, ...(parentRunId ? { parentRunId } : {}) });
    open = { runId, threadId, kind, startN: n, timer: null };
    if (kind === 'server') {
      emit({ type: EventType.CUSTOM, name: 'server_run', value: { cause, ...(parentRunId ? { parentRunId } : {}) } });
      open.timer = setTimeout(finishRun, BATCH_MS);
    }
  }
  function finishRun(outcome = { type: EventType.RUN_FINISHED }) {
    if (!open) return;
    clearTimeout(open.timer);
    const { runId, threadId } = open;
    if (outcome.type === EventType.RUN_ERROR) emit({ type: EventType.RUN_ERROR, message: outcome.message, ...(outcome.code ? { code: outcome.code } : {}) });
    else emit({ type: EventType.RUN_FINISHED, threadId, runId, ...(outcome.result ? { result: outcome.result } : {}) });
    open = null;
  }

  // The AG-UI events for one app event (inside whatever run is open).
  function mapped(app) {
    const { source, type, data } = app;
    if (source === 'student' && type === 'reply_received') {
      const messageId = `msg-${app.id}`;
      const text = String(data?.text ?? '');
      const out = [{ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }];
      if (text) out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text });
      out.push({ type: EventType.TEXT_MESSAGE_END, messageId });
      const { text: _omit, ...meta } = data ?? {};
      out.push({ type: EventType.CUSTOM, name: 'reply_received', value: { ...app, data: meta, textMessageId: messageId } });
      return out;
    }
    if (source === 'system' && type === 'form_lifecycle' && data?.formId) {
      forms.set(data.formId, data);
      if (forms.size > MAX_FORMS) forms.delete(forms.keys().next().value);
      const { data: _d, ...envelope } = app;
      return [{ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: `/forms/${pointer(data.formId)}`, value: data }], metadata: { appEvent: envelope } }];
    }
    if (source === 'student' && type === 'form_received' && data?.formId && data.lifecycle) {
      // A form's FIRST state travels inside form_received (later changes are form_lifecycle events), so the
      // shared state learns about the form here. No appEvent on this delta: the form renders from the CUSTOM.
      const entry = { formId: data.formId, workflowId: data.workflowId, agentId: data.agentId ?? data.issuer, state: data.lifecycle };
      forms.set(data.formId, entry);
      if (forms.size > MAX_FORMS) forms.delete(forms.keys().next().value);
      return [{ type: EventType.STATE_DELTA, delta: [{ op: 'add', path: `/forms/${pointer(data.formId)}`, value: entry }] }, { type: EventType.CUSTOM, name: type, value: app }];
    }
    if (ACTIVITY_SOURCES.has(source)) {
      return [{ type: EventType.ACTIVITY_SNAPSHOT, messageId: `act-${app.id}`, activityType: source, content: app }];
    }
    return [{ type: EventType.CUSTOM, name: type, value: app }];
  }

  // Called for every app event the UI server publishes (heartbeats excluded).
  function push(app) {
    const { type, runId, data } = app;
    if (type === 'run_started' && runId) {
      if (open) finishRun(open.kind === 'app' ? { type: EventType.RUN_FINISHED, result: { closedBy: runId } } : undefined);
      appRuns.set(runId, data?.kind ?? 'chat');
      if (appRuns.size > 1000) appRuns.delete(appRuns.keys().next().value);
      if (data?.contextId) thread = data.contextId;
      startRun({ runId, threadId: data?.contextId ?? thread, kind: 'app' });
      for (const e of mapped(app)) emit(e);
      return;
    }
    if (type === 'conversation_reset') thread = 'ui';
    if (!open) {
      // Something nobody asked for (a lesson, a receipt, late telemetry) or a reconcile of a finished run.
      const parentRunId = runId && appRuns.has(runId) ? runId : undefined;
      startRun({ runId: `srv-${randomUUID()}`, threadId: thread, kind: 'server', parentRunId, cause: type });
    }
    for (const e of mapped(app)) emit(e);
    if (open?.kind === 'app' && type === 'state' && runId === open.runId && TERMINAL[appRuns.get(runId)]?.has(data?.state)) {
      if (data.state === 'failed') finishRun({ type: EventType.RUN_ERROR, message: 'The request failed.', code: 'failed' });
      else finishRun({ type: EventType.RUN_FINISHED, result: { state: data.state } });
    }
  }

  // GET /api/ag-ui/stream — one long-lived AG-UI event stream per tab.
  function connect(req, res) {
    res.writeHead(200, { 'Content-Type': encoder.getContentType(), 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    conn += 1;
    let k = 0;
    const own = (event) => ({ ...event, metadata: { ...(event.metadata ?? {}), id: `${bootId}:c${conn}-${++k}` } });
    const cursor = String(req.headers['last-event-id'] ?? req.query?.after ?? '');
    const [cursorBoot, cursorN] = cursor.split(':a');
    const after = cursorBoot === bootId && Number.isInteger(Number(cursorN)) ? Number(cursorN) : null;
    const oldestN = log[0]?.n ?? counter + 1;
    const resumed = after !== null && after >= oldestN - 1;
    const snapshot = { forms: Object.fromEntries(forms) };
    // A private opening run: the current shared state first (a delta never comes before its snapshot).
    const connRun = `conn-${randomUUID()}`;
    write(res, own({ type: EventType.RUN_STARTED, threadId: thread, runId: connRun }));
    write(res, own({ type: EventType.STATE_SNAPSHOT, snapshot }));
    write(res, own({ type: EventType.CUSTOM, name: 'hello', value: { bootId, resumed, ...hello() } }));
    if (!resumed && (dropped > 0 || (after !== null && after < oldestN - 1))) write(res, own({ type: EventType.CUSTOM, name: 'truncated', value: { missed: dropped, kept: log.length } }));
    write(res, own({ type: EventType.RUN_FINISHED, threadId: thread, runId: connRun }));
    // Replay — only from a run boundary: a resume inside a run re-sends that run from its RUN_STARTED
    // (the browser drops what it already has before the client's checker sees it).
    let from = 0;
    if (resumed) {
      const first = log.findIndex((e) => e.n > after);
      from = first === -1 ? log.length : log.findIndex((e) => e.n === log[first].runStart);
      if (from < 0) from = first;
    }
    for (let i = from; i < log.length; i++) write(res, log[i].event);
    const marker = own({ type: EventType.CUSTOM, name: 'replayed', value: {} });
    if (open) write(res, marker); // inside the run that is still open
    else {
      const markerRun = `conn-${randomUUID()}`;
      write(res, own({ type: EventType.RUN_STARTED, threadId: thread, runId: markerRun }));
      write(res, marker);
      write(res, own({ type: EventType.RUN_FINISHED, threadId: thread, runId: markerRun }));
    }
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  const close = () => { if (open) clearTimeout(open.timer); for (const res of clients) res.end(); };
  return { push, connect, close, status: () => ({ events: counter, kept: log.length, openRun: open?.runId ?? null, clients: clients.size }) };
}

function write(res, event) {
  res.write(`id: ${event.metadata.id}\n${encoder.encodeSSE(event)}`);
}
