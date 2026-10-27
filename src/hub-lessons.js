// Part 9: the Hub's side of professor-initiated lessons — the reverse route
//   Professor → Hub → Student
// as a NEW A2A interaction (message/send), not a task-status push for a task that never existed.
//
// The Hub is the authority: it verifies the professor (registered instance + signature with the key the
// professor gave it at registration), the course (from its own configuration: who teaches it, who is
// enrolled), the recipient (enrolled, with a configured endpoint), then delivers to the Student's own
// inbound A2A endpoint — resolved from configuration, never from a message. A delivery counts as
// delivered only when the Student replies that its inbox entry is committed.
//
// Persisted ledger (HUB_LESSON_FILE, default data/hub-lessons.json): lessons (id + revision + content
// hash), operations (professor operation id → result, for dedupe), deliveries (one per lesson revision
// and student, with state), availability notices. Reconciliation: an uncertain delivery is queried
// before any re-send, so a lost acknowledgement never creates a second inbox entry.
//
// Student sessions: a Student registers its per-process key; the Hub confirms it by challenging the
// student's CONFIGURED endpoint (only the process serving it can answer). Requests from the Student are
// then signed with that key. Local-demo trust model: localhost, no accounts — labelled as such.
import { randomBytes, randomUUID } from 'node:crypto';
import { createJsonStore } from './json-store.js';
import { validMeeting } from './meeting-times.js';
import { sendData } from './a2a-data.js';
import {
  AUDIENCE, COURSE_AVAILABLE_MEDIA_TYPE, ID, LESSON_DELIVERY_MEDIA_TYPE, LESSON_QUERY_MEDIA_TYPE, POST_AUTHORS, SESSION_CHALLENGE_MEDIA_TYPE,
  contentHash, deliveryIdFor, sign, validateLesson, verify,
} from './lessons.js';

