// Part 16: the Faculty agent's link to Canvas LMS (the DEMO STAND-IN, src/canvas-mcp.js) over MCP (Streamable HTTP).
// Same shape as HR's link to PeopleSoft (src/hr-peoplesoft.js; copied, not shared, because that link is tied to HR's
// moments and event names). Faculty keeps no copy of the quizzes: they live in Canvas.
//
// Every call: tools/list (cached per connection) -> the Faculty AI chooses the tool for this moment
// (chooseCanvasTool) -> code accepts only the moment's own tool (otherwise no call at all) -> tools/call with
// arguments built by code -> a plain outcome:
//   { ok: true, value: { receipt } }                 Canvas answered (the wrapper's steps removed, stepCount kept)
//   { ok: false, outcome: 'refused', code, reason }  Canvas refused it (code kept only if in its fixed set)
//   { ok: false, outcome: 'tool_refused' }           the AI picked another tool: nothing was called
//   { ok: false, outcome: 'tool_choice_failed' }     the AI didn't answer (timeout, 429, 500, no key): nothing was called
//   { ok: false, outcome: 'closed' }                 isClosed() said the card closed meanwhile: nothing was called
//   { ok: false, outcome: 'not_configured' }         no CANVAS_TOKEN: nothing was called, no network
//   { ok: false, outcome: 'unavailable' }            nothing reached the tool (connection refused, 401, no session)
//   { ok: false, outcome: 'uncertain' }              the call went out but no answer came (timeout, reset, Canvas error)
// Never an automatic retry, except when Canvas said the session is unknown (HTTP 404, or 400 about the session, e.g.
// it restarted): the tool provably never ran, so the link reconnects and sends that call once more. Anything else is
// the caller's to retry with the same operationId (Canvas dedupes it). Results are never cached here.
//
// Telemetry (emit(type, runId, data)): canvas_session (run-less; only on a change: connected | unreachable |
// not_configured), mcp_tool_refused (by: 'model' | 'mock' | 'model_failed'), mcp_call_started, mcp_call_result.
// Tool names, codes, quiz ids, counts and timings only; never the token, the quiz (questions, answers, title) or the
// wrapper's step list.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { chooseCanvasTool, CANVAS_MOMENT_TOOL } from './professor-model.js';
import { CANVAS_REFUSAL_CODES } from './canvas-store.js';
import { TIMEOUTS } from './timeouts.js';

const COURSE_ID = 'mkt-351';
const errCode = (err) => err?.cause?.code ?? err?.code;
const sessionUnknown = (err) => err instanceof StreamableHTTPError && (err.code === 404 || (err.code === 400 && /session/i.test(err.message)));
export const withoutSteps = (receipt) => {
  if (!receipt || typeof receipt !== 'object') return receipt;
  const { steps, ...rest } = receipt;
  return rest;
};
const REFUSED_TEXT = 'Canvas could not complete that request.';

// The call's own minimum: Canvas's planner plus 2 s, so a slow connect can't leave the call less time than the planner
// may take. The connect gets the rest of the shared budget, so the total stays timeoutMs.
export const CALL_FLOOR_MS = TIMEOUTS.canvasPlannerMs + 2000;

