// Part 15: the HR Agent's link to PeopleSoft (the DEMO STAND-IN, src/peoplesoft-mcp.js) over MCP (Streamable
// HTTP). HR keeps no copy of the staff data: balances, filed requests and records live in PeopleSoft.
//
// Every call: tools/list (cached per connection) → HR's AI chooses the tool for this moment (chooseTool) →
// code accepts only the moment's own tool (otherwise no call at all) → tools/call with arguments built by
// code → a plain outcome:
//   { ok: true, value }                              PeopleSoft answered
//   { ok: false, outcome: 'refused', code, reason }  PeopleSoft refused it (code from its fixed set)
//   { ok: false, outcome: 'tool_refused' }           HR's AI picked another tool: nothing was called
//   { ok: false, outcome: 'unavailable' }            nothing reached the tool (connection refused, 401, no session)
//   { ok: false, outcome: 'uncertain' }              the call went out but no answer came (timeout, reset)
// Never an automatic retry, with one exception: PeopleSoft said the session is unknown (HTTP 404, or 400 about the
// session — e.g. it restarted), so the tool provably never ran; the link reconnects and sends that call once more.
// Anything else is the caller's to retry (with the same operationId; PeopleSoft dedupes it).
//
// Telemetry (emit(type, runId, data)): peoplesoft_session (run-less), mcp_tool_refused, mcp_call_started,
// mcp_call_result. Tool names, codes, record ids, counts and timings only — never the token, the arguments
// (absence name, reason) or the wrapper's step list (only its count).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { chooseTool, MOMENT_TOOL } from './hr-model.js';
import { REFUSAL_CODES } from './peoplesoft-store.js';

const errCode = (err) => err?.cause?.code ?? err?.code;
// PeopleSoft doesn't know this session (it restarted, or dropped it): the request was refused before any tool ran.
const sessionUnknown = (err) => err instanceof StreamableHTTPError && (err.code === 404 || (err.code === 400 && /session/i.test(err.message)));
// The receipt without the wrapper's steps: they never reach the card, the chat, the Professor or telemetry.
export const withoutSteps = (receipt) => {
  if (!receipt || typeof receipt !== 'object') return receipt;
  const { steps, ...rest } = receipt;
  return rest;
};

export function createPeopleSoftLink({ url, token, emit = () => {}, timeoutMs = 20000 }) {
  const base = String(url ?? '').replace(/\/+$/, '');
  let session = null; // { client, tools }
  let connecting = null;

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
        emit('peoplesoft_session', null, { status: 'connected', tools: s.tools.length });
        return s;
      } catch (err) {
        client.close().catch(() => {});
        emit('peoplesoft_session', null, { status: 'unreachable' });
        throw err;
      }
    })().finally(() => { connecting = null; });
    return connecting;
  }

  async function call(moment, args, { runId = null, operationId = null } = {}) {
    // Budget (src/timeouts.js): the tool choice has its own limit; connect + the tool call share ONE (timeoutMs), which
    // starts when connecting starts but is re-based after the tool choice so a slow choice never shortens the call.
    const connectStart = Date.now();
    let s;
    try {
      s = await connect(connectStart + timeoutMs);
    } catch {
      return { ok: false, outcome: 'unavailable' };
    }
    const choiceStart = Date.now();
    const choice = await chooseTool({ moment, tools: s.tools, emit: (type, data) => emit(type, runId, data) });
    const choiceMs = Date.now() - choiceStart;
    const expected = MOMENT_TOOL[moment];
    if (choice.tool !== expected || !s.tools.includes(expected)) {
      emit('mcp_tool_refused', runId, { tool: choice.tool, moment, expected, by: choice.by });
      return { ok: false, outcome: 'tool_refused' };
    }
    // What the connect left of the budget (at least 1 s), counted from now.
    const deadline = Date.now() + Math.max(1000, timeoutMs - (Date.now() - connectStart - choiceMs));
    emit('mcp_call_started', runId, { tool: expected, moment, operationId });
    const started = Date.now();
    const done = (r, extra = {}) => {
      emit('mcp_call_result', runId, { tool: expected, moment, ok: r.ok, code: r.code ?? null, outcome: r.ok ? 'ok' : r.outcome, recordId: null, stepCount: null, latencyMs: Date.now() - started, ...extra });
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
    file: (staffId, values, operationId, { runId } = {}) => call('submit', {
      staffId, absenceType: values.absenceType, absenceReason: values.absenceReason, beginDate: values.beginDate, endDate: values.endDate, partial: values.partial ?? null, operationId,
    }, { runId, operationId }),
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
