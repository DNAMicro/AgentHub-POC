// Library Agent — a separate A2A service. Deterministic: answers come from the fictional
// sample fixture (src/library-fixture.js) through fixed handlers; no model is called.
//
// Scope enforcement is code-level: a question is served only by a handler whose skill is
// currently enabled. Anything else gets a short scope reply listing what it does offer.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Role, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { hostGuard } from './local-guard.js';
import { createSkillService } from './agent-settings.js';
import { LIBRARY_HANDLER_IMPLS, SAMPLE_NOTE, matchHandlers } from './library-fixture.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const VIZ_PATH = '/viz/events';
const STUDENT_A2A_URL = process.env.STUDENT_A2A_URL ?? 'http://127.0.0.1:41240';

const log = (...args) => console.log('[Library Agent]', ...args);
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'library', type, runId, at: new Date().toISOString(), data });
const textOf = (message) => message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

// A skill can only use a handler implemented above. That's how the Library refuses to
// advertise a capability its fixture can't actually provide.
const LIBRARY_HANDLERS = Object.fromEntries(Object.entries(LIBRARY_HANDLER_IMPLS).map(([id, h]) => [id, { label: h.label }]));

const skill = (id, handler, name, description, tags, examples, allowed, excluded = ['tutoring or explaining subjects such as calculus', 'real account actions (no renewals or holds are performed)']) =>
  ({ id, handler, enabled: true, name, description, tags, examples, scope: { allowed, excluded } });

export const LIBRARY_DEFAULT_SKILLS = {
  skills: [
    skill('library-hours', 'library-hours', 'Library hours', 'Opening hours of the (fictional) sample library.', ['library', 'hours', 'opening times'], ['When is the library open on Sunday?'], ['opening and closing hours']),
    skill('borrowing', 'borrowing-guidance', 'Borrowing', 'How borrowing works: library card, loan periods, item limits.', ['library', 'borrowing', 'loans', 'checkout'], ['How long can I borrow a book?'], ['how to borrow items', 'loan periods and limits']),
    skill('renewals', 'renewal-guidance', 'Renewals guidance', 'How to renew borrowed items yourself. Guidance only; it cannot renew items.', ['library', 'renewals', 'renew'], ['How do I renew a borrowed book?'], ['how renewals work and how to do them yourself']),
    skill('returns', 'returns-guidance', 'Returns guidance', 'Where and how to return items, and overdue fees.', ['library', 'returns', 'overdue'], ['Where do I return a book after hours?'], ['how and where to return items', 'overdue fees']),
    skill('find-resources', 'resource-finding', 'Finding library resources', 'Searches a small sample catalog for books and resources by subject, with call numbers and locations.', ['library', 'catalog', 'books', 'textbooks', 'find resources'], ['Where can I find a calculus textbook?'], ['finding books and resources in the sample catalog']),
  ],
};

let skillService = null;

const reply = (ctx, text, metadata) => ({
  messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT,
  parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
  metadata, extensions: [], referenceTaskIds: [],
});

// Decide from the current policy and the fixture handlers. Returns { verdict, handler?, text }.
function decide(question) {
  const policy = skillService.policy();
  if (!policy.skills.length) return { verdict: 'disabled', text: 'The Library Agent has no skills enabled right now, so it isn’t answering questions.' };
  const offered = policy.skills.map((s) => s.name).join(', ');
  const found = matchHandlers(question);
  if (found.length > 1) {
    const names = found.map((h) => policy.skills.find((s) => s.handler === h)?.name ?? h);
    return { verdict: 'needs_clarification', text: `Which would you like first: ${names.join(' or ')}?` };
  }
  if (!found.length) return { verdict: 'out_of_scope', text: `That’s outside what the Library Agent offers. I can help with: ${offered}.` };
  const handler = found[0];
  const enabled = policy.skills.find((s) => s.handler === handler);
  if (!enabled) return { verdict: 'skill_disabled', handler, text: `That service isn’t offered right now. I can help with: ${offered}.` };
  return { verdict: 'in_scope', handler, skillId: enabled.id, text: `${LIBRARY_HANDLER_IMPLS[handler].respond(question.toLowerCase())}\n\n(${SAMPLE_NOTE})` };
}

const libraryExecutor = {
  async execute(ctx, bus) {
    const incoming = ctx.userMessage;
    const runId = incoming.metadata?.runId ?? null;
    const question = textOf(incoming).slice(0, 2000);
    const received = { messageId: incoming.messageId, contextId: ctx.contextId, taskId: ctx.taskId, text: question };
    log('received message', received);
    emitViz('message_received', runId, received);

    const policyRevision = skillService.revision();
    const decision = decide(question);
    emitViz('scope_checked', runId, { stage: 'request', verdict: decision.verdict, handler: decision.handler ?? null, policyRevision });
    const metadata = { ...(runId ? { runId } : {}), agentId: 'library', library: { outcome: decision.verdict, handler: decision.handler ?? null, skillId: decision.skillId ?? null, policyRevision } };
    const message = reply(ctx, decision.text, metadata);
    const sent = { messageId: message.messageId, contextId: message.contextId, inReplyTo: incoming.messageId, text: decision.text, library: metadata.library };
    log('sending reply', sent);
    bus.publish(AgentEvent.message(message));
    bus.finished();
    emitViz('reply_published', runId, sent);
  },
  async cancelTask() {},
};

function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ source: 'library', type: 'status', runId: null, at: new Date().toISOString(), data: { mode: 'deterministic', model: null, skills: skillService?.describe() ?? null } })}\n\n`);
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

function buildAgentCard(port) {
  return {
    name: 'Library Agent',
    description: 'Library help from a fictional sample fixture: hours, borrowing, renewal and return guidance, and finding resources. Guidance only — no real transactions.',
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
        agentId: 'library', agentName: card.name, defaults: LIBRARY_DEFAULT_SKILLS, handlers: LIBRARY_HANDLERS, card,
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
  log('mode: deterministic (fictional sample fixture, no model)');
}