export function createCanvasLink({ url, token, emit = () => {}, timeoutMs = TIMEOUTS.professorCanvasCallMs, callFloorMs = CALL_FLOOR_MS }) {
  const base = String(url ?? '').replace(/\/+$/, '');
  let session = null; // { client, transport, tools }
  let connecting = null;
  let reportedExtra = null;
  let reported = null;
  const report = (status, extra = {}) => {
    if (reported === status) return;
    reported = status;
    reportedExtra = extra;
    emit('canvas_session', null, { status, ...extra });
  };
  const reserve = Math.max(0, Math.min(callFloorMs, timeoutMs - 1000));
  const drop = (s) => {
    if (s && session === s) session = null;
    s?.client.close().catch(() => {});
  };
  const left = (deadline) => Math.max(1, deadline - Date.now());

  function connect(deadline = Date.now() + timeoutMs) {
    if (session) return Promise.resolve(session);
    connecting ??= (async () => {
      const client = new Client({ name: 'faculty-agent', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      try {
        await client.connect(transport, { timeout: left(deadline) });
        const listed = await client.listTools({}, { timeout: left(deadline) });
        const s = { client, transport, tools: listed.tools.map((t) => t.name) };
        client.onclose = () => { if (session === s) session = null; };
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
  function warm({ retryMs = 3000, maxMs = 60000 } = {}) {
    if (!token) {
      report('not_configured');
      return Promise.resolve('not_configured');
    }
    const until = Date.now() + maxMs;
    const attempt = async () => {
      warmTimer = null;
      if (warmStopped || session) return;
      try {
        await connect();
        return;
      } catch {
        if (warmStopped || Date.now() + retryMs > until) return;
        warmTimer = setTimeout(attempt, retryMs);
        warmTimer.unref?.();
      }
    };
    return attempt().then(() => (session ? 'connected' : 'unreachable'));
  }

  async function call(moment, args, { runId = null, operationId = null, isClosed = () => false } = {}) {
    if (!token) {
      report('not_configured');
      return { ok: false, outcome: 'not_configured' };
    }
    if (isClosed()) return { ok: false, outcome: 'closed' };
    const connectStart = Date.now();
    let s;
    try {
      s = await connect(connectStart + timeoutMs - reserve);
    } catch {
      return { ok: false, outcome: 'unavailable' };
    }
    const choiceStart = Date.now();
    const choice = await chooseCanvasTool({ moment, tools: s.tools, emit: (type, data) => emit(type, runId, data) });
    const choiceMs = Date.now() - choiceStart;
    const expected = CANVAS_MOMENT_TOOL[moment];
    if (choice.by === 'model_failed') {
      emit('mcp_tool_refused', runId, { tool: null, moment, expected, by: 'model_failed' });
      return { ok: false, outcome: 'tool_choice_failed' };
    }
    if (choice.tool !== expected || !s.tools.includes(expected)) {
      emit('mcp_tool_refused', runId, { tool: choice.tool, moment, expected, by: choice.by });
      return { ok: false, outcome: 'tool_refused' };
    }
    if (isClosed()) return { ok: false, outcome: 'closed' };
    const deadline = Date.now() + Math.max(reserve, 1, timeoutMs - (Date.now() - connectStart - choiceMs));
    emit('mcp_call_started', runId, { tool: expected, moment, operationId });
    const started = Date.now();
    const done = (r, extra = {}) => {
      emit('mcp_call_result', runId, { tool: expected, moment, ok: r.ok, code: r.code ?? null, outcome: r.ok ? 'ok' : r.outcome, quizId: null, stepCount: null, latencyMs: Date.now() - started, ...extra });
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
        drop(s);
        if (attempt === 0 && sessionUnknown(err)) {
          try {
            s = await connect(deadline);
          } catch {
            return done({ ok: false, outcome: 'unavailable' });
          }
          if (!s.tools.includes(expected)) return done({ ok: false, outcome: 'unavailable' });
          continue;
        }
        // Intentionally differs from hr-peoplesoft.js: a 5xx during tools/call means Canvas may have run the tool, so it is
        // uncertain (the caller retries with the same operationId). 401, no session and a refused connection are unavailable.
        if (err instanceof StreamableHTTPError && err.code >= 500) return done({ ok: false, outcome: 'uncertain' });
        if (err instanceof StreamableHTTPError || errCode(err) === 'ECONNREFUSED') return done({ ok: false, outcome: 'unavailable' });
        return done({ ok: false, outcome: 'uncertain' });
      }
    }
    const value = result?.structuredContent ?? null;
    // Structural rule (never Canvas's wording): an error WITH structured content is a refusal (code kept only if in the
    // fixed set); an error or a success-shaped answer WITHOUT usable content is unknown: Canvas may have stored it.
    if (result?.isError) {
      if (!value || typeof value !== 'object') return done({ ok: false, outcome: 'uncertain' });
      const code = CANVAS_REFUSAL_CODES.includes(value.code) ? value.code : null;
      const reason = typeof value.reason === 'string' ? value.reason : REFUSED_TEXT;
      return done({ ok: false, outcome: 'refused', code, reason });
    }
    if (!value || typeof value !== 'object' || !value.receipt || typeof value.receipt !== 'object') return done({ ok: false, outcome: 'uncertain' });
    const receipt = value.receipt;
    return done({ ok: true, value: { receipt: withoutSteps(receipt) } }, { quizId: receipt.quizId ?? null, stepCount: receipt.stepCount ?? (Array.isArray(receipt.steps) ? receipt.steps.length : null) });
  }

  return {
    warm,
    // The last session state reported (null before any): { status, tools? }. For a feed follower that connects later.
    sessionStatus: () => (reported ? { status: reported, ...(reportedExtra ?? {}) } : null),
    // quiz: the Faculty's checked quiz { title, questions, settings... } (built by code) -> value { receipt }
    createQuiz: ({ quiz, operationId, runId, isClosed }) => call('approve', { courseId: COURSE_ID, quiz, operationId }, { runId, operationId, isClosed }),
    publishQuiz: ({ quizId, operationId, runId, isClosed }) => call('publish', { courseId: COURSE_ID, quizId, operationId }, { runId, operationId, isClosed }),
    // Shutdown: end the MCP session at Canvas (DELETE), then close the client. Best effort and bounded.
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
