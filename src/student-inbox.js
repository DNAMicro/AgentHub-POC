// Part 9: the Student agent's inbound side and its course inbox.
//
// Until Part 8 the Student only sent requests. To receive professor-initiated lessons it now also serves
// a minimal A2A endpoint (on the UI server's port) that accepts only these application conventions from
// the Hub, each signed with this Student's session key:
//   session_challenge  — prove we hold the key we registered (we answer with an HMAC of the nonce)
//   lesson_delivery    — commit the lesson to the persisted inbox, THEN reply "delivered"
//   lesson_query       — reconcile: do we already have this delivery? (never a second inbox entry)
//   course_available   — a course became available; stored once per notice
// Inbox: STUDENT_INBOX_FILE (default data/student-inbox.json). Lessons are kept as delivered (title and
// original text), with received / opened / saved times. Lesson text is content: only displayed as text.
import { randomBytes, randomUUID } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';
import { createJsonStore } from './json-store.js';
import { sendData } from './a2a-data.js';
import {
  COURSE_AVAILABLE_MEDIA_TYPE, LESSON_DELIVERY_MEDIA_TYPE, LESSON_QUERY_MEDIA_TYPE, LESSON_RECEIPT_MEDIA_TYPE, SESSION_CHALLENGE_MEDIA_TYPE,
  STUDENT_INBOUND_MEDIA_TYPES, STUDENT_SESSION_MEDIA_TYPE, contentHash, sign, verify,
} from './lessons.js';