export function createLessonService({ cfg, registry, emit = () => {}, file = process.env.HUB_LESSON_FILE ?? 'data/hub-lessons.json', deliverTimeoutMs = Number(process.env.HUB_DELIVER_TIMEOUT_MS ?? 5000), retryMs = Number(process.env.HUB_DELIVER_RETRY_MS ?? 3000) }) {
  const store = createJsonStore(file, { lessons: {}, operations: {}, deliveries: {}, notices: {} });
  const sessions = new Map(); // studentId → { instanceId, callKey, since }
  const inFlight = new Set(); // deliveryIds being sent right now (never two sends at once)
  const endpointOf = (studentId) => cfg.studentEndpoints?.[studentId] ?? null;
  const coursesOf = (professorId) => Object.entries(cfg.courses ?? {}).filter(([, c]) => c.professor === professorId);
  const nameOf = (agentId) => registry.peer(agentId)?.displayName ?? agentId;

  // ---- student sessions ---------------------------------------------------------------------------
  async function registerStudent(msg) {
    const studentId = msg?.studentId;
    if (!cfg.students.includes(studentId)) return { status: 'rejected', reason: 'unknown_student' };
    if (typeof msg.instanceId !== 'string' || !ID.test(msg.instanceId) || typeof msg.callKey !== 'string' || !/^[\w-]{40,64}$/.test(msg.callKey)) return { status: 'rejected', reason: 'malformed' };
    const endpoint = endpointOf(studentId);
    if (msg.endpoint !== (endpoint ?? null)) return { status: 'rejected', reason: 'unexpected_endpoint' };
    // A student with no configured endpoint can't be challenged, so nobody may register as them — except
    // in tests that drive the Hub directly as a student (HUB_TEST_STUDENTS_WITHOUT_ENDPOINT=1).
    if (!endpoint && process.env.HUB_TEST_STUDENTS_WITHOUT_ENDPOINT !== '1') return { status: 'rejected', reason: 'no_student_endpoint' };
    if (endpoint) {
      // Prove the registrant serves the configured endpoint: it must answer a fresh challenge with the key.
      const nonce = randomBytes(16).toString('base64url');
      const r = await sendData(endpoint, { mediaType: SESSION_CHALLENGE_MEDIA_TYPE, value: { type: 'session_challenge', studentId, instanceId: msg.instanceId, nonce }, timeoutMs: deliverTimeoutMs });
      if (!r.ok || !verify(msg.callKey, ['session', studentId, msg.instanceId, nonce], r.value?.proof)) {
        emit('student_session', { studentId, status: 'rejected', reason: 'challenge_failed' });
        return { status: 'rejected', reason: 'challenge_failed' };
      }
    }
    sessions.set(studentId, { instanceId: msg.instanceId, callKey: msg.callKey, since: new Date().toISOString() });
    emit('student_session', { studentId, status: 'registered', instance: msg.instanceId.slice(0, 8) });
    setTimeout(() => { flush(studentId); announceCourses(); }, 0);
    return { status: 'registered' };
  }
  // A request claiming to be from a student: valid only with that student's current session signature.
  function verifyStudent(studentId, fields, signature) {
    const s = sessions.get(studentId);
    if (!s) return 'no_session';
    return verify(s.callKey, [studentId, ...fields], signature) ? 'ok' : 'bad_signature';
  }

  // ---- publishing (Professor → Hub) -----------------------------------------------------------------
  function verifyProfessor(msg, fields) {
    const e = registry.entry(msg?.professorId);
    if (!e || !e.registered || e.instanceId !== msg.instanceId || !e.callKey) return 'unregistered';
    return verify(e.callKey, [msg.professorId, msg.instanceId, ...fields], msg.signature) ? 'ok' : 'bad_signature';
  }
  // A post goes to one enrolled student or to 'all' — every student enrolled in the course, from the
  // Hub's own configuration. Each recipient gets their own delivery (own id, state and receipt).
  const summaryOf = (ds) => (ds.every((d) => d.state === 'delivered') ? 'delivered' : ['uncertain', 'queued', 'failed'].find((st) => ds.some((d) => d.state === st)) ?? 'queued');
  const deliveryView = (d) => ({ studentId: d.studentId, deliveryId: d.deliveryId, state: d.state, reason: d.lastError, opened: Boolean(d.openedAt) });
  async function publish(msg) {
    const reject = (reason, detail = null) => {
      emit('lesson_rejected', { agentId: msg?.professorId ?? null, reason, lessonId: msg?.lessonId ?? null });
      return { status: 'rejected', reason, detail };
    };
    const kind = msg?.kind ?? 'lesson';
    const author = msg?.author ?? 'professor';
    const meeting = msg?.meeting ?? null; // a meeting offer: times the professor gave, for the student to pick
    const hash = contentHash(msg?.title, msg?.text, kind, author, meeting);
    const fields = ['publish', msg?.operationId, msg?.lessonId, msg?.revision, msg?.courseId, kind, msg?.audience, hash];
    const who = verifyProfessor(msg, fields);
    if (who !== 'ok') return reject(who === 'unregistered' ? 'unknown_professor' : 'bad_signature');
    if (!ID.test(msg.operationId ?? '') || !ID.test(msg.lessonId ?? '') || !Number.isInteger(msg.revision) || msg.revision < 1 || !AUDIENCE.test(msg.audience ?? '') || !POST_AUTHORS.includes(author) || !validMeeting(meeting) || (meeting && kind !== 'message')) return reject('malformed');
    const course = cfg.courses?.[msg.courseId];
    if (!course) return reject('unknown_course');
    if (course.professor !== msg.professorId) return reject('not_course_professor');
    const recipients = msg.audience === 'all' ? [...course.enrolled] : [...new Set(msg.audience.split(','))];
    if (recipients.some((sid) => !course.enrolled.includes(sid))) return reject('recipient_not_enrolled');
    if (!recipients.length) return reject('no_students_enrolled');
    const v = validateLesson({ kind, title: msg.title, text: msg.text });
    if (!v.ok) return reject('invalid_content', v.errors);
    // Dedupe: the same operation returns its stored outcome; the same id with different content is refused.
    const prior = store.get().operations[msg.operationId];
    if (prior) {
      if (prior.hash !== hash || prior.lessonId !== msg.lessonId || prior.revision !== msg.revision || prior.audience !== msg.audience) return reject('operation_reused');
      const ds = prior.deliveryIds.map((id) => store.get().deliveries[id]);
      return { status: summaryOf(ds), duplicate: true, lessonId: msg.lessonId, revision: msg.revision, deliveries: ds.map(deliveryView) };
    }
    const key = `${msg.lessonId}#${msg.revision}`;
    const existing = store.get().lessons[key];
    if (existing && existing.hash !== hash) return reject('revision_conflict'); // a revision is immutable
    const deliveryIds = recipients.map((sid) => deliveryIdFor(msg.lessonId, msg.revision, sid));
    store.update((s) => {
      s.lessons[key] ??= { lessonId: msg.lessonId, revision: msg.revision, courseId: msg.courseId, professorId: msg.professorId, kind, author, meeting, audience: msg.audience, title: v.values.title, text: v.values.text, hash, postedAt: new Date().toISOString() };
      s.operations[msg.operationId] = { hash, lessonId: msg.lessonId, revision: msg.revision, audience: msg.audience, deliveryIds };
      recipients.forEach((studentId, i) => {
        s.deliveries[deliveryIds[i]] ??= { deliveryId: deliveryIds[i], lessonId: msg.lessonId, revision: msg.revision, studentId, courseId: msg.courseId, professorId: msg.professorId, state: 'queued', attempts: 0, lastError: null, deliveredAt: null, openedAt: null, inboxId: null };
      });
    });
    emit('lesson_publish_received', { agentId: msg.professorId, lessonId: msg.lessonId, revision: msg.revision, courseId: msg.courseId, kind, audience: msg.audience === 'all' ? 'all' : recipients.length > 1 ? 'some' : 'one', recipients: recipients.length });
    await Promise.all(deliveryIds.map((id) => deliver(id)));
    const ds = deliveryIds.map((id) => store.get().deliveries[id]);
    return { status: summaryOf(ds), lessonId: msg.lessonId, revision: msg.revision, deliveries: ds.map(deliveryView) };
  }

  // ---- delivery (Hub → Student) ---------------------------------------------------------------------
  async function deliver(deliveryId) {
    if (inFlight.has(deliveryId)) return;
    const d = store.get().deliveries[deliveryId];
    if (!d || d.state === 'delivered') return;
    const session = sessions.get(d.studentId);
    const endpoint = endpointOf(d.studentId);
    // An unreachable session (its endpoint refused a connection) waits for the Student to register again,
    // which delivers immediately — no attempts against a dead endpoint every few seconds.
    if (!session || !endpoint || session.unreachable) {
      // Reported once, when it starts waiting — not again on every retry cycle while the student is away.
      if (d.lastError !== 'student_offline') {
        store.update((s) => { s.deliveries[deliveryId].lastError = 'student_offline'; s.deliveries[deliveryId].state = d.state === 'uncertain' ? 'uncertain' : 'queued'; });
        emit('lesson_queued', { deliveryId, lessonId: d.lessonId, reason: 'student_offline' });
      }
      return;
    }
    inFlight.add(deliveryId);
    try {
      // An earlier attempt may have landed: ask before sending again (never a duplicate inbox entry).
      if (d.state === 'uncertain') {
        const q = await sendData(endpoint, { mediaType: LESSON_QUERY_MEDIA_TYPE, value: { type: 'lesson_query', deliveryId }, metadata: { hubSignature: sign(session.callKey, ['query', d.studentId, deliveryId]) }, timeoutMs: deliverTimeoutMs });
        if (!q.ok) return; // still unknown; try again later
        emit('lesson_reconciled', { deliveryId, lessonId: d.lessonId, found: Boolean(q.value?.has) });
        if (q.value?.has) return markDelivered(deliveryId, q.value.inboxId, true);
      }
      const lesson = store.get().lessons[`${d.lessonId}#${d.revision}`];
      const value = {
        type: 'lesson_delivery', deliveryId, lessonId: d.lessonId, revision: d.revision, courseId: d.courseId, kind: lesson.kind ?? 'lesson', author: lesson.author ?? 'professor', meeting: lesson.meeting ?? null, toAll: lesson.audience === 'all',
        courseTitle: cfg.courses[d.courseId]?.title ?? d.courseId, professorId: d.professorId, professorName: nameOf(d.professorId),
        title: lesson.title, text: lesson.text, postedAt: lesson.postedAt, contentHash: lesson.hash,
      };
      store.update((s) => { s.deliveries[deliveryId].attempts += 1; });
      emit('lesson_delivery_attempted', { deliveryId, lessonId: d.lessonId, attempt: store.get().deliveries[deliveryId].attempts });
      const r = await sendData(endpoint, { mediaType: LESSON_DELIVERY_MEDIA_TYPE, value, metadata: { hubSignature: sign(session.callKey, ['delivery', d.studentId, deliveryId, d.lessonId, d.revision, lesson.hash]) }, timeoutMs: deliverTimeoutMs });
      if (!store.get().deliveries[deliveryId]) return; // the classroom was reset while this was in flight
      if (r.ok && r.value?.status === 'delivered') return markDelivered(deliveryId, r.value.inboxId, Boolean(r.value.duplicate));
      if (r.ok) {
        store.update((s) => { Object.assign(s.deliveries[deliveryId], { state: 'failed', lastError: r.value?.reason ?? 'refused' }); });
        emit('lesson_failed', { deliveryId, lessonId: d.lessonId, reason: r.value?.reason ?? 'refused' });
        return;
      }
      // Not delivered (Student down) → stays queued; uncertain (timeout) → reconcile before any re-send.
      if (r.outcome === 'not_delivered') session.unreachable = true;
      store.update((s) => { Object.assign(s.deliveries[deliveryId], { state: r.outcome === 'uncertain' ? 'uncertain' : 'queued', lastError: r.error }); });
      emit(r.outcome === 'uncertain' ? 'lesson_uncertain' : 'lesson_queued', { deliveryId, lessonId: d.lessonId, reason: r.error });
    } finally {
      inFlight.delete(deliveryId);
    }
  }
  function markDelivered(deliveryId, inboxId, duplicate) {
    if (!store.get().deliveries[deliveryId]) return; // reset while it was in flight
    store.update((s) => { Object.assign(s.deliveries[deliveryId], { state: 'delivered', inboxId: inboxId ?? null, deliveredAt: new Date().toISOString(), lastError: null }); });
    const d = store.get().deliveries[deliveryId];
    emit('lesson_delivered', { deliveryId, lessonId: d.lessonId, revision: d.revision, duplicate });
  }
  function flush(studentId = null) {
    for (const d of Object.values(store.get().deliveries)) {
      if ((d.state === 'queued' || d.state === 'uncertain') && (!studentId || d.studentId === studentId)) deliver(d.deliveryId);
    }
  }
  const pump = setInterval(() => { flush(); announceCourses(); }, retryMs);
  pump.unref?.();

  // ---- receipts and status --------------------------------------------------------------------------
  function receipt(msg, signature) {
    const d = store.get().deliveries[msg?.deliveryId];
    if (!d) return { status: 'rejected', reason: 'unknown_delivery' };
    const who = verifyStudent(d.studentId, ['receipt', d.deliveryId, msg.event], signature);
    if (who !== 'ok' || msg.studentId !== d.studentId) return { status: 'rejected', reason: who === 'ok' ? 'wrong_student' : who };
    if (msg.event !== 'opened') return { status: 'rejected', reason: 'unknown_event' };
    if (!d.openedAt) {
      store.update((s) => { s.deliveries[d.deliveryId].openedAt = new Date().toISOString(); });
      emit('lesson_opened', { deliveryId: d.deliveryId, lessonId: d.lessonId });
    }
    return { status: 'ok', openedAt: store.get().deliveries[d.deliveryId].openedAt };
  }
  function status(msg) {
    const who = verifyProfessor(msg, ['status', msg?.nonce]);
    if (who !== 'ok') return { status: 'rejected', reason: who };
    const courses = coursesOf(msg.professorId).map(([courseId, c]) => ({ courseId, title: c.title, enrolled: c.enrolled.map((sid) => ({ studentId: sid, name: cfg.studentNames?.[sid] ?? sid, online: sessions.has(sid) && !sessions.get(sid).unreachable })) }));
    const deliveries = Object.values(store.get().deliveries).filter((d) => d.professorId === msg.professorId)
      .map(({ deliveryId, lessonId, revision, studentId, state, attempts, lastError, deliveredAt, openedAt }) => ({ deliveryId, lessonId, revision, studentId, state, attempts, lastError, deliveredAt, openedAt }));
    return { status: 'ok', courses, deliveries };
  }

  // ---- course availability (once per course × student, ever — persisted here and in the Student's inbox) --
  async function announceCourses() {
    for (const [courseId, c] of Object.entries(cfg.courses ?? {})) {
      const e = registry.entry(c.professor);
      if (!registry.isReady(c.professor) || !e?.instanceId) continue;
      for (const studentId of c.enrolled) {
        const session = sessions.get(studentId);
        const endpoint = endpointOf(studentId);
        if (!session || !endpoint || session.unreachable) continue;
        const noticeId = `av-${courseId}`; // stable: a professor restart is not a new announcement
        const key = `${noticeId}|${studentId}`;
        if (store.get().notices[key] === 'sent' || inFlight.has(key)) continue;
        inFlight.add(key);
        try {
          const value = { type: 'course_available', noticeId, courseId, courseTitle: c.title, professorName: nameOf(c.professor), at: new Date().toISOString() };
          const r = await sendData(endpoint, { mediaType: COURSE_AVAILABLE_MEDIA_TYPE, value, metadata: { hubSignature: sign(session.callKey, ['notice', studentId, noticeId]) }, timeoutMs: deliverTimeoutMs });
          if (r.ok && r.value?.status === 'ok') {
            store.update((s) => { s.notices[key] = 'sent'; });
            emit('course_available_sent', { courseId, studentId, noticeId, duplicate: Boolean(r.value.duplicate) });
          }
        } finally {
          inFlight.delete(key);
        }
      }
    }
  }

  // A student's follow-up about a lesson goes to that lesson's professor — from the Hub's own record of
  // the delivery, never from keywords or the student's claim about who the professor is.
  function lessonRoute(studentId, deliveryId) {
    const d = store.get().deliveries[deliveryId];
    if (!d || d.studentId !== studentId) return null;
    const lesson = store.get().lessons[`${d.lessonId}#${d.revision}`];
    return { professorId: d.professorId, lessonId: d.lessonId, revision: d.revision, courseId: d.courseId, title: lesson?.title ?? '', kind: lesson?.kind ?? 'lesson', author: lesson?.author ?? 'professor', slotIds: lesson?.meeting?.slots.map((x) => x.slotId) ?? [] };
  }

  // Demo reset (the Student's New conversation, via the Hub's developer endpoint): every lesson, message,
  // delivery and availability notice is forgotten for every student; the professor posts again. Student
  // sessions stay. The course is announced again (once) to students who are connected.
  function reset() {
    store.update((s) => { s.lessons = {}; s.operations = {}; s.deliveries = {}; s.notices = {}; });
    emit('classroom_reset', {});
    setTimeout(() => announceCourses(), 300);
  }

  return {
    registerStudent, verifyStudent, publish, receipt, status, lessonRoute, announceCourses, flush, reset,
    sessionOf: (studentId) => (sessions.has(studentId) ? { since: sessions.get(studentId).since } : null),
    snapshot: () => ({ sessions: [...sessions.keys()], deliveries: Object.values(store.get().deliveries).map(({ deliveryId, lessonId, revision, studentId, state, openedAt }) => ({ deliveryId, lessonId, revision, studentId, state, opened: Boolean(openedAt) })) }),
    stop: () => clearInterval(pump),
    _newId: () => randomUUID(),
  };
}
