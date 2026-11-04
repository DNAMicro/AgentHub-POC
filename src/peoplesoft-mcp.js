// PeopleSoft stand-in: an MCP server (Streamable HTTP, stateful sessions) over the in-memory PeopleSoft store.
// DEMO STAND-IN, not the real PeopleSoft. Three tools. Every call needs the bearer token.
// Model proposes, code decides: PeopleSoft's own AI (peoplesoft-model.js) only plans optional steps; the store
// decides dates, hours, balances and pass/fail. Nothing is saved to disk. Never log the token, the absence name,
// the reason or the note.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { createPeopleSoftStore, REFUSAL_CODES } from './peoplesoft-store.js';
import { planSteps, peoplesoftStatus, PEOPLESOFT_MODE } from './peoplesoft-model.js';
import { apiHost } from './llm.js';

const HOST = '127.0.0.1';
const DEMO = 'Demo stand-in for PeopleSoft:';
const log = (...a) => console.log('[PeopleSoft]', ...a);

const asResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) });
const refusal = (code, reason) => asResult(REFUSAL_CODES.includes(code) ? { code, reason } : { code: 'tool_error', reason: 'PeopleSoft could not complete that request.' }, true);

function buildServer(store) {
  const server = new McpServer({ name: 'peoplesoft-demo-standin', version: '1.0.0' });
  const staffId = z.string().min(1).max(64);
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'not a real date');
  // Test hook only: answer a NEW filing this many ms late (after the record is written), so a caller's
  // timeout leaves an outcome it can't know; a repeat of the same operationId answers at once.
  const lateMs = process.env.PEOPLESOFT_TEST_HOOKS === '1' ? Number(process.env.PEOPLESOFT_TEST_DELAY_MS ?? 0) : 0;

  server.registerTool('get_leave_balances', {
    description: `${DEMO} the leave balances (hours) for one staff member: vacation, sick, personal holiday.`,
    inputSchema: { staffId },
  }, async ({ staffId: id }) => {
    const b = store.balances(id);
    if (!b) return refusal('unknown_staff', 'Unknown staff member.');
    return asResult({ staffId: id, vacation: b.vacation, sick: b.sick, personalHoliday: b.personalHoliday });
  });

  server.registerTool('list_absence_requests', {
    description: `${DEMO} the time-off requests already filed for one staff member, newest first.`,
    inputSchema: { staffId },
  }, async ({ staffId: id }) => {
    if (!store.staff(id)) return refusal('unknown_staff', 'Unknown staff member.');
    return asResult({ requests: store.requests(id) });
  });

  server.registerTool('create_absence_request', {
    description: `${DEMO} file one time-off request. PeopleSoft checks the balance, dates, holidays and overlaps itself and returns a receipt or a refusal code. Safe to repeat with the same operationId.`,
    inputSchema: {
      staffId,
      absenceType: z.string().min(1).max(16),
      absenceReason: z.string().min(1).max(32),
      beginDate: date,
      endDate: date,
      partial: z.object({ mode: z.enum(['start_day_only', 'all_days']), hours: z.number().positive().max(24) }).nullable(),
      operationId: z.string().min(1).max(128),
    },
  }, async ({ staffId: id, absenceType, absenceReason, beginDate, endDate, partial, operationId }) => {
    try {
      const values = { absenceType, absenceReason, beginDate, endDate, partial };
      // A repeat returns the stored result without asking the model again. Two concurrent calls with the same NEW
      // operationId could both reach the model; file() is synchronous and still records only once.
      // A known operationId goes straight to file(): same values give the stored receipt, different values give
      // operation_reused.
      const again = store.stored(operationId);
      let result;
      if (again) result = store.file(id, values, operationId, []);
      else {
        // Plan from the code's own view of the request (hours from the store's plan, when it can compute them).
        const p = store.plan(id, values);
        const { steps } = await planSteps({ request: { absenceType, beginDate, endDate, hours: p.hours ?? null } });
        result = store.file(id, values, operationId, steps);
      }
      if (!result.ok) {
        log(`refused operationId=${operationId} staffId=${id} code=${result.code}`);
        return refusal(result.code, result.reason);
      }
      log(`filed operationId=${operationId} recordId=${result.receipt.recordId} staffId=${id} steps=${result.receipt.steps.length}${again ? ' (repeat)' : ''}`);
      if (!again && lateMs > 0) await new Promise((r) => setTimeout(r, lateMs));
      return asResult({ receipt: result.receipt });
    } catch {
      log(`error operationId=${operationId}`);
      return refusal('tool_error');
    }
  });
  return server;
}

