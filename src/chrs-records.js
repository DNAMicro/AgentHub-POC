// Part 17: CHRS's link to the PeopleSoft student records stand-in (src/student-records-mcp.js) over MCP (Streamable
// HTTP). Same shape as HR's link to PeopleSoft (src/hr-peoplesoft.js; copied, not shared, because that link is tied to
// HR's moments and event names). CHRS keeps no copy of the roster: every roster request goes to the records server.
//
// Every call: tools/list (cached per connection) -> CHRS's AI chooses the tool (chooseRecordsTool) -> code accepts only
// the moment's own tool (otherwise no call at all) -> tools/call with arguments built by code -> a plain outcome:
//   { ok: true, value: { roster } }                  the records server answered (the wrapper's steps removed)
//   { ok: false, outcome: 'refused', code, reason }  it refused (code kept only if in its fixed set)
//   { ok: false, outcome: 'tool_refused' }           CHRS's AI picked another tool: nothing was called
//   { ok: false, outcome: 'tool_choice_failed' }     CHRS's AI didn't answer (timeout, 429, 500, no key): nothing was called
//   { ok: false, outcome: 'unavailable' }            nothing reached the tool (connection refused, 401, no session)
//   { ok: false, outcome: 'uncertain' }              the call went out but no answer came (timeout, reset)
// Never an automatic retry, except when the server said the session is unknown (HTTP 404, or 400 about the session, e.g.
// it restarted): the tool provably never ran, so the link reconnects and sends that call once more.
//
// Telemetry (emit(type, runId, data)): studentdb_session (run-less; only when the status changes: connected | unreachable),
// mcp_tool_refused (by: 'model' | 'mock' | 'model_failed'), mcp_call_started, mcp_call_result. Tool names, codes, counts
// (rosterCount, stepCount) and timings only; never the token, the arguments, a student's name, email or ID, or the step list.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { chooseRecordsTool, CHRS_MOMENT_TOOL } from './chrs-model.js';
import { REFUSAL_CODES } from './student-records-store.js';
import { TIMEOUTS } from './timeouts.js';

const errCode = (err) => err?.cause?.code ?? err?.code;
// The records server doesn't know this session (it restarted, or dropped it): the request was refused before any tool ran.
const sessionUnknown = (err) => err instanceof StreamableHTTPError && (err.code === 404 || (err.code === 400 && /session/i.test(err.message)));

// The tool call's own minimum (src/timeouts.js): the records server's planner plus 2 s, so a slow connect can't leave the call
// less time than the planner may take. The connect gets the rest of the shared budget, so the total stays timeoutMs.
export const CALL_FLOOR_MS = TIMEOUTS.studentRecordsPlannerMs + 2000;

