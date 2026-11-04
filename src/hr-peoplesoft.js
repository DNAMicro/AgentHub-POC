// Part 15: the HR Agent's link to PeopleSoft (the DEMO STAND-IN, src/peoplesoft-mcp.js) over MCP (Streamable
// HTTP). HR keeps no copy of the staff data: balances, filed requests and records live in PeopleSoft.
//
// Every call: tools/list (cached per connection) → HR's AI chooses the tool for this moment (chooseTool) →
// code accepts only the moment's own tool (otherwise no call at all) → tools/call with arguments built by
// code → a plain outcome:
//   { ok: true, value }                              PeopleSoft answered
//   { ok: false, outcome: 'refused', code, reason }  PeopleSoft refused it (code from its fixed set)
//   { ok: false, outcome: 'tool_refused' }           HR's AI picked another tool: nothing was called
//   { ok: false, outcome: 'tool_choice_failed' }     HR's AI didn't answer (timeout, 429, 500, no key): nothing was called
//   { ok: false, outcome: 'closed' }                 the caller's isClosed() said the card closed meanwhile: nothing was called
//   { ok: false, outcome: 'unavailable' }            nothing reached the tool (connection refused, 401, no session)
//   { ok: false, outcome: 'uncertain' }              the call went out but no answer came (timeout, reset)
// Never an automatic retry, with one exception: PeopleSoft said the session is unknown (HTTP 404, or 400 about the
// session — e.g. it restarted), so the tool provably never ran; the link reconnects and sends that call once more.
// Anything else is the caller's to retry (with the same operationId; PeopleSoft dedupes it).
//
// Telemetry (emit(type, runId, data)): peoplesoft_session (run-less; only when the status changes: connected after
// a connect or a successful call, unreachable after a failed connect or a call that ended unavailable),
// mcp_tool_refused (by: 'model' | 'mock' | 'model_failed'), mcp_call_started, mcp_call_result. Tool names, codes,
// record ids, counts and timings only — never the token, the arguments (absence name, reason) or the wrapper's step
// list (only its count).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { chooseTool, MOMENT_TOOL } from './hr-model.js';
import { REFUSAL_CODES } from './peoplesoft-store.js';
import { TIMEOUTS } from './timeouts.js';

const errCode = (err) => err?.cause?.code ?? err?.code;
// PeopleSoft doesn't know this session (it restarted, or dropped it): the request was refused before any tool ran.
const sessionUnknown = (err) => err instanceof StreamableHTTPError && (err.code === 404 || (err.code === 400 && /session/i.test(err.message)));
// The receipt without the wrapper's steps: they never reach the card, the chat, the Professor or telemetry.
export const withoutSteps = (receipt) => {
  if (!receipt || typeof receipt !== 'object') return receipt;
  const { steps, ...rest } = receipt;
  return rest;
};

// The tool call's own minimum (src/timeouts.js): PeopleSoft's planner plus 2 s, so a slow connect can't leave the call
// less time than the planner may take. The connect gets the rest of the shared budget, so the total stays timeoutMs.
const CALL_FLOOR_MS = TIMEOUTS.peoplesoftPlannerMs + 2000;

