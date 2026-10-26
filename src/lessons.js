// Part 9: the application conventions for course lessons and student sessions, carried as typed A2A
// data parts (like Part 7's registration messages). These are THIS application's conventions — not
// standard A2A fields — sent with the protocol's normal message/send. Server side only.
//
// Routes:
//   Professor → Hub   lesson_publish (signed with the professor's registration key), lesson_status
//   Hub → Student     lesson_delivery, course_available, lesson_query (reconcile), session_challenge
//                     (all signed with the student's session key, except the challenge, which proves it)
//   Student → Hub     student_session (register), lesson_receipt (opened)
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MT = (name) => `application/vnd.a2a-spike.${name}+json`;
export const LESSON_PUBLISH_MEDIA_TYPE = MT('lesson-publish');
export const LESSON_STATUS_MEDIA_TYPE = MT('lesson-status');
export const LESSON_DELIVERY_MEDIA_TYPE = MT('lesson-delivery');
export const LESSON_QUERY_MEDIA_TYPE = MT('lesson-query');
export const LESSON_RECEIPT_MEDIA_TYPE = MT('lesson-receipt');
export const COURSE_AVAILABLE_MEDIA_TYPE = MT('course-available');
export const STUDENT_SESSION_MEDIA_TYPE = MT('student-session');
export const SESSION_CHALLENGE_MEDIA_TYPE = MT('session-challenge');
export const HUB_LESSON_MEDIA_TYPES = new Set([LESSON_PUBLISH_MEDIA_TYPE, LESSON_STATUS_MEDIA_TYPE, LESSON_RECEIPT_MEDIA_TYPE, STUDENT_SESSION_MEDIA_TYPE]);
export const STUDENT_INBOUND_MEDIA_TYPES = new Set([LESSON_DELIVERY_MEDIA_TYPE, LESSON_QUERY_MEDIA_TYPE, COURSE_AVAILABLE_MEDIA_TYPE, SESSION_CHALLENGE_MEDIA_TYPE]);

export const LIMITS = { title: 120, text: 4000 };
export const ID = /^[\w-]{6,80}$/;

// HMAC over a list of fields (joined with |). Keys are per-process, in memory, never logged.
export const sign = (key, fields) => createHmac('sha256', key).update(fields.map((f) => String(f ?? '')).join('|')).digest('base64url');
export function verify(key, fields, signature) {
  if (!key || typeof signature !== 'string') return false;
  const expected = Buffer.from(sign(key, fields));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
export const contentHash = (title, text) => createHash('sha256').update(JSON.stringify([title ?? '', text ?? ''])).digest('hex').slice(0, 32);

// The professor's draft, checked the same way by the Professor agent and the Hub. The text is lesson
// CONTENT: it is stored and shown as written, never interpreted as instructions.
export function validateLesson({ title, text }) {
  const errors = {};
  const t = typeof title === 'string' ? title.trim() : '';
  const body = typeof text === 'string' ? text.trim() : '';
  if (t.length > LIMITS.title) errors.title = `Keep the title under ${LIMITS.title} characters.`;
  if (!body) errors.text = 'Write what you would like your student to learn.';
  else if (body.length > LIMITS.text) errors.text = `Keep the lesson under ${LIMITS.text} characters.`;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values: { title: t, text: body } };
}

// One delivery per lesson revision and recipient: a stable id, so a repeat can never make a second one.
export const deliveryIdFor = (lessonId, revision, studentId) => `dl-${createHash('sha256').update(`${lessonId}|${revision}|${studentId}`).digest('hex').slice(0, 16)}`;