export function createStudentInbox({ studentId, hubUrl, file = process.env.STUDENT_INBOX_FILE ?? 'data/student-inbox.json', emit = () => {}, log = () => {} }) {
  const store = createJsonStore(file, { lessons: {}, notices: {}, pendingReceipts: [] });
  const instanceId = randomUUID();
  const callKey = randomBytes(32).toString('base64url'); // in memory only; a restart makes a new one
  const session = { status: 'not_registered', reason: null, endpoint: null };
  let retry = null;
  // Test-only: hold the reply to the FIRST delivery after committing it (simulates a lost acknowledgment).
  let holdFirstAckMs = Number(process.env.STUDENT_TEST_DELAY_FIRST_DELIVERY_ACK_MS ?? 0);

  // ---- session with the Hub ----------------------------------------------------------------------------
  async function register(endpoint = session.endpoint) {
    session.endpoint = endpoint;
    clearTimeout(retry);
    const r = await sendData(hubUrl, { mediaType: STUDENT_SESSION_MEDIA_TYPE, value: { type: 'student_session', studentId, instanceId, endpoint, callKey }, timeoutMs: 10000 });
    session.status = r.ok ? r.value?.status ?? 'unknown' : 'not_registered';
    session.reason = r.ok ? r.value?.reason ?? null : r.error;
    emit('student_session', { status: session.status, reason: session.reason });
    log('hub session', { status: session.status, reason: session.reason });
    if (session.status !== 'registered') retry = setTimeout(() => register(), 3000);
    else sendPendingReceipts();
    return session.status;
  }
  // The Student's signature on a request to the Hub (contextId + messageId of that message).
  const signer = ({ contextId, messageId }) => sign(callKey, [studentId, contextId, messageId]);

  // ---- inbound messages from the Hub -------------------------------------------------------------------
  function handle(part, metadata) {
    const v = part.content.value ?? {};
    const sig = metadata?.hubSignature;
    if (part.mediaType === SESSION_CHALLENGE_MEDIA_TYPE) {
      if (v.studentId !== studentId || v.instanceId !== instanceId || typeof v.nonce !== 'string') return { status: 'rejected', reason: 'not_this_session' };
      return { proof: sign(callKey, ['session', studentId, instanceId, v.nonce]) };
    }
    if (part.mediaType === LESSON_DELIVERY_MEDIA_TYPE) {
      if (!verify(callKey, ['delivery', studentId, v.deliveryId, v.lessonId, v.revision, v.contentHash], sig)) return { status: 'rejected', reason: 'bad_signature' };
      if (!['lesson', 'message'].includes(v.kind ?? 'lesson')) return { status: 'rejected', reason: 'unknown_kind' };
      if (v.contentHash !== contentHash(v.title, v.text, v.kind ?? 'lesson')) return { status: 'rejected', reason: 'content_mismatch' };
      const existing = store.get().lessons[v.deliveryId];
      if (existing) return existing.contentHash === v.contentHash ? { status: 'delivered', inboxId: existing.inboxId, duplicate: true } : { status: 'rejected', reason: 'conflict' };
      const entry = {
        inboxId: `in-${randomUUID().slice(0, 12)}`, deliveryId: v.deliveryId, lessonId: v.lessonId, revision: v.revision, kind: v.kind ?? 'lesson', toAll: Boolean(v.toAll), courseId: v.courseId, courseTitle: v.courseTitle,
        professorId: v.professorId, professorName: v.professorName, title: v.title, text: v.text, postedAt: v.postedAt, contentHash: v.contentHash,
        receivedAt: new Date().toISOString(), openedAt: null, savedAt: null,
      };
      store.update((s) => { s.lessons[v.deliveryId] = entry; }); // committed to disk before we say "delivered"
      emit('lesson_received', { deliveryId: v.deliveryId, lessonId: v.lessonId, revision: v.revision, kind: entry.kind, inboxId: entry.inboxId, courseTitle: v.courseTitle, professorName: v.professorName, title: v.title });
      return { status: 'delivered', inboxId: entry.inboxId };
    }
    if (part.mediaType === LESSON_QUERY_MEDIA_TYPE) {
      if (!verify(callKey, ['query', studentId, v.deliveryId], sig)) return { status: 'rejected', reason: 'bad_signature' };
      const e = store.get().lessons[v.deliveryId];
      return { has: Boolean(e), inboxId: e?.inboxId ?? null };
    }
    if (part.mediaType === COURSE_AVAILABLE_MEDIA_TYPE) {
      if (!verify(callKey, ['notice', studentId, v.noticeId], sig)) return { status: 'rejected', reason: 'bad_signature' };
      if (store.get().notices[v.noticeId]) return { status: 'ok', duplicate: true };
      store.update((s) => { s.notices[v.noticeId] = { noticeId: v.noticeId, courseId: v.courseId, courseTitle: v.courseTitle, professorName: v.professorName, at: v.at, receivedAt: new Date().toISOString(), seenAt: null }; });
      emit('course_available', { noticeId: v.noticeId, courseId: v.courseId, courseTitle: v.courseTitle });
      return { status: 'ok' };
    }
    return { status: 'rejected', reason: 'unsupported' };
  }
  // The A2A executor for the Student's inbound endpoint: typed Hub messages only; anything else is refused.
  const executor = {
    async execute(ctx, bus) {
      const part = ctx.userMessage.parts.find((p) => p.content?.$case === 'data' && STUDENT_INBOUND_MEDIA_TYPES.has(p.mediaType));
      const ack = part ? handle(part, ctx.userMessage.metadata) : { status: 'rejected', reason: 'This endpoint only accepts deliveries from the university.' };
      if (holdFirstAckMs && part?.mediaType === LESSON_DELIVERY_MEDIA_TYPE && ack.status === 'delivered') {
        const ms = holdFirstAckMs;
        holdFirstAckMs = 0;
        await new Promise((r) => setTimeout(r, ms));
      }
      bus.publish(AgentEvent.message({ messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [{ content: { $case: 'data', value: ack }, metadata: undefined, filename: '', mediaType: 'application/json' }], metadata: undefined, extensions: [], referenceTaskIds: [] }));
      bus.finished();
    },
    async cancelTask() {},
  };

  // ---- the student's actions ----------------------------------------------------------------------------
  // "Opened" requires the student's own action in the UI; the Hub (and so the professor) learns it from
  // a signed receipt. A receipt that can't be sent now is kept and sent when the session is back.
  async function sendReceipt(deliveryId) {
    const r = await sendData(hubUrl, {
      mediaType: LESSON_RECEIPT_MEDIA_TYPE, value: { type: 'lesson_receipt', studentId, deliveryId, event: 'opened' },
      metadata: { studentSignature: sign(callKey, [studentId, 'receipt', deliveryId, 'opened']) }, timeoutMs: 5000,
    });
    return r.ok && r.value?.status === 'ok';
  }
  async function sendPendingReceipts() {
    for (const deliveryId of [...store.get().pendingReceipts]) {
      if (await sendReceipt(deliveryId)) store.update((s) => { s.pendingReceipts = s.pendingReceipts.filter((d) => d !== deliveryId); });
    }
  }
  async function markOpened(deliveryId) {
    const e = store.get().lessons[deliveryId];
    if (!e) return null;
    if (!e.openedAt) {
      store.update((s) => { s.lessons[deliveryId].openedAt = new Date().toISOString(); if (!s.pendingReceipts.includes(deliveryId)) s.pendingReceipts.push(deliveryId); });
      emit('lesson_opened', { deliveryId, lessonId: e.lessonId });
      sendPendingReceipts();
    }
    return store.get().lessons[deliveryId];
  }
  function markSaved(deliveryId) {
    if (!store.get().lessons[deliveryId]) return null;
    store.update((s) => { s.lessons[deliveryId].savedAt ??= new Date().toISOString(); });
    return store.get().lessons[deliveryId];
  }
  function markNoticeSeen(noticeId) {
    if (!store.get().notices[noticeId]) return null;
    store.update((s) => { s.notices[noticeId].seenAt ??= new Date().toISOString(); });
    return store.get().notices[noticeId];
  }

  // Demo reset (New conversation): every lesson, message and notice goes; the professor sends again.
  function reset() {
    store.update((s) => { s.lessons = {}; s.notices = {}; s.pendingReceipts = []; });
    emit('inbox_reset', {});
  }

  return {
    executor, register, signer, markOpened, markSaved, markNoticeSeen, reset,
    session: () => ({ ...session }),
    lesson: (deliveryId) => store.get().lessons[deliveryId] ?? null,
    view: () => ({
      lessons: Object.values(store.get().lessons).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)),
      notices: Object.values(store.get().notices).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)),
      unread: Object.values(store.get().lessons).filter((l) => !l.openedAt).length,
    }),
    stop: () => clearTimeout(retry),
  };
}
