// Part 7: a specialist's connection to the University Hub — registration, heartbeats, sign-out and
// card-change notices. These are THIS application's conventions carried as A2A messages (typed data
// parts), not built-in A2A features.
//
// Trust model (localhost spike): the agentId/endpoint in these messages are claims. The Hub checks
// them against its allowlist, fetches the card from its own configured URL, and refuses takeovers,
// but nothing here is authentication.
import { randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { CARD_CHANGED_MEDIA_TYPE } from './skills.js';

export const REGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-register+json';
export const HEARTBEAT_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-heartbeat+json';
export const DEREGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-deregister+json';
export const CONTROL_MEDIA_TYPES = new Set([REGISTER_MEDIA_TYPE, HEARTBEAT_MEDIA_TYPE, DEREGISTER_MEDIA_TYPE, CARD_CHANGED_MEDIA_TYPE]);

const SEND_TIMEOUT_MS = 3000;

export function createHubLink({ agentId, hubUrl, endpoint, cardUrl, enabled, heartbeatIntervalMs, emit = () => {}, log = () => {} }) {
  const instanceId = randomUUID(); // this process; a restart is a new instance
  let client = null;
  let timer = null;
  let stopped = false;
  const state = { registered: false, lastAckAt: null, lastError: null, hubUrl, instanceId, enabled };

  async function send(mediaType, value) {
    try {
      client ??= await new ClientFactory().createFromUrl(hubUrl);
      const result = await client.sendMessage({
        tenant: '', configuration: undefined, metadata: undefined,
        message: {
          messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER,
          parts: [{ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType }],
          metadata: { control: value.type, agentId }, extensions: [], referenceTaskIds: [],
        },
      }, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      return result.parts?.find((p) => p.content?.$case === 'data')?.content.value ?? { status: 'unrecognized' };
    } catch (err) {
      client = null; // re-discover the Hub next time (it may have restarted)
      throw err;
    }
  }
  const offline = (err) => (err.cause?.code === 'ECONNREFUSED' ? 'Hub is offline' : err.name === 'TimeoutError' ? 'Hub did not answer in time' : err.message);

  async function register() {
    const value = { type: 'agent_register', agentId, instanceId, endpoint, cardUrl, enabled, heartbeatIntervalMs, at: new Date().toISOString() };
    try {
      const ack = await send(REGISTER_MEDIA_TYPE, value);
      state.registered = ack.status === 'registered';
      state.lastError = state.registered ? null : ack.reason ?? ack.status;
      state.lastAckAt = new Date().toISOString();
      log('hub registration', { status: ack.status, reason: ack.reason ?? null });
      emit('hub_registration', { status: ack.status, reason: ack.reason ?? null, hubUrl });
    } catch (err) {
      state.registered = false;
      state.lastError = offline(err);
      emit('hub_registration', { status: 'not_delivered', reason: state.lastError, hubUrl });
    }
  }

  async function beat() {
    if (!state.registered) return register(); // keep trying until the Hub accepts us
    try {
      const ack = await send(HEARTBEAT_MEDIA_TYPE, { type: 'agent_heartbeat', agentId, instanceId, enabled, at: new Date().toISOString() });
      state.lastAckAt = new Date().toISOString();
      if (ack.status === 'not_registered') {
        state.registered = false; // e.g. the Hub restarted or expired us: register again
        return register();
      }
      state.lastError = ack.status === 'ok' ? null : ack.reason ?? ack.status;
    } catch (err) {
      state.lastError = offline(err); // keep beating; the Hub decides when we are stale
    }
  }

  return {
    state,
    instanceId,
    async start() {
      await register();
      timer = setInterval(() => { if (!stopped) beat(); }, heartbeatIntervalMs);
      timer.unref?.();
    },
    // Best effort on shutdown; if it never arrives, the Hub's heartbeat expiry handles it.
    async stop() {
      stopped = true;
      clearInterval(timer);
      try {
        await send(DEREGISTER_MEDIA_TYPE, { type: 'agent_deregister', agentId, instanceId, at: new Date().toISOString() });
      } catch {
        // ignored: expiry covers it
      }
    },
    // The Part 5 card-change convention, now sent to the Hub (never to the Student).
    async notifyCardChanged({ revision, reason }) {
      const notificationId = randomUUID();
      const notice = { type: 'agent_card_changed', notificationId, agentId, instanceId, revision, reason, changedAt: new Date().toISOString() };
      try {
        const ack = await send(CARD_CHANGED_MEDIA_TYPE, notice);
        const delivered = ack.status === 'received' || ack.status === 'duplicate';
        return { notificationId, outcome: delivered ? 'delivered' : 'rejected', detail: delivered ? 'Hub acknowledged; it will re-fetch the card' : ack.reason ?? ack.status };
      } catch (err) {
        return { notificationId, outcome: 'pending', detail: `${offline(err)} — the Hub re-fetches cards when this agent registers` };
      }
    },
  };
}
