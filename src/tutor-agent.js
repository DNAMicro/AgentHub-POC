// Agent B — "Tutor Agent". An A2A server: publishes an Agent Card and answers
// `SendMessage` over the JSON-RPC binding. Replies are deterministic (no LLM).
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Role, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
export const TUTOR_REPLY = 'Hello Student Agent. Yes, I can help you with calculus.';

const VIZ_PATH = '/viz/events';

const log = (...args) => console.log('[Tutor Agent]', ...args);

// Visualization-only feed. Events are emitted from the executor at the moment
// they actually happen; nothing here carries or replaces A2A traffic.
const vizEvents = new EventEmitter();
const emitViz = (type, runId, data) => vizEvents.emit('event', { source: 'tutor', type, runId, at: new Date().toISOString(), data });
const textOf = (message) =>
  message.parts.filter((p) => p.content?.$case === 'text').map((p) => p.content.value).join('');

function buildAgentCard(port) {
  return {
    name: 'Tutor Agent',
    description: 'Deterministic tutor used to verify A2A connectivity.',
    version: '0.1.0',
    supportedInterfaces: [
      {
        url: `http://${HOST}:${port}${JSONRPC_PATH}`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: '',
      },
    ],
    provider: undefined,
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'calculus-help',
        name: 'Calculus help',
        description: 'Confirms it can help with calculus.',
        tags: ['calculus'],
        examples: ['Can you help me with calculus?'],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

// The agent's business logic. The SDK calls execute() for every incoming message.
const tutorExecutor = {
  async execute(requestContext, eventBus) {
    const incoming = requestContext.userMessage;
    // Set by the UI's Student Agent so visualization events can be correlated; absent for CLI runs.
    const runId = incoming.metadata?.runId ?? null;
    const received = {
      messageId: incoming.messageId,
      contextId: requestContext.contextId,
      taskId: requestContext.taskId,
      text: textOf(incoming),
    };
    log('received message', received);
    emitViz('message_received', runId, received);

    const reply = {
      messageId: randomUUID(),
      contextId: requestContext.contextId,
      taskId: '', // direct Message reply: no Task is created
      role: Role.ROLE_AGENT,
      parts: [{ content: { $case: 'text', value: TUTOR_REPLY }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: runId ? { runId } : undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    const sent = { messageId: reply.messageId, contextId: reply.contextId, inReplyTo: incoming.messageId, text: TUTOR_REPLY };
    log('sending reply', sent);

    eventBus.publish(AgentEvent.message(reply));
    eventBus.finished();
    // The SDK now returns `reply` as the JSON-RPC result; delivery is confirmed by the Student, not here.
    emitViz('reply_published', runId, sent);
  },
  async cancelTask() {
    // Nothing long-running to cancel: every reply is immediate.
  },
};

// Server-sent events stream of vizEvents. Live only: no replay, no inputs.
function serveVizEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const forward = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  vizEvents.on('event', forward);
  req.on('close', () => vizEvents.off('event', forward));
}

export function startTutorServer({ port = 41241 } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    // Routes are mounted after listen() so the Agent Card carries the real port
    // (tests pass port 0 to get a free ephemeral port).
    const server = app.listen(port, HOST, () => {
      const actualPort = server.address().port;
      const requestHandler = new DefaultRequestHandler(buildAgentCard(actualPort), new InMemoryTaskStore(), tutorExecutor);
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      app.get(VIZ_PATH, serveVizEvents);
      resolve({ server, baseUrl: `http://${HOST}:${actualPort}` });
    });
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT === undefined ? 41241 : Number(process.env.PORT);
  const { baseUrl } = await startTutorServer({ port });
  log(`listening on ${baseUrl}`);
  log(`Agent Card: ${baseUrl}/${AGENT_CARD_PATH}`);
}
