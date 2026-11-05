// Part 16: a quiz notice (facts only) travels the Part 9 post path — Faculty -> Hub -> Student — hashed and
// validated at every hop, like the meeting offer. The Faculty side is the harness stand-in (it registers
// with the real Hub link and signs publishes); questions and answers never appear in a notice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { startStack, professorStandIn, openStream, waitFor, findAll } from './support/harness.js';
import { LESSON_PUBLISH_MEDIA_TYPE, LESSON_DELIVERY_MEDIA_TYPE, contentHash, deliveryIdFor, sign, validQuizNotice } from '../src/lessons.js';
import { createStudentInbox } from '../src/student-inbox.js';
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION, Role } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';

const QUIZ = { canvasQuizId: 4821, title: 'Topic 4 quiz', questions: 5, points: 15, minutes: 10, attempts: 1, dueAt: '2026-11-09T23:59:00-08:00' };
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c().catch(() => {}); });

test('existing hashes are byte-identical (computed before this change)', () => {
  assert.equal(contentHash('T', 'x', 'message'), '7ecbd2de1553671c5d7358676e62d8af', 'old professor post');
  const meeting = { meetingId: 'mt-abcdef123', slots: [{ slotId: 's1', start: '2026-11-10T14:00', label: 'x' }] };
  assert.equal(contentHash('T', 'x', 'message', 'professor', meeting), 'fe33467bc8119564c9be84e4ba961664', 'old meeting offer');
  assert.notEqual(contentHash('T', 'x', 'message', 'professor', null, QUIZ), contentHash('T', 'x', 'message'));
  assert.notEqual(contentHash('T', 'x', 'message', 'professor', null, { ...QUIZ, dueAt: '2026-11-10T23:59:00-08:00' }), contentHash('T', 'x', 'message', 'professor', null, QUIZ));
});

test('validQuizNotice accepts exactly the facts and nothing else', () => {
  assert.equal(validQuizNotice(null), true);
  assert.equal(validQuizNotice(QUIZ), true);
  for (const bad of [
    { ...QUIZ, correct: 'B' }, { ...QUIZ, answers: ['a'] },
    { ...QUIZ, canvasQuizId: 0 }, { ...QUIZ, canvasQuizId: 1.5 }, { ...QUIZ, title: '' }, { ...QUIZ, title: 'x'.repeat(121) },
    { ...QUIZ, questions: 0 }, { ...QUIZ, questions: 21 }, { ...QUIZ, points: 1.5 }, { ...QUIZ, minutes: 0 }, { ...QUIZ, minutes: 121 },
    { ...QUIZ, attempts: 0 }, { ...QUIZ, attempts: 4 }, { ...QUIZ, dueAt: 'next Monday' }, { ...QUIZ, dueAt: undefined }, [], 'quiz',
  ]) assert.equal(validQuizNotice(bad), false, JSON.stringify(bad));
  const { points, ...missing } = QUIZ;
  assert.equal(validQuizNotice(missing), false, 'a missing key');
});

test('a quiz notice to the whole class reaches Alex with the quiz intact, Sam is queued; extra keys and lessons are refused', async () => {
  const stack = await startStack({ library: false, uiEnv: { STUDENT_INBOX_FILE: join(mkdtempSync(join(tmpdir(), 'a2a-quiz-')), 'inbox.json') } });
  const prof = await professorStandIn(stack);
  const stream = await openStream(stack.ui.url);
  cleanups.push(async () => { stream.close(); await prof.close(); stack.kill(); });
  await waitFor(async () => (await (await fetch(`${stack.ui.url}/api/status`)).json()).student.session === 'registered', { what: 'student session', timeout: 8000 });

  const publish = (over = {}, quiz = QUIZ) => {
    const m = { type: 'lesson_publish', operationId: `quiz-notice-${randomUUID().slice(0, 8)}`, lessonId: `ls-${randomUUID().slice(0, 12)}`, revision: 1, courseId: 'mkt-351', kind: 'message', author: 'professor', ...(quiz ? { quiz } : {}), audience: 'all', title: 'Quiz posted', text: 'A new quiz is in Canvas.', ...over };
    return prof.link.sendSigned(LESSON_PUBLISH_MEDIA_TYPE, m, ['publish', m.operationId, m.lessonId, m.revision, m.courseId, m.kind, m.audience, contentHash(m.title, m.text, m.kind, m.author, null, quiz)], { timeoutMs: 15000 });
  };

  const ok = await publish();
  assert.ok(ok.deliveries, JSON.stringify(ok));
  const alex = ok.deliveries.find((d) => d.studentId === 'student-alex');
  const sam = ok.deliveries.find((d) => d.studentId === 'student-sam');
  assert.equal(alex.state, 'delivered');
  assert.equal(sam.state, 'queued', 'Sam has no endpoint');
  const received = await waitFor(() => findAll(stream.events, 'student', 'lesson_received').find((e) => e.data.quiz), { what: 'lesson_received with quiz' });
  assert.deepEqual(received.data.quiz, QUIZ);
  assert.equal(received.data.kind, 'message');
  const box = await (await fetch(`${stack.ui.url}/api/inbox`)).json();
  assert.ok(JSON.stringify(box).includes('4821'), 'stored in the inbox');

  // Extra keys (an answer key) are refused at the Hub.
  const r1 = await publish({}, { ...QUIZ, correct: ['A', 'B', 'C', 'D', 'A'] });
  assert.deepEqual([r1.status, r1.reason], ['rejected', 'malformed']);
  // A quiz on a lesson is refused too.
  const r2 = await publish({ kind: 'lesson' });
  assert.deepEqual([r2.status, r2.reason], ['rejected', 'malformed']);
  // The same operation with a changed due date is refused (it is a different post).
  const op = `quiz-notice-${randomUUID().slice(0, 8)}`;
  const lessonId = `ls-${randomUUID().slice(0, 12)}`;
  assert.ok((await publish({ operationId: op, lessonId })).deliveries);
  const changed = await publish({ operationId: op, lessonId }, { ...QUIZ, dueAt: '2026-11-10T23:59:00-08:00' });
  assert.equal(changed.status, 'rejected');
  assert.equal(changed.reason, 'operation_reused');
});

