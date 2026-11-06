// Part 7: a specialist's connection to the University Hub — registration, heartbeats, sign-out and
// card-change notices. These are THIS application's conventions carried as A2A messages (typed data
// parts), not built-in A2A features.
//
// Trust model (localhost spike): the agentId/endpoint in these messages are claims. The Hub checks
// them against its allowlist, fetches the card from its own configured URL, and refuses takeovers,
// but nothing here is authentication.
//
// Part 8: the reverse direction IS checked. Each specialist process makes a random in-memory signing
// key and gives it to the Hub when it registers (only to the Hub URL in its own configuration). The
// Hub signs the student identity it forwards; verifiedStudent() accepts a studentId only with a valid
// signature, so another local process can't claim to be a student. Not persisted, never logged; a
// restart makes a new key.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// HMAC over the forwarded student, the downstream A2A context and the Hub's operation ID.
export const signStudent = (key, { studentId, contextId, operationId }) => createHmac('sha256', key).update(`${studentId}|${contextId}|${operationId}`).digest('base64url');
// HR (staff only): the Hub signs a STAFF caller with a distinct prefix, so a student signature over the same
// ids never verifies as staff (and the reverse). callerKind must say 'staff' as well.
export const signStaff = (key, { staffId, contextId, operationId }) => createHmac('sha256', key).update(`staff|${staffId}|${contextId}|${operationId}`).digest('base64url');
// Part 17 (CHRS): the Hub's OWN signature on a roster lookup, made with the callKey CHRS gave the Hub at registration
// (the key the Hub also uses to sign student/staff contexts toward CHRS). A distinct prefix, so a student or staff
// signature never verifies as a lookup. It covers the course, the course's instructor and the Hub's operation id
// (not the contextId: the Hub's lookup has none of its own). The staff member's agent has a different key, so it
// can't make one.
// Every field must be a plain id (no '|' that could shift the boundaries between fields): signing refuses anything else.
const LOOKUP_ID = /^[\w-]{1,64}$/;
const lookupFieldsOk = (...fields) => fields.every((v) => typeof v === 'string' && LOOKUP_ID.test(v));
export const signRosterLookup = (key, { courseId, instructorStaffId, operationId }) => {
  if (!lookupFieldsOk(courseId, instructorStaffId, operationId)) return null;
  return createHmac('sha256', key).update(`roster-lookup|${courseId}|${instructorStaffId}|${operationId}`).digest('base64url');
};
// Review C16: the Hub's own signature on an email notice toward CHRS (same key and rules as a roster lookup, its own prefix).
// It covers the course, the instructor, the operation, the exact student ids (in order) and a hash of the title and text,
// so nothing in it can be changed or added in transit. Any non-id field → null (nothing is signed).
export const emailContentHash = (title, text) => createHash('sha256').update(JSON.stringify([String(title ?? ''), String(text ?? '')])).digest('base64url'); // JSON: no boundary can shift between title and text
export const signEmailNotice = (key, { courseId, instructorStaffId, operationId, studentIds, title, text }) => {
  if (!lookupFieldsOk(courseId, instructorStaffId, operationId) || !Array.isArray(studentIds) || !studentIds.length || studentIds.length > 500 || !lookupFieldsOk(...studentIds)) return null;
  return createHmac('sha256', key).update(`email-notice|${courseId}|${instructorStaffId}|${operationId}|${studentIds.join(',')}|${emailContentHash(title, text)}`).digest('base64url');
};
const sameSignature = (given, expected) => {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
// The staff member the Hub vouches for on this request (pure: the key is passed in), or null.
export function verifyStaffSignature(key, metadata, contextId) {
  const { staffId, hubOperationId, hubSignature, callerKind } = metadata ?? {};
  if (callerKind !== 'staff' || typeof staffId !== 'string' || typeof hubOperationId !== 'string' || typeof hubSignature !== 'string') return null;
  return sameSignature(hubSignature, signStaff(key, { staffId, contextId, operationId: hubOperationId })) ? staffId : null;
}
// The lookup the Hub vouches for (pure: the key is passed in): { courseId, instructorStaffId } or null.
export function verifyRosterLookupSignature(key, value, metadata) {
  const { courseId, instructorStaffId } = value ?? {};
  const { hubOperationId, hubSignature } = metadata ?? {};
  if (!lookupFieldsOk(courseId, instructorStaffId, hubOperationId) || typeof hubSignature !== 'string' || !hubSignature) return null;
  return sameSignature(hubSignature, signRosterLookup(key, { courseId, instructorStaffId, operationId: hubOperationId })) ? { courseId, instructorStaffId } : null;
}
// The email notice the Hub vouches for (pure): { courseId, instructorStaffId, studentIds, title, text, operationId } or null.
export function verifyEmailNoticeSignature(key, value, metadata) {
  const { courseId, instructorStaffId, studentIds, title, text } = value ?? {};
  const { hubOperationId, hubSignature } = metadata ?? {};
  if (typeof hubSignature !== 'string' || !hubSignature || typeof title !== 'string' || typeof text !== 'string') return null;
  const expected = signEmailNotice(key, { courseId, instructorStaffId, operationId: hubOperationId, studentIds, title, text });
  return expected && sameSignature(hubSignature, expected) ? { courseId, instructorStaffId, studentIds: [...studentIds], title, text, operationId: hubOperationId } : null;
}
import { Role } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { CARD_CHANGED_MEDIA_TYPE } from './skills.js';
import { sign } from './lessons.js';

export const REGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-register+json';
export const HEARTBEAT_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-heartbeat+json';
export const DEREGISTER_MEDIA_TYPE = 'application/vnd.a2a-spike.agent-deregister+json';
export const CONTROL_MEDIA_TYPES = new Set([REGISTER_MEDIA_TYPE, HEARTBEAT_MEDIA_TYPE, DEREGISTER_MEDIA_TYPE, CARD_CHANGED_MEDIA_TYPE]);

const SEND_TIMEOUT_MS = 3000;

export function createHubLink({ agentId, hubUrl, endpoint, cardUrl, enabled, heartbeatIntervalMs, emit = () => {}, log = () => {} }) {
  const instanceId = randomUUID(); // this process; a restart is a new instance
  const callKey = randomBytes(32).toString('base64url'); // signing key for the Hub's forwarded identity
  let client = null;
  let timer = null;
  let stopped = false;
  const state = { registered: false, lastAckAt: null, lastError: null, hubUrl, instanceId, enabled };

  async function send(mediaType, value, timeoutMs = SEND_TIMEOUT_MS) {
    try {
      client ??= await new ClientFactory().createFromUrl(hubUrl);
      const result = await client.sendMessage({
        tenant: '', configuration: undefined, metadata: undefined,
        message: {
          messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER,
          parts: [{ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType }],
          metadata: { control: value.type, agentId }, extensions: [], referenceTaskIds: [],
        },
      }, { signal: AbortSignal.timeout(timeoutMs) });
      return result.parts?.find((p) => p.content?.$case === 'data')?.content.value ?? { status: 'unrecognized' };
    } catch (err) {
      client = null; // re-discover the Hub next time (it may have restarted)
      throw err;
    }
  }
  const offline = (err) => (err.cause?.code === 'ECONNREFUSED' ? 'Hub is offline' : err.name === 'TimeoutError' ? 'Hub did not answer in time' : err.message);

  async function register() {
    const value = { type: 'agent_register', agentId, instanceId, endpoint, cardUrl, enabled, heartbeatIntervalMs, callKey, at: new Date().toISOString() };
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
    // Part 9: a request this specialist starts itself (e.g. the Professor publishing a lesson), signed with
    // the key it gave the Hub at registration so the Hub can tell it really comes from this instance.
    // Returns the Hub's typed reply, or { status: 'not_delivered' | 'uncertain', reason }.
    // timeoutMs: how long to wait for the Hub (HR staff requests may include a model call downstream).
    async sendSigned(mediaType, value, fields, { timeoutMs = 15000 } = {}) {
      const body = { ...value, professorId: agentId, instanceId, signature: sign(callKey, [agentId, instanceId, ...fields]) };
      try {
        return await send(mediaType, body, timeoutMs); // the Hub delivers to the Student before it replies
      } catch (err) {
        const refused = err?.cause?.code === 'ECONNREFUSED';
        return { status: refused ? 'not_delivered' : 'uncertain', reason: offline(err) };
      }
    },
    // The student the Hub vouches for on this request, or null if the signature is missing or wrong.
    verifiedStudent(metadata, contextId) {
      const { studentId, hubOperationId, hubSignature } = metadata ?? {};
      if (typeof studentId !== 'string' || typeof hubOperationId !== 'string' || typeof hubSignature !== 'string') return null;
      const expected = Buffer.from(signStudent(callKey, { studentId, contextId, operationId: hubOperationId }));
      const given = Buffer.from(hubSignature);
      return given.length === expected.length && timingSafeEqual(given, expected) ? studentId : null;
    },
    // HR: the staff member the Hub vouches for on this request, or null (a student signature never counts).
    verifiedStaff(metadata, contextId) {
      return verifyStaffSignature(callKey, metadata, contextId);
    },
    // CHRS: the roster lookup the Hub vouches for with its own signature, or null.
    verifiedRosterLookup(value, metadata) {
      return verifyRosterLookupSignature(callKey, value, metadata);
    },
    // CHRS (review C16): the email notice the Hub vouches for with its own signature, or null.
    verifiedEmailNotice(value, metadata) {
      return verifyEmailNoticeSignature(callKey, value, metadata);
    },
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
