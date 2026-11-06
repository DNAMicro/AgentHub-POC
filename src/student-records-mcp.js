// PeopleSoft student records stand-in: an MCP server (Streamable HTTP, stateful sessions) over the in-memory roster.
// DEMO STAND-IN, not the real PeopleSoft Campus Solutions. One tool (get_class_roster). Every call needs the bearer token.
// Model proposes, code decides: its own AI (student-records-model.js) only plans optional steps; the store decides
// who may see the roster. Nothing is saved to disk. Never log the token or any student's name, email or ID.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { createStudentRecordsStore, REFUSAL_CODES } from './student-records-store.js';
import { planSteps, studentRecordsStatus, STUDENT_RECORDS_MODE } from './student-records-model.js';
import { apiHost } from './llm.js';

const HOST = '127.0.0.1';
const DEMO = 'Demo stand-in for PeopleSoft Campus Solutions (student records):';
const log = (...a) => console.log('[PeopleSoft Campus Solutions]', ...a);

// Review #5: the required mask_private_fields step, run by code on every roster this server returns. Data minimisation at
// the source: pronouns never leave; the campus ID leaves only as its last 4 digits ("•••••1234"); the campus email leaves
// only when the caller asks for it (includeEmail: the Campus Agent's email fallback, which emails students itself).
export const maskId = (id) => { const d = String(id ?? '').replace(/\D/g, ''); return d.length >= 4 ? `•••••${d.slice(-4)}` : ''; };
export function maskPrivateFields(roster, { includeEmail = false } = {}) {
  return {
    class: roster.class,
    rows: roster.rows.map((r) => ({
      studentId: r.studentId, maskedId: maskId(r.id), name: r.name, units: r.units, program: r.program, plan: r.plan, degree: r.degree, level: r.level,
      ...(includeEmail ? { email: r.email } : {}),
    })),
  };
}

const asResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) });
const refusal = (code, reason) => asResult(REFUSAL_CODES.includes(code) ? { code, reason } : { code: 'tool_error', reason: 'PeopleSoft Campus Solutions could not complete that request.' }, true);

function buildServer(store) {
  const server = new McpServer({ name: 'student-records-demo-standin', version: '1.0.0' });
  server.registerTool('get_class_roster', {
    description: `${DEMO} the class roster (class header plus one row per enrolled student) for one course, for the course's own instructor only. Refuses anyone else. IDs come masked to the last 4 digits; pronouns are never returned; the campus email only with includeEmail.`,
    inputSchema: { courseId: z.string().min(1).max(64), instructorStaffId: z.string().min(1).max(64), includeEmail: z.boolean().optional() },
  }, async ({ courseId, instructorStaffId, includeEmail = false }) => {
    try {
      // Check first (cheap, synchronous); only an allowed request reaches the planner.
      const found = store.roster({ courseId, instructorStaffId });
      if (!found.ok) {
        log(`refused courseId=${courseId} code=${found.code}`);
        return refusal(found.code, found.reason);
      }
      const { steps } = await planSteps({ request: { courseId } });
      log(`roster courseId=${courseId} rows=${found.roster.rows.length} steps=${steps.length}`);
      return asResult({ roster: maskPrivateFields(found.roster, { includeEmail }), steps, stepCount: steps.length });
    } catch {
      log('error');
      return refusal('tool_error');
    }
  });
  return server;
}

export function startStudentRecordsServer({ port = 41249, token = process.env.STUDENT_RECORDS_TOKEN } = {}) {
  if (!token) return Promise.reject(new Error('STUDENT_RECORDS_TOKEN is required: set it to any secret string.'));
  const want = Buffer.from(`Bearer ${token}`);
  const authorized = (req) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === want.length && timingSafeEqual(got, want);
  };
  return new Promise((resolve, reject) => {
    const store = createStudentRecordsStore();
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
      if (process.env.STUDENT_RECORDS_TEST_HOOKS === '1') {
        app.get('/test/state', (req, res) => res.json({ rosterRows: store.rosterSize() }));
        // Review C13: add/drop activity between two sends (tests only). { dropped: [studentId, …] } replaces the dropped set.
        app.post('/test/enrollment', express.json({ limit: '16kb' }), (req, res) => {
          const ids = Array.isArray(req.body?.dropped) ? req.body.dropped.filter((x) => typeof x === 'string') : [];
          res.json({ rosterRows: store.setDropped(ids) });
        });
      }

      const baseUrl = `http://${HOST}:${actualPort}`;
      console.log(`PeopleSoft Campus Solutions MCP server (demo stand-in) listening on ${baseUrl}`);
      const st = studentRecordsStatus();
      log(`mode: ${STUDENT_RECORDS_MODE}, planner: ${st.model}`);
      if (STUDENT_RECORDS_MODE === 'live') log(`API host: ${apiHost()}`);
      resolve({ server, baseUrl, close: () => new Promise((r) => { for (const e of sessions.values()) e.transport.close?.(); server.close(r); server.closeAllConnections?.(); }) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStudentRecordsServer({ port: Number(process.env.PORT ?? 41249) }).then(({ close }) => {
    // close() ends every MCP session and open connection (a client's SSE stream would otherwise keep
    // server.close() waiting forever); bounded, then exit.
    const stop = () => Promise.race([close(), new Promise((r) => setTimeout(r, 1000))]).then(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }).catch((e) => { console.error(`Student records stand-in could not start: ${e.message}`); process.exit(1); });
}