export function createPeopleSoftLink({ url, token, emit = () => {}, timeoutMs = 20000, callFloorMs = CALL_FLOOR_MS }) {
  const base = String(url ?? '').replace(/\/+$/, '');
  let session = null; // { client, tools }
  let connecting = null;
  let reported = null; // the last session status sent (connected | unreachable)
  const report = (status, extra = {}) => {
    if (reported === status) return;
    reported = status;
    emit('peoplesoft_session', null, { status, ...extra });
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

  function connect(deadline = Date.now() + timeoutMs) {
    if (session) return Promise.resolve(session);
    connecting ??= (async () => {
      const client = new Client({ name: 'hr-agent', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token ?? ''}` } } });
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

  // isClosed(): the caller's own check (HR: the card was closed by a New conversation). Asked before the tool choice
  // and again right before the call, so a card closed meanwhile never reaches PeopleSoft.
  async function call(moment, args, { runId = null, operationId = null, isClosed = () => false } = {}) {
    if (isClosed()) return { ok: false, outcome: 'closed' };
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
    const choice = await chooseTool({ moment, tools: s.tools, emit: (type, data) => emit(type, runId, data) });
    const choiceMs = Date.now() - choiceStart;
    const expected = MOMENT_TOOL[moment];
    // HR's AI didn't answer: not a wrong pick, and nothing was called.
    if (choice.by === 'model_failed') {
      emit('mcp_tool_refused', runId, { tool: null, moment, expected, by: 'model_failed' });
      return { ok: false, outcome: 'tool_choice_failed' };
    }
    if (choice.tool !== expected || !s.tools.includes(expected)) {
      emit('mcp_tool_refused', runId, { tool: choice.tool, moment, expected, by: choice.by });
      return { ok: false, outcome: 'tool_refused' };
    }
    if (isClosed()) return { ok: false, outcome: 'closed' };
    // What the connect left of the budget, counted from now — at least the reserve.
    const deadline = Date.now() + Math.max(reserve, 1, timeoutMs - (Date.now() - connectStart - choiceMs));
    emit('mcp_call_started', runId, { tool: expected, moment, operationId });
    const started = Date.now();
    const done = (r, extra = {}) => {
      emit('mcp_call_result', runId, { tool: expected, moment, ok: r.ok, code: r.code ?? null, outcome: r.ok ? 'ok' : r.outcome, recordId: null, stepCount: null, latencyMs: Date.now() - started, ...extra });
      // The pill follows what really happened: PeopleSoft answered (even a refusal) or nothing reached it.
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
      // Only PeopleSoft's fixed refusal codes pass; anything else is reported without a code (the reason text stays).
      const code = REFUSAL_CODES.includes(value?.code) ? value.code : null;
      const reason = typeof value?.reason === 'string' ? value.reason : 'PeopleSoft could not complete that request.';
      return done({ ok: false, outcome: 'refused', code, reason });
    }
    if (!value || typeof value !== 'object') return done({ ok: false, outcome: 'refused', code: null, reason: 'PeopleSoft could not complete that request.' });
    if (moment === 'submit') {
      const receipt = value.receipt ?? {};
      return done({ ok: true, value: { receipt: withoutSteps(receipt) } }, { recordId: receipt.recordId ?? null, stepCount: Array.isArray(receipt.steps) ? receipt.steps.length : null });
    }
    return done({ ok: true, value });
  }

  return {
    // → value { staffId, vacation, sick, personalHoliday }
    balances: (staffId, { runId } = {}) => call('balances', { staffId }, { runId }),
    // → value { requests: [...] } (newest first)
    requests: (staffId, { runId } = {}) => call('requests', { staffId }, { runId }),
    // values: { absenceType, absenceReason, beginDate, endDate, partial } (checked by HR's code) → value { receipt }
    // isClosed: the card's own check; true → no call (outcome 'closed').
    file: (staffId, values, operationId, { runId, isClosed } = {}) => call('submit', {
      staffId, absenceType: values.absenceType, absenceReason: values.absenceReason, beginDate: values.beginDate, endDate: values.endDate, partial: values.partial ?? null, operationId,
    }, { runId, operationId, isClosed }),
    // Demo reset (New conversation): PeopleSoft's records back to the sample. A plain authorized POST.
    async reset() {
      try {
        const r = await fetch(`${base}/dev/reset`, { method: 'POST', headers: { Authorization: `Bearer ${token ?? ''}` }, signal: AbortSignal.timeout(timeoutMs) });
        return r.ok ? { ok: true } : { ok: false, outcome: 'unavailable' };
      } catch {
        return { ok: false, outcome: 'unavailable' };
      }
    },
    // Test hook passthrough: PeopleSoft's own records (only when PeopleSoft runs with its test hooks).
    async records() {
      const r = await fetch(`${base}/test/records`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error(`PeopleSoft test records: HTTP ${r.status}`);
      return (await r.json()).records;
    },
    // Shutdown: end the MCP session at PeopleSoft (DELETE), then close the client. Best effort and bounded.
    async close() {
      const s = session;
      session = null;
      if (!s) return;
      await Promise.race([s.transport.terminateSession().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
      await s.client.close().catch(() => {});
    },
  };
}
