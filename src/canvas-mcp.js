// Canvas LMS stand-in: an MCP server (Streamable HTTP, stateful sessions) over the in-memory Canvas quiz store.
// DEMO STAND-IN, not real Canvas. Two tools. Every call needs the bearer token.
// Model proposes, code decides: Canvas's own AI (canvas-model.js) only plans optional steps; the store decides
// checks and pass/fail. Nothing is saved to disk. Never log the token, a question, an answer or a title.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { hostGuard, sameOriginGuard } from './local-guard.js';
import { createCanvasStore, CANVAS_REFUSAL_CODES } from './canvas-store.js';
import { planSteps, canvasStatus, CANVAS_MODE } from './canvas-model.js';
import { apiHost } from './llm.js';

const HOST = '127.0.0.1';
const DEMO = 'Demo stand-in for Canvas LMS:';
const PUBLISH_STEPS = ['check_quiz_exists', 'set_published'];
const log = (...a) => console.log('[Canvas]', ...a);

const asResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) });
// Refusals are only the fixed codes. An unexpected store error is NOT a refusal: it is rethrown, the SDK answers an
// error, and the caller treats a thrown call as uncertain.
const refusal = (code, reason) => asResult({ code, reason }, true);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function buildServer(store, stepsByOp) {
  const server = new McpServer({ name: 'canvas-demo-standin', version: '1.0.0' });
  const courseId = z.string().min(1).max(64);
  const operationId = z.string().regex(/^[\w-]{6,80}$/);
  // Test hook only: answer a NEW create this many ms late (after the quiz is written), so a caller's timeout leaves
  // an outcome it can't know; a repeat of the same operationId answers at once.
  const lateMs = process.env.CANVAS_TEST_HOOKS === '1' ? Number(process.env.CANVAS_TEST_DELAY_MS ?? 0) : 0;

  server.registerTool('create_quiz', {
    description: `${DEMO} save one multiple-choice quiz as an unpublished draft (students can't see it). Canvas checks the questions, settings and due date itself and returns a receipt or a refusal code. Safe to repeat with the same operationId.`,
    // quiz is checked by the store (a bad one is a bad_question / bad_settings refusal, never a crash).
    inputSchema: { courseId, quiz: z.any(), operationId },
  }, async ({ courseId: course, quiz, operationId: op }) => {
    try {
      if (!isObject(quiz) || !Array.isArray(quiz.questions)) { log(`refused operationId=${op} code=bad_question`); return refusal('bad_question', 'The quiz is not in the expected shape.'); }
      // A known operationId skips the planner: same values give the stored receipt, different values operation_reused.
      // The reset generation is read before the planner's await: a New conversation during it refuses this save
      // (reset_during_call) instead of writing the old quiz into the fresh store.
      const again = stepsByOp.has(op);
      const generation = store.generation();
      const steps = again ? stepsByOp.get(op) : (await planSteps({ quiz })).steps;
      const result = store.create({ courseId: course, quiz, operationId: op, generation: again ? undefined : generation });
      if (!result.ok) {
        log(`refused operationId=${op} code=${result.code}`);
        return refusal(result.code, result.reason);
      }
      stepsByOp.set(op, steps);
      log(`created operationId=${op} quizId=${result.quiz.quizId} steps=${steps.length}${again ? ' (repeat)' : ''}`);
      if (!again && lateMs > 0) await new Promise((r) => setTimeout(r, lateMs));
      return asResult({ receipt: { ...result.quiz, steps, stepCount: steps.length } });
    } catch (err) {
      log(`error operationId=${op}`);
      throw err;
    }
  });

  server.registerTool('publish_quiz', {
    description: `${DEMO} publish a saved quiz so students can see it. Safe to repeat with the same operationId.`,
    inputSchema: { courseId, quizId: z.number().int().positive(), operationId },
  }, async ({ courseId: course, quizId, operationId: op }) => {
    try {
      const result = store.publish({ courseId: course, quizId, operationId: op });
      if (!result.ok) {
        log(`refused operationId=${op} code=${result.code}`);
        return refusal(result.code, result.reason);
      }
      log(`published operationId=${op} quizId=${result.quiz.quizId}`);
      return asResult({ receipt: { ...result.quiz, steps: PUBLISH_STEPS, stepCount: PUBLISH_STEPS.length } });
    } catch (err) {
      log(`error operationId=${op}`);
      throw err;
    }
  });
  return server;
}

export function startCanvasServer({ port = 41247, token = process.env.CANVAS_TOKEN } = {}) {
  if (!token) return Promise.reject(new Error('CANVAS_TOKEN is required: set it to any secret string.'));
  // Test hook only: CANVAS_NOW (ISO) pins "today" so tests judge dates like the Faculty agent's pinned date.
  // Production (no CANVAS_TEST_HOOKS) ignores it.
  let clock = null;
  if (process.env.CANVAS_TEST_HOOKS === '1' && process.env.CANVAS_NOW) {
    clock = Date.parse(process.env.CANVAS_NOW);
    if (Number.isNaN(clock)) return Promise.reject(new Error('CANVAS_NOW must be an ISO date-time such as 2026-11-04T18:00:00Z.'));
  }
  const want = Buffer.from(`Bearer ${token}`);
  const authorized = (req) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === want.length && timingSafeEqual(got, want);
  };
  return new Promise((resolve, reject) => {
    const store = createCanvasStore(clock ? { now: () => new Date(clock) } : {});
    const stepsByOp = new Map();
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
            const mcp = buildServer(store, stepsByOp);
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

      app.post('/dev/reset', sameOriginGuard(actualPort), needToken, (req, res) => { store.reset(); stepsByOp.clear(); log('reset'); res.json({ status: 'reset' }); });
      if (process.env.CANVAS_TEST_HOOKS === '1') app.get('/test/quizzes', (req, res) => res.json({ quizzes: store.list() }));

      const baseUrl = `http://${HOST}:${actualPort}`;
      console.log(`Canvas LMS MCP server (demo stand-in) listening on ${baseUrl}`);
      const st = canvasStatus();
      log(`mode: ${CANVAS_MODE}, planner: ${st.model}`);
      if (CANVAS_MODE === 'live') log(`API host: ${apiHost()}`);
      resolve({ server, baseUrl, close: () => new Promise((r) => { for (const e of sessions.values()) e.transport.close?.(); server.close(r); server.closeAllConnections?.(); }) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startCanvasServer({ port: Number(process.env.PORT ?? 41247) }).then(({ close }) => {
    // close() ends every MCP session and open connection (a client's SSE stream would otherwise keep
    // server.close() waiting forever); bounded, then exit.
    const stop = () => Promise.race([close(), new Promise((r) => setTimeout(r, 1000))]).then(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }).catch((e) => { console.error(`Canvas stand-in could not start: ${e.message}`); process.exit(1); });
}