test('a tampered dueAt fails the Student’s own hash check; an extra key is refused there too', async () => {
  // A stand-in Hub (a real A2A server) whose only job is to learn the Student's per-process key at registration.
  let callKey = null;
  const hubExecutor = {
    async execute(ctx, bus) {
      const v = ctx.userMessage.parts.find((p) => p.content?.$case === 'data')?.content.value;
      if (v?.callKey) callKey = v.callKey;
      bus.publish(AgentEvent.message({ messageId: randomUUID(), contextId: ctx.contextId, taskId: '', role: Role.ROLE_AGENT, parts: [{ content: { $case: 'data', value: { status: 'registered' } }, metadata: undefined, filename: '', mediaType: 'application/json' }], metadata: undefined, extensions: [], referenceTaskIds: [] }));
      bus.finished();
    },
    async cancelTask() {},
  };
  const app = express();
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve(s))); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const card = { name: 'Stand-in Hub', description: 'test', version: '0', supportedInterfaces: [{ url: `${url}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' }], capabilities: { streaming: false, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [], defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], skills: [], signatures: [] };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), hubExecutor);
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler, cache: { maxAge: 0 } }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const events = [];
  const inbox = createStudentInbox({ studentId: 'student-alex', hubUrl: url, file: join(mkdtempSync(join(tmpdir(), 'a2a-quiz-in-')), 'inbox.json'), emit: (type, data) => events.push({ type, data }) });
  cleanups.push(async () => { inbox.stop(); await new Promise((r) => server.close(r)); });
  assert.equal(await inbox.register('http://127.0.0.1:9'), 'registered');
  assert.ok(callKey);

  const deliver = async (value) => {
    const acks = [];
    const sig = sign(callKey, ['delivery', 'student-alex', value.deliveryId, value.lessonId, value.revision, value.contentHash]);
    await inbox.executor.execute(
      { contextId: 'c1', userMessage: { parts: [{ content: { $case: 'data', value }, mediaType: LESSON_DELIVERY_MEDIA_TYPE }], metadata: { hubSignature: sig } } },
      { publish: (m) => acks.push(m), finished() {} });
    const ev = acks[0];
    return (ev.data ?? ev).parts.find((p) => p.content?.$case === 'data').content.value;
  };
  const base = (quiz, hashQuiz = quiz) => {
    const lessonId = `ls-${randomUUID().slice(0, 12)}`;
    return { type: 'lesson_delivery', deliveryId: deliveryIdFor(lessonId, 1, 'student-alex'), lessonId, revision: 1, courseId: 'mkt-351', kind: 'message', author: 'professor', meeting: null, quiz, toAll: true, courseTitle: 'Marketing 351', professorId: 'professor', professorName: 'Dr. Dabirian', title: 'Quiz posted', text: 'A new quiz is in Canvas.', postedAt: new Date().toISOString(), contentHash: contentHash('Quiz posted', 'A new quiz is in Canvas.', 'message', 'professor', null, hashQuiz) };
  };
  assert.equal((await deliver(base(QUIZ))).status, 'delivered');
  assert.deepEqual(events.find((e) => e.type === 'lesson_received').data.quiz, QUIZ);
  // The signed hash covers the real quiz, but the dueAt in the delivery was changed on the way.
  const tampered = await deliver(base({ ...QUIZ, dueAt: '2026-11-30T23:59:00-08:00' }, QUIZ));
  assert.deepEqual([tampered.status, tampered.reason], ['rejected', 'content_mismatch']);
  const leaky = await deliver(base({ ...QUIZ, correct: 'B' }));
  assert.deepEqual([leaky.status, leaky.reason], ['rejected', 'bad_quiz']);
});