export function startPeopleSoftServer({ port = 41246, token = process.env.PEOPLESOFT_TOKEN } = {}) {
  if (!token) return Promise.reject(new Error('PEOPLESOFT_TOKEN is required: set it to any secret string.'));
  const want = Buffer.from(`Bearer ${token}`);
  const authorized = (req) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === want.length && timingSafeEqual(got, want);
  };
  return new Promise((resolve, reject) => {
    const store = createPeopleSoftStore();
    const app = express();
    const sessions = new Map(); // sessionId -> { transport, server }
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      app.use(hostGuard(actualPort));
      const needToken = (req, res, next) => (authorized(req) ? next() : res.status(401).json({ error: 'unauthorized' }));
      const fail = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

      app.post('/mcp', needToken, express.json({ limit: '64kb' }), async (req, res) => {
        try {
          const sid = req.headers['mcp-session-id'];
          let entry = sid ? sessions.get(sid) : null;
          if (!entry) {
            if (sid || !isInitializeRequest(req.body)) return fail(res, 400, 'No valid session.');
            const mcp = buildServer(store);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => sessions.set(id, { transport, server: mcp }),
            });
            transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
            await mcp.connect(transport);
            entry = { transport };
          }
          await entry.transport.handleRequest(req, res, req.body);
        } catch {
          if (!res.headersSent) fail(res, 500, 'Internal error.');
        }
      });
      const session = async (req, res) => {
        const entry = sessions.get(req.headers['mcp-session-id']);
        if (!entry) return fail(res, 400, 'No valid session.');
        await entry.transport.handleRequest(req, res);
      };
      app.get('/mcp', needToken, session);
      app.delete('/mcp', needToken, session);

      // Malformed JSON (or any other late error) gets a plain JSON answer, never HTML or a stack trace.
      app.use((err, req, res, next) => (res.headersSent ? next(err) : res.status(err?.status === 413 ? 413 : 400).json({ error: 'bad_request' })));

      app.post('/dev/reset', sameOriginGuard(actualPort), needToken, (req, res) => { store.reset(); log('reset'); res.json({ status: 'reset' }); });
      if (process.env.PEOPLESOFT_TEST_HOOKS === '1') app.get('/test/records', (req, res) => res.json({ records: store._records() }));

      const baseUrl = `http://${HOST}:${actualPort}`;
      console.log(`PeopleSoft MCP server (demo stand-in) listening on ${baseUrl}`);
      const st = peoplesoftStatus();
      log(`mode: ${PEOPLESOFT_MODE}, planner: ${st.model}`);
      if (PEOPLESOFT_MODE === 'live') log(`API host: ${apiHost()}`);
      resolve({ server, baseUrl, close: () => new Promise((r) => { for (const e of sessions.values()) e.transport.close?.(); server.close(r); server.closeAllConnections?.(); }) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startPeopleSoftServer({ port: Number(process.env.PORT ?? 41246) }).then(({ close }) => {
    // close() ends every MCP session and open connection (a client's SSE stream would otherwise keep
    // server.close() waiting forever); bounded, then exit.
    const stop = () => Promise.race([close(), new Promise((r) => setTimeout(r, 1000))]).then(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }).catch((e) => { console.error(`PeopleSoft stand-in could not start: ${e.message}`); process.exit(1); });
}
