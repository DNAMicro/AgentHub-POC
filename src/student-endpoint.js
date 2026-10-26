// Student Agent's A2A receiving endpoint (the reverse path). It accepts exactly one kind of
// message: our application-level "agent_card_changed" notification. This is a convention
// carried by A2A, not a built-in A2A broadcast. It's handled by code — never by a model.
//
// A notification is only a hint to refresh: Student re-fetches the card from the URL in its
// trusted registry. It never applies skills from the message, never follows a URL in it, and
// never treats it as a permission grant.
//
// Sender identification (localhost spike): the agentId in the message is a CLAIM, not
// authentication. Any local process could send one. The design limits the damage to a
// harmless re-fetch of a registered card (deduplicated and coalesced).
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Role, AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { hostGuard } from './local-guard.js';
import { CARD_CHANGED_MEDIA_TYPE } from './skills.js';

const HOST = '127.0.0.1';
const JSONRPC_PATH = '/a2a/jsonrpc';
const NOTICE_KEYS = ['type', 'notificationId', 'agentId', 'revision', 'reason', 'changedAt'];
const MAX_SEEN = 500;

export function startStudentEndpoint({ port, registry, emit }) {
  const seen = new Set(); // notificationIds already handled

  function ack(ctx, status, extra = {}) {
    return {
      messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT,
      parts: [{ content: { $case: 'data', value: { status, ...extra } }, metadata: undefined, filename: '', mediaType: 'application/json' }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    };
  }

  const executor = {
    async execute(ctx, bus) {
      const respond = (status, extra) => {
        bus.publish(AgentEvent.message(ack(ctx, status, extra)));
        bus.finished();
      };
      const part = ctx.userMessage.parts.find((p) => p.content?.$case === 'data' && p.mediaType === CARD_CHANGED_MEDIA_TYPE);
      const notice = part?.content.value;
      if (!notice || notice.type !== 'agent_card_changed') {
        emit('card_notification_rejected', { reason: 'unsupported_message' });
        return respond('rejected', { reason: 'This endpoint only accepts agent_card_changed notifications.' });
      }
      const { notificationId, agentId } = notice;
      if (typeof notificationId !== 'string' || !/^[\w-]{8,100}$/.test(notificationId)) {
        emit('card_notification_rejected', { reason: 'malformed_notification' });
        return respond('rejected', { reason: 'Malformed notificationId.' });
      }
      // Anything beyond the known fields (e.g. a "cardUrl") is ignored, not followed.
      const ignoredFields = Object.keys(notice).filter((k) => !NOTICE_KEYS.includes(k));
      if (!registry.has(agentId)) {
        emit('card_notification_rejected', { notificationId, claimedAgentId: String(agentId).slice(0, 60), reason: 'unknown_sender' });
        return respond('rejected', { reason: 'Unknown agent; only registered peers can trigger a refresh.' });
      }
      if (seen.has(notificationId)) {
        emit('card_notification_received', { notificationId, agentId, revision: notice.revision ?? null, duplicate: true, ignoredFields });
        return respond('duplicate', { notificationId });
      }
      seen.add(notificationId);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);

      emit('card_notification_received', { notificationId, agentId, revision: notice.revision ?? null, reason: notice.reason ?? null, duplicate: false, ignoredFields });
      // Fetch the CURRENT card from the registered URL (not the revision in the message), coalesced.
      registry.refresh(agentId, 'notification');
      respond('received', { notificationId, refreshScheduled: true });
    },
    async cancelTask() {},
  };

  return new Promise((resolve, reject) => {
    const app = express();
    const server = app.listen(port, HOST, (err) => {
      if (err) return reject(err); // Express 5 passes listen errors (e.g. EADDRINUSE) here
      const actualPort = server.address().port;
      const card = {
        name: 'Student Agent',
        description: 'Receives agent_card_changed notifications from registered services (application convention over A2A).',
        version: '0.1.0',
        supportedInterfaces: [{ url: `http://${HOST}:${actualPort}${JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }],
        provider: undefined,
        capabilities: { streaming: false, pushNotifications: false, extensions: [] },
        securitySchemes: {}, securityRequirements: [],
        defaultInputModes: [CARD_CHANGED_MEDIA_TYPE], defaultOutputModes: ['application/json'],
        skills: [{ id: 'agent-card-changed', name: 'Card change notifications', description: 'Accepts agent_card_changed hints and re-fetches the sender’s registered Agent Card.', tags: ['notifications'], examples: [], inputModes: [CARD_CHANGED_MEDIA_TYPE], outputModes: ['application/json'], securityRequirements: [] }],
        signatures: [],
      };
      const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
      app.use(hostGuard(actualPort));
      app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }));
      app.use(JSONRPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
      resolve({ server, baseUrl: `http://${HOST}:${actualPort}` });
    });
    server.on('error', reject);
  });
}