export function createRecordsLink({ url, token, emit = () => {}, timeoutMs = TIMEOUTS.chrsRecordsCallMs, callFloorMs = CALL_FLOOR_MS }) {
  const base = String(url ?? '').replace(/\/+$/, '');
  let session = null; // { client, tools }
  let connecting = null;
  let reportedExtra = null;
  let reportedAt = null;
  let reported = null; // the last session status sent (connected | unreachable)
  const report = (status, extra = {}) => {
    if (reported === status) return;
    reported = status;
    reportedExtra = extra;
    reportedAt = new Date().toISOString();
    emit('studentdb_session', null, { status, ...extra });
  };
  // Reserved for the call out of the shared budget: the floor, but never so much that the connect has under 1 s
  // (small test budgets keep the old shape: connect and call share all of it).
  const reserve = Math.max(0, Math.min(callFloorMs, timeoutMs - 1000));

  const drop = (s) => {
    if (s && session === s) session = null;
    s?.client.close().catch(() => {});
  };

  // `deadline` (ms since epoch) is the call's single budget: connect, tools/list and the tool call all fit inside it.
  const left = (deadline) => Math.max(1, deadline - Date.now());

  function lost(s) {
    if (session !== s) return;
    session = null;
    s.client.close().catch(() => {});
    if (warmStopped) return;
    report('unreachable');
    warm(warmOpts);
  }

  function connect(deadline = Date.now() + timeoutMs) {
    if (session) return Promise.resolve(session);
    connecting ??= (async () => {
      const client = new Client({ name: 'chrs-agent', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token ?? ''}` } } });
      try {
        await client.connect(transport, { timeout: left(deadline) });
        const listed = await client.listTools({}, { timeout: left(deadline) });
        const s = { client, transport, tools: listed.tools.map((t) => t.name) };
        // The other process went away under a live session (its stream closed or errored): check with a ping, and if
        // it does not answer the pill follows (unreachable) and the warm-up retries. No tool call is made.
        client.onclose = () => lost(s);
        client.onerror = () => {
          if (session !== s || s.probing) return;
          s.probing = true;
          client.ping({ timeout: 2000 }).then(() => { s.probing = false; }, () => { s.probing = false; lost(s); });
        };
        session = s;
        report('connected', { tools: s.tools.length });
        return s;
      } catch (err) {
        client.close().catch(() => {});
        report('unreachable');
        throw err;
      }
    })().finally(() => { connecting = null; });
    return connecting;
  }

  // Startup warm-up (best effort, no tool call): open the MCP session so the pill is right before the first real call.
  // Failure reports unreachable and retries the connect every retryMs for up to maxMs (the other process may start
  // later); stops once connected, on close(), and never keeps the process alive (unref'd timer).
  let warmTimer = null;
  let warmStopped = false;
  let warmOpts = {};
  function warm(opts = {}) {
    if (warmTimer || warmStopped) return Promise.resolve(session ? 'connected' : 'unreachable');
    warmOpts = opts;
    const { retryMs = 3000, maxMs = 60000 } = opts;
    if (!token) return Promise.resolve('not_configured'); // no status of its own: the pill stays as it is
    const until = Date.now() + maxMs;
    const attempt = async () => {
      warmTimer = null;
      if (warmStopped || session) return;
      try {
        const s = await connect();
        if (warmStopped) drop(s);
        return;
      } catch {
        if (warmStopped || Date.now() + retryMs > until) return;
        warmTimer = setTimeout(attempt, retryMs);
        warmTimer.unref?.();
      }
    };
    return attempt().then(() => (session ? 'connected' : 'unreachable'));
  }

  async function call(moment, args, { runId = null } = {}) {
    // Budget (src/timeouts.js): the tool choice has its own limit; connect + the tool call share ONE (timeoutMs), which
    // starts when connecting starts but is re-based after the tool choice so a slow choice never shortens the call.
    // The connect may use only what the call's reserve (planner + 2 s) leaves.
    const connectStart = Date.now();
    let s;
    try {
      s = await connect(connectStart + timeoutMs - reserve);
    } catch {
      return { ok: false, outcome: 'unavailable' };
    }
    const choiceStart = Date.now();
    const choice = await chooseRecordsTool({ moment, tools: s.tools, emit: (type, data) => emit(type, runId, data) });
    const choiceMs = Date.now() - choiceStart;
    const expected = CHRS_MOMENT_TOOL[moment];
    // CHRS's AI didn't answer: not a wrong pick, and nothing was called.
    if (choice.by === 'model_failed') {
      emit('mcp_tool_refused', runId, { tool: null, moment, expected, by: 'model_failed' });
      return { ok: false, outcome: 'tool_choice_failed' };
    }
    if (choice.tool !== expected || !s.tools.includes(expected)) {
      emit('mcp_tool_refused', runId, { tool: choice.tool, moment, expected, by: choice.by });
      return { ok: false, outcome: 'tool_refused' };
    }
    // What the connect left of the budget, counted from now — at least the reserve.
    const deadline = Date.now() + Math.max(reserve, 1, timeoutMs - (Date.now() - connectStart - choiceMs));
    emit('mcp_call_started', runId, { tool: expected, moment });
    const started = Date.now();
    const done = (r, extra = {}) => {
      emit('mcp_call_result', runId, { tool: expected, moment, ok: r.ok, code: r.code ?? null, outcome: r.ok ? 'ok' : r.outcome, rosterCount: null, stepCount: null, latencyMs: Date.now() - started, ...extra });
      // The pill follows what really happened: the records server answered (even a refusal) or nothing reached it.
      if (r.ok || r.outcome === 'refused') report('connected');
      else if (r.outcome === 'unavailable') report('unreachable');
      return r;
    };
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await s.client.callTool({ name: expected, arguments: args }, undefined, { timeout: left(deadline) });
        break;
      } catch (err) {
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) return done({ ok: false, outcome: 'uncertain' });
        drop(s); // the next call opens a fresh session
        if (attempt === 0 && sessionUnknown(err)) {
          // The tool never ran: a fresh session, and the same call exactly once more.
          try {
            s = await connect(deadline);
          } catch {
            return done({ ok: false, outcome: 'unavailable' });
          }
          if (!s.tools.includes(expected)) return done({ ok: false, outcome: 'unavailable' });
          continue;
        }
        // An HTTP error status (401, no session) or a refused connection: the tool never ran.
        if (err instanceof StreamableHTTPError || errCode(err) === 'ECONNREFUSED') return done({ ok: false, outcome: 'unavailable' });
        return done({ ok: false, outcome: 'uncertain' });
      }
    }
    const value = result?.structuredContent ?? null;
    if (result?.isError) {
      // Only the records server's fixed refusal codes pass; anything else is reported without a code (the reason text stays).
      const code = REFUSAL_CODES.includes(value?.code) ? value.code : null;
      const reason = typeof value?.reason === 'string' ? value.reason : 'Student records could not complete that request.';
      return done({ ok: false, outcome: 'refused', code, reason });
    }
    if (!value || typeof value !== 'object') return done({ ok: false, outcome: 'refused', code: null, reason: 'Student records could not complete that request.' });
    const roster = value.roster;
    if (!roster || typeof roster !== 'object' || !Array.isArray(roster.rows)) return done({ ok: false, outcome: 'refused', code: null, reason: 'Student records could not complete that request.' });
    return done({ ok: true, value: { roster } }, { rosterCount: roster.rows.length, stepCount: Array.isArray(value.steps) ? value.steps.length : (Number.isInteger(value.stepCount) ? value.stepCount : null) });
  }

  return {
    warm,
    // The last session state reported (null before any): { status, tools? }. For a feed follower that connects later.
    sessionStatus: () => (reported ? { status: reported, ...(reportedExtra ?? {}), at: reportedAt } : null),
    // courseId + the instructor's staff id (from the Hub's signature, never from words) -> value { roster: { class, rows } }
    // moment 'email' (review C16): the same tool, read fresh for the campus emails of students a notice must be emailed to.
    roster: (courseId, instructorStaffId, { runId, moment = 'roster' } = {}) => call(moment === 'email' ? 'email' : 'roster', { courseId, instructorStaffId }, { runId }),
    // Test hook passthrough: the records server's own state (only when it runs with its test hooks).
    async state() {
      const r = await fetch(`${base}/test/state`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`Student records test state: HTTP ${r.status}`);
      return r.json();
    },
    // Shutdown: end the MCP session at the records server (DELETE), then close the client. Best effort and bounded.
    async close() {
      warmStopped = true;
      clearTimeout(warmTimer);
      const s = session;
      session = null;
      if (!s) return;
      await Promise.race([s.transport.terminateSession().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
      await s.client.close().catch(() => {});
    },
  };
}
