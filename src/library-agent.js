// Library Agent — a separate A2A service. Answers ONLY from the saved "answer content" of its
// enabled skills (src/library-model.js): mock mode extracts matching lines deterministically;
// live mode uses Claude Haiku 5.5 with code-verified evidence. It performs no transactions.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Role, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { hostGuard } from './local-guard.js';
import { createSkillService } from './agent-settings.js';
import { LlmError, apiHost } from './llm.js';
import { LIBRARY_DEFAULT_SKILLS } from './library-fixture.js';
import { LIBRARY_MODE, answerFromKnowledge, libraryStatus } from './library-model.js';

export { LIBRARY_DEFAULT_SKILLS };

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const VIZ_PATH = '/viz/events';
const STUDENT_A2A_URL = process.env.STUDENT_A2A_URL ?? 'http://127.0.0.1:41240';
const MAX_LEDGER = 500;

const log = (...args) => console.log('[Library Agent]', ...args);
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'library', type, runId, at: new Date().toISOString(), data });
const textOf = (message) => message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

// Every Library skill is answered from its own saved content, so that content is required.
const LIBRARY_RULES = { answer: { knowledge: 'required' } };
const LOG_CONTENT = process.env.LIBRARY_LOG_CONTENT !== undefined ? process.env.LIBRARY_LOG_CONTENT === '1' : LIBRARY_MODE !== 'live';

let skillService = null;
const ledger = new Map(); // `${contextId}|${messageId}` → Promise<result>; a repeat request reuses it (no second paid call)

async function answerOnce(ctx, question, runId) {
  const key = `${ctx.contextId}|${ctx.userMessage.messageId}`;
  if (ledger.has(key)) {
    emitViz('model_call_reused', runId, { contextId: ctx.contextId, messageId: ctx.userMessage.messageId });
    return { ...(await ledger.get(key)), duplicate: true };
  }
  const promise = (async () => {
    const policy = skillService.policy();
    const result = await answerFromKnowledge({ question, policy, emit: (type, data) => emitViz(type, runId, data) });
    // Release check: skills changed while answering → don't release under the old policy.
    if (skillService.revision() !== policy.revision) return { ...result, verdict: 'changed', text: 'The Library Agent’s skills changed while your question was being answered, so that answer wasn’t released. Please ask again.', policyRevision: skillService.revision() };
    return { ...result, policyRevision: policy.revision };
  })();
  ledger.set(key, promise);
  promise.catch(() => {});
  if (ledger.size > MAX_LEDGER) ledger.delete(ledger.keys().next().value);
  return promise;
}

const reply = (ctx, text, metadata) => ({
  messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT,
  parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata, extensions: [], referenceTaskIds: [],
});

const libraryExecutor = {
  async execute(ctx, bus) {
    const incoming = ctx.userMessage;
    const runId = incoming.metadata?.runId ?? null;
    const question = textOf(incoming).slice(0, 2000);
    const received = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId, text: question };
    log('received message', LOG_CONTENT ? received : { ...received, text: `[${question.length} chars, content not logged]` });
    emitViz('message_received', runId, received);

    const metadata = { ...(runId ? { runId } : {}), agentId: 'library' };
    let text;
    try {
      const r = await answerOnce(ctx, question, runId);
      emitViz('scope_checked', runId, { stage: 'request', verdict: r.verdict, skillId: r.skillId ?? null, policyRevision: r.policyRevision, evidenceLines: r.evidence.length });
      text = r.verdict === 'answered' ? `${r.text}\n\n(From the Library Agent’s saved information.)` : r.text;
      metadata.library = { outcome: r.verdict, skillId: r.skillId ?? null, policyRevision: r.policyRevision, mode: LIBRARY_MODE, model: r.model, usage: r.usage, requestId: r.requestId ?? null, evidence: r.evidence, duplicate: Boolean(r.duplicate) };
    } catch (err) {
      const failure = err instanceof LlmError ? err : new LlmError('internal_error');
      text = `The Library Agent could not answer: ${failure.message}`;
      metadata.serviceError = { code: failure.code, message: failure.message, requestId: failure.requestId };
      if (failure.rateLimit) log('rate limit details', failure.rateLimit);
    }
    const message = reply(ctx, text, metadata);
    const sent = { messageId: message.messageId, contextId: message.contextId, inReplyTo: incoming.messageId, text, library: metadata.library, serviceError: metadata.serviceError };
    log('sending reply', LOG_CONTENT ? sent : { ...sent, text: `[${text.length} chars, content not logged]` });
    bus.publish(AgentEvent.message(message));
    bus.finished();
    emitViz('reply_published', runId, sent);
  },
  async cancelTask() {},
};

function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ source: 'library', type: 'status', runId: null, at: new Date().toISOString(), data: { ...libraryStatus(), skills: skillService?.describe() ?? null } })}\n\n`);
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

function buildAgentCard(port) {
  return {
    name: 'Library Agent',
    description: 'Library help from its saved information (fictional sample data by default): hours, borrowing, renewal and return guidance, and finding resources. Guidance only — no real transactions.',
    version: '0.1.0',
    supportedInterfaces: [{ url: `http://${HOST}:${port}${JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }],
    provider: undefined,
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
    signatures: [],
  };
}

export function startLibraryServer({ port = 41242 } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      const baseUrl = `http://${HOST}:${actualPort}`;
      const card = buildAgentCard(actualPort);
      skillService = createSkillService({
        agentId: 'library', agentName: card.name, defaults: LIBRARY_DEFAULT_SKILLS, rules: LIBRARY_RULES, card,
        emit: (type, data) => emitViz(type, null, data), log, studentUrl: STUDENT_A2A_URL,
      });
      const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), libraryExecutor);
      app.use(hostGuard(actualPort));
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.get(VIZ_PATH, serveVizEvents);
      app.use(skillService.router());
      skillService.started(actualPort, `${baseUrl}/${AGENT_CARD_PATH}`);
      resolve({ server, baseUrl });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT === undefined ? 41242 : Number(process.env.PORT);
  const { baseUrl } = await startLibraryServer({ port });
  log(`listening on ${baseUrl}`);
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
  const s = libraryStatus();
  log(`mode: ${s.mode} (${s.model})${s.mode === 'live' ? `, API key: ${s.keyConfigured ? 'configured' : 'NOT SET'}, API host: ${apiHost()}` : ''}, answers only from saved skill content`);
}
