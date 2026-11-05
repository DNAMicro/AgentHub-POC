import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuizDesk, CLOSED_TEXT } from '../src/professor-quiz.js';

const NOW = new Date('2026-11-04T20:00:00Z'); // Wed Nov 4 2026, Pacific noon: topics 1-16 taught

const mkQ = (i) => ({ text: `Which statement number ${i} is correct?`, answers: [`a${i}`, `b${i}`, `c${i}`, `d${i}`], correct: i % 4, origin: 'ai' });

function setup({ now = NOW, canvasScript = [], postResult } = {}) {
  const calls = { create: [], publish: [], post: [], draft: 0, one: 0 };
  const events = [];
  let nextId = 4821;
  const script = [...canvasScript];
  const canvas = {
    async createQuiz(a) {
      calls.create.push(a);
      const s = script.shift();
      if (s) return typeof s === 'function' ? s(a) : s;
      const q = a.quiz;
      return { ok: true, value: { receipt: { quizId: nextId++, courseLabel: 'MKTG 351 (Fall 2026)', published: false, title: q.title, questionCount: q.questions.length, pointsTotal: q.questions.length * q.pointsEach, minutes: q.minutes, attempts: q.attempts, dueAt: q.dueAt, stepCount: 4 } } };
    },
    async publishQuiz(a) {
      calls.publish.push(a);
      const s = script.shift();
      if (s) return typeof s === 'function' ? s(a) : s;
      return { ok: true, value: { receipt: { quizId: a.quizId, published: true } } };
    },
  };
  const createPost = async (a) => {
    calls.post.push(a);
    if (postResult) return postResult(a);
    return { http: 200, body: { lesson: { lessonId: 'ls-1' }, ack: { status: 'accepted', deliveries: [{ studentId: 'student-alex', status: 'delivered' }, { studentId: 'student-sam', status: 'queued' }] } } };
  };
  const draftQuiz = async ({ topic, count }) => { calls.draft += 1; return { questions: Array.from({ length: count }, (_, i) => mkQ(i + 1)), by: 'mock', model: 'mock-model', short: 0 }; };
  const draftOne = async ({ existing }) => { calls.one += 1; return { question: { ...mkQ(50 + existing.length), text: `A brand new question ${existing.length} here?` }, by: 'mock', model: 'mock-model' }; };
  const desk = createQuizDesk({ canvas, createPost, draftQuiz, draftOne, now: () => now, emit: (type, runId, data) => events.push({ type, runId, data }) });
  return { desk, calls, events };
}
async function drafted(s, said = 'make a quiz on segmentation, 4 questions', op = 'op-turn-1') {
  const r = await s.desk.turn(said, { operationId: op });
  assert.equal(r.action, 'quiz_draft');
  return r;
}
const fullQuiz = (s, id) => { const d = s.desk.draft(id); const { topic, title, pointsEach, minutes, attempts, dueAt, questions } = d.quiz; return { topic, title, pointsEach, minutes, attempts, dueAt, questions }; };
function keys(v, out = new Set()) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); } return out; }

test('non-quiz messages are not a quiz turn', async () => {
  const s = setup();
  assert.equal(await s.desk.turn('I will be out Friday'), null);
  assert.equal(await s.desk.turn('Topic 8'), null); // no pending question
  assert.equal(await s.desk.turn('make a quiz for @sam'), null);
});

test('no topic: asks the exact question with the topic list, no model call; then a chip draws a draft', async () => {
  const s = setup();
  const r = await s.desk.turn('@assistant create a quiz for Marketing 351', { operationId: 'op-1' });
  assert.equal(r.action, 'quiz_topics');
  assert.equal(r.reply, "Which topic should the quiz cover? Here's what Marketing 351 has covered so far — through Topic 16 (Tue, Nov 3).");
  assert.equal(r.topics.taughtThrough, 16);
  assert.equal(r.topics.units.length, 3);
  assert.equal(r.topics.units[2].topics.find((t) => t.n === 17).taught, false);
  assert.equal(r.topics.units[0].topics[0].taught, true);
  assert.equal(s.calls.draft, 0);
  const d = await s.desk.turn('Topic 8 · Segmentation & targeting', { operationId: 'op-2' });
  assert.equal(d.action, 'quiz_draft');
  assert.match(d.reply, /Topic 8/);
  assert.equal(s.desk.draft(d.draftId).quiz.questions.length, 5);
  assert.equal(s.desk.card().state, 'draft');
});

test('a pending answer that is not a topic is left for other handlers; a bare number works', async () => {
  const s = setup();
  await s.desk.turn('create a quiz');
  assert.equal(await s.desk.turn('I will be out Friday'), null);
  const d = await s.desk.turn('8');
  assert.equal(d.action, 'quiz_draft');
});

test('topic and count in one message; count clamped to 20', async () => {
  const s = setup();
  const r = await drafted(s, 'make a quiz on segmentation, 8 questions');
  const d = s.desk.draft(r.draftId);
  assert.equal(d.topic, 8);
  assert.equal(d.quiz.questions.length, 8);
  assert.equal(d.quiz.title, 'Topic 8 Quiz: Segmentation & Targeting');
  assert.equal(d.drafted.model, 'mock-model');
});

test('untaught topic: exact reply with list, the model is never called', async () => {
  const s = setup();
  const r = await s.desk.turn('make a quiz on pricing', { operationId: 'op-u' });
  assert.equal(r.reply, "Pricing concepts (Topic 19) is taught on Thu, Nov 19 — it hasn't been covered yet. Pick a covered topic.");
  assert.equal(r.action, 'quiz_topics');
  assert.ok(r.topics);
  assert.equal(s.calls.draft, 0);
  assert.equal(s.desk.card(), null);
});

test('before the term: exact reply, no model call', async () => {
  const s = setup({ now: new Date('2026-08-20T19:00:00Z') });
  const r = await s.desk.turn('create a quiz on segmentation');
  assert.equal(r.reply, 'No Marketing 351 topics have been taught yet this term — the first class is Tue, Aug 25.');
  assert.equal(s.calls.draft, 0);
});

test('a second request while a draft is open gets the exact notice', async () => {
  const s = setup();
  await drafted(s);
  const r = await s.desk.turn('make another quiz on retailing');
  assert.equal(r.reply, 'You have a draft open (Topic 8). Approve or discard it first.');
  assert.equal(s.calls.draft, 1);
});

test('approve: saved unpublished, Canvas gets the checked quiz, exact copy, outcome-only entry', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const r = await s.desk.action({ draftId, operationId: 'op-a1', action: 'approve', quiz: fullQuiz(s, draftId) });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'saved');
  assert.equal(r.canvasQuizId, 4821);
  assert.equal(r.text, "Saved in Canvas as an unpublished quiz — students can't see it yet.");
  assert.equal(r.prompt, 'Publish it now? Publishing makes it visible in Canvas, and your students get a notification.');
  assert.deepEqual(r.entries.map((e) => e.text), ['Saved in Canvas as quiz #4821']);
  assert.equal(s.calls.create.length, 1);
  assert.equal(s.calls.create[0].runId, 'prof-op-a1');
  assert.equal(s.desk.card().state, 'saved');
  assert.equal(s.desk.card().canvasQuizId, 4821);
});

test('Review 2: approve twice with the same operationId makes one Canvas call', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const quiz = fullQuiz(s, draftId);
  const [a, b] = await Promise.all([
    s.desk.action({ draftId, operationId: 'op-same', action: 'approve', quiz }),
    s.desk.action({ draftId, operationId: 'op-same', action: 'approve', quiz }),
  ]);
  const c = await s.desk.action({ draftId, operationId: 'op-same', action: 'approve', quiz });
  assert.equal(s.calls.create.length, 1);
  assert.equal(a.canvasQuizId, 4821); assert.equal(b.canvasQuizId, 4821); assert.equal(c.canvasQuizId, 4821);
  // the same id with other values is refused, not replayed
  const other = await s.desk.action({ draftId, operationId: 'op-same', action: 'approve', quiz: { ...quiz, minutes: 20 } });
  assert.equal(other.code, 'operation_reused');
  assert.equal(s.calls.create.length, 1);
  // a different operation on an already saved draft does not file a second quiz
  const again = await s.desk.action({ draftId, operationId: 'op-other', action: 'approve', quiz });
  assert.equal(again.ok, true);
  assert.equal(s.calls.create.length, 1);
});

test('Review 4: approving a quiz on an untaught topic is refused with nothing sent', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const quiz = { ...fullQuiz(s, draftId), topic: 19 };
  const r = await s.desk.action({ draftId, operationId: 'op-nt', action: 'approve', quiz });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_taught');
  assert.equal(s.calls.create.length, 0);
  assert.equal(s.desk.card().state, 'draft');
});

test('approve refuses a bad quiz (authoritative check) and a topic that differs from the draft', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const quiz = fullQuiz(s, draftId);
  const bad = await s.desk.action({ draftId, operationId: 'op-b1', action: 'approve', quiz: { ...quiz, questions: [{ ...quiz.questions[0], correct: 9 }] } });
  assert.equal(bad.code, 'bad_question'); assert.equal(bad.index, 0);
  const other = await s.desk.action({ draftId, operationId: 'op-b2', action: 'approve', quiz: { ...quiz, topic: 9 } });
  assert.equal(other.ok, false);
  assert.equal(s.calls.create.length, 0);
});

test('publish: Canvas first, then the notice to all with facts only; keys of the notice carry no answer key', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  const r = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'published');
  assert.equal(s.calls.publish[0].quizId, 4821);
  assert.equal(s.calls.post.length, 1);
  const p = s.calls.post[0];
  assert.equal(p.operationId, `quiz-notice-${draftId}`);
  assert.equal(p.kind, 'message'); assert.equal(p.title, 'New quiz'); assert.equal(p.audience, 'all'); assert.equal(p.verbatim, false);
  assert.deepEqual(Object.keys(p.quiz).sort(), ['attempts', 'canvasQuizId', 'dueAt', 'minutes', 'points', 'questions', 'title']);
  assert.equal(p.quiz.questions, 4); assert.equal(p.quiz.points, 12); assert.equal(p.quiz.canvasQuizId, 4821);
  assert.ok(!keys(p).has('correct') && !keys(p).has('answers'));
  assert.match(p.text, /Take it in Canvas/);
  assert.match(r.text, /^Published — Topic 8 Quiz: Segmentation & Targeting is open in Canvas \(quiz #4821\), due /);
  assert.equal(s.desk.card().deliveries.length, 2);
  assert.deepEqual(s.desk.card().deliveries.map((d) => d.status), ['delivered', 'queued']);
  // pressing again never notifies twice
  await s.desk.action({ draftId, operationId: 'op-p2', action: 'publish' });
  assert.equal(s.calls.publish.length, 1); assert.equal(s.calls.post.length, 1);
});

test('publish before approve is refused; a failed Canvas publish sends no notice', async () => {
  const s = setup({ canvasScript: [null, { ok: false, outcome: 'uncertain' }] });
  const { draftId } = await drafted(s);
  const early = await s.desk.action({ draftId, operationId: 'op-e', action: 'publish' });
  assert.equal(early.ok, false);
  assert.equal(s.calls.publish.length, 0);
  s.calls.create.length = 0;
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  const r = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.equal(r.ok, false);
  assert.equal(r.text, "Canvas didn't answer, so the quiz may still be unpublished and nobody was notified. Press Publish again; it won't publish twice.");
  assert.equal(s.calls.post.length, 0);
  assert.equal(s.desk.card().state, 'saved');
  // retry with the same operationId reaches Canvas again (never cached)
  const again = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.equal(again.ok, true);
  assert.equal(s.calls.publish.length, 2);
  assert.equal(s.calls.publish[1].operationId, 'op-p');
  assert.equal(s.calls.post.length, 1);
});

test('keep as draft: exact copy; publish still works afterwards', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  const k = await s.desk.action({ draftId, operationId: 'op-k', action: 'keep_draft' });
  assert.equal(k.text, 'Kept as a draft in Canvas (quiz #4821). Nobody was notified.');
  assert.equal(k.entries[0].text, k.text);
  assert.equal(s.desk.card().state, 'kept');
  assert.equal(s.calls.post.length, 0);
  const p = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.equal(p.ok, true);
  assert.equal(s.desk.card().state, 'published');
});

test('discard closes the card; nothing is sent; the next quiz request works', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const r = await s.desk.action({ draftId, operationId: 'op-d', action: 'discard' });
  assert.equal(r.ok, true);
  assert.equal(s.calls.create.length, 0);
  assert.equal(s.desk.card(), null);
  assert.equal(s.desk.draft(draftId), null);
  const next = await s.desk.turn('make a quiz on retailing');
  assert.equal(next.action, 'quiz_draft');
});

test('one more: returns the new question, told the existing ones; untaught or full is refused', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const r = await s.desk.action({ draftId, operationId: 'op-m', action: 'one_more', quiz: fullQuiz(s, draftId) });
  assert.equal(r.ok, true);
  assert.equal(r.question.origin, 'ai');
  assert.equal(s.calls.one, 1);
  const dup = await s.desk.action({ draftId, operationId: 'op-m', action: 'one_more', quiz: fullQuiz(s, draftId) });
  assert.equal(dup.duplicate, true);
  assert.equal(s.calls.one, 1);
  // a topic that is not taught by the (moved) clock is refused and never calls the model
  let clock = NOW;
  const t = setup();
  const desk2 = createQuizDesk({ canvas: {}, createPost: async () => ({}), draftQuiz: async ({ count }) => ({ questions: Array.from({ length: count }, (_, i) => mkQ(i + 1)), by: 'mock', model: 'm', short: 0 }), draftOne: async () => { throw new Error('model called'); }, now: () => clock });
  const d2 = await desk2.turn('make a quiz on retailing, 3 questions');
  clock = new Date('2026-09-01T19:00:00Z'); // before Topic 14 was taught
  const r2 = await desk2.action({ draftId: d2.draftId, operationId: 'op-m2', action: 'one_more' });
  assert.equal(r2.code, 'not_taught');
  assert.ok(t);
});

test('failure copy: approve outcomes, nothing cached, the card stays a draft', async () => {
  const outcomes = [
    ['unavailable', "Canvas didn't answer. Nothing is posted until it confirms — press Approve again; it won't post twice."],
    ['uncertain', "Canvas didn't answer. Nothing is posted until it confirms — press Approve again; it won't post twice."],
    ['tool_refused', 'Something went wrong on our side, so nothing was sent to Canvas. Press Approve again.'],
    ['tool_choice_failed', 'Something went wrong on our side, so nothing was sent to Canvas. Press Approve again.'],
    ['not_configured', "Canvas isn't connected, so nothing was sent."],
  ];
  for (const [outcome, text] of outcomes) {
    const s = setup({ canvasScript: [{ ok: false, outcome }] });
    const { draftId } = await drafted(s);
    const quiz = fullQuiz(s, draftId);
    const r = await s.desk.action({ draftId, operationId: 'op-f', action: 'approve', quiz });
    assert.equal(r.ok, false, outcome);
    assert.equal(r.text, text, outcome);
    assert.equal(s.desk.card().state, 'draft');
    const retry = await s.desk.action({ draftId, operationId: 'op-f', action: 'approve', quiz });
    assert.equal(retry.ok, true, `${outcome} retry`);
    assert.equal(s.calls.create.length, 2);
    assert.equal(retry.canvasQuizId, 4821);
  }
});

test('failure copy: publish tool problems', async () => {
  for (const [outcome, text] of [
    ['tool_refused', 'Something went wrong on our side, so nothing was sent to Canvas. Press Publish again.'],
    ['tool_choice_failed', 'Something went wrong on our side, so nothing was sent to Canvas. Press Publish again.'],
  ]) {
    const s = setup({ canvasScript: [null, { ok: false, outcome }] });
    const { draftId } = await drafted(s);
    await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
    const r = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
    assert.equal(r.text, text);
    assert.equal(s.calls.post.length, 0);
  }
});

test('Canvas refusal reopens the card with its plain sentence and is remembered', async () => {
  const s = setup({ canvasScript: [{ ok: false, outcome: 'refused', code: 'due_in_past', reason: 'That due date has already passed.' }] });
  const { draftId } = await drafted(s);
  const quiz = fullQuiz(s, draftId);
  const r = await s.desk.action({ draftId, operationId: 'op-r', action: 'approve', quiz });
  assert.equal(r.text, 'That due date has already passed.');
  assert.equal(r.code, 'due_in_past');
  assert.equal(r.state, 'draft');
  await s.desk.action({ draftId, operationId: 'op-r', action: 'approve', quiz });
  assert.equal(s.calls.create.length, 1);
});

test('a notice failure after a confirmed publish is honest and retryable without a second Canvas publish', async () => {
  let fail = true;
  const s = setup({ postResult: () => (fail ? { http: 502, body: {} } : { http: 200, body: { ack: { status: 'accepted', deliveries: [{ studentId: 'student-alex', status: 'delivered' }] } } }) });
  const { draftId } = await drafted(s);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  const r = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.equal(r.ok, false);
  assert.equal(r.published, true);
  assert.equal(s.desk.card().state, 'published');
  fail = false;
  const again = await s.desk.action({ draftId, operationId: 'op-p2', action: 'publish' });
  assert.equal(again.ok, true);
  assert.equal(s.calls.publish.length, 1);
  assert.equal(s.calls.post.length, 2);
  assert.equal(s.calls.post[0].operationId, s.calls.post[1].operationId);
});

test('Review Focus 1: the class list is unavailable when the notice goes out: the plain sentence, published stays true, and the retry sends it once', async () => {
  let down = true;
  const s = setup({ postResult: () => (down ? { http: 422, body: { lesson: { lessonId: 'ls-1' }, ack: { status: 'rejected', reason: 'roster_unavailable', accepted: false, deliveries: [] } } } : { http: 200, body: { ack: { status: 'accepted', deliveries: [{ studentId: 'student-alex', status: 'delivered' }] } } }) });
  const { draftId } = await drafted(s);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  const r = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.equal(r.ok, false);
  assert.equal(r.published, true);
  assert.equal(r.text, "Published in Canvas, but I couldn't get your class list, so students weren't told yet. Press Publish again in a moment — they're notified only once.");
  assert.ok(!/roster_unavailable|CHRS|Hub/i.test(r.text));
  down = false;
  const again = await s.desk.action({ draftId, operationId: 'op-p2', action: 'publish' });
  assert.equal(again.ok, true);
  assert.equal(s.calls.publish.length, 1, 'Canvas was published once');
});

test('F1: a notice that failed after the publish stays on the card summary (noticePending + the sentence) until it goes out', async () => {
  let down = true;
  const s = setup({ postResult: () => (down ? { http: 422, body: { lesson: { lessonId: 'ls-1' }, ack: { status: 'rejected', reason: 'roster_unavailable', accepted: false, deliveries: [] } } } : { http: 200, body: { ack: { status: 'accepted', deliveries: [{ studentId: 'student-alex', status: 'delivered' }] } } }) });
  const { draftId } = await drafted(s);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  assert.equal(s.desk.card().noticePending, undefined, 'nothing pending before the publish');
  await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  const c = s.desk.card();
  assert.equal(c.state, 'published');
  assert.equal(s.desk.card().title !== undefined, true);
  assert.equal(c.noticePending, true);
  assert.equal(c.noticeText, "Published in Canvas, but I couldn't get your class list, so students weren't told yet. Press Publish again in a moment — they're notified only once.");
  assert.equal(c.deliveries, undefined);
  down = false;
  const again = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.equal(again.ok, true, 'the same operation id retries (a retryable result is never cached)');
  const after = s.desk.card();
  assert.equal(after.noticePending, undefined);
  assert.equal(after.noticeText, undefined);
  assert.equal(after.deliveries.length, 1);
  assert.equal(s.calls.publish.length, 1, 'Canvas was published once');
  assert.equal(s.calls.post[1].operationId, `quiz-notice-${draftId}`);
});

test('F1: the other notice failure sentence is carried the same way', async () => {
  const s = setup({ postResult: () => ({ http: 502, body: {} }) });
  const { draftId } = await drafted(s);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.equal(s.desk.card().noticeText, 'Published in Canvas, but the class notice did not go out. Press Publish again to send it; students are notified only once.');
});

test('Review 3: reset mid-draft closes the card; the next draft has a different notice operationId', async () => {
  const s = setup();
  const first = await drafted(s);
  await s.desk.action({ draftId: first.draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, first.draftId) });
  const rs = s.desk.reset();
  assert.equal(rs.closed, 1);
  assert.equal(rs.entries[0].text, CLOSED_TEXT);
  assert.equal(CLOSED_TEXT, 'This draft was closed when the app restarted.');
  assert.equal(s.desk.card().state, 'closed');
  const late = await s.desk.action({ draftId: first.draftId, operationId: 'op-late', action: 'publish' });
  assert.equal(late.ok, false);
  assert.equal(late.text, CLOSED_TEXT);
  assert.equal(s.calls.publish.length, 0);
  // next draft (Canvas restarts numbering at 4821)
  const second = await drafted(s, 'make a quiz on segmentation, 4 questions', 'op-turn-2');
  assert.notEqual(second.draftId, first.draftId);
  await s.desk.action({ draftId: second.draftId, operationId: 'op-a2', action: 'approve', quiz: fullQuiz(s, second.draftId) });
  await s.desk.action({ draftId: second.draftId, operationId: 'op-p2', action: 'publish' });
  assert.equal(s.calls.post.length, 1);
  assert.equal(s.calls.post[0].operationId, `quiz-notice-${second.draftId}`);
  assert.notEqual(s.calls.post[0].operationId, `quiz-notice-${first.draftId}`);
});

test('Review 3b: reset while Canvas is answering gives the closed message, never success', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({ canvasScript: [async () => { await gate; return { ok: true, value: { receipt: { quizId: 4821, published: false } } }; }] });
  const { draftId } = await drafted(s);
  const p = s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.desk.card().state, 'saving');
  assert.equal(s.calls.create[0].isClosed(), false);
  s.desk.reset();
  assert.equal(s.calls.create[0].isClosed(), true);
  release();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.text, CLOSED_TEXT);
  assert.equal(s.desk.card().state, 'closed');
});

test('Review 5: card() and every entry carry no answer key at any depth; draft() does', async () => {
  const s = setup();
  const t = await drafted(s);
  const { draftId } = t;
  const all = [s.desk.card(), t.entries];
  assert.ok(keys(s.desk.draft(draftId)).has('correct'), 'only while it is a draft');
  const a = await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  all.push(s.desk.card(), a.entries);
  const p = await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  all.push(s.desk.card(), p.entries);
  assert.equal(s.desk.draft(draftId), null, 'M-1: the key is no longer served once the quiz is saved in Canvas');
  all.push(s.desk.reset().entries);
  for (const v of all) {
    const k = keys(v);
    for (const bad of ['correct', 'answers', 'questions', 'text_']) assert.ok(!k.has(bad), `${bad} leaked`);
  }
  assert.deepEqual(Object.keys(s.desk.card()).sort(), ['canvasQuizId', 'deliveries', 'draftId', 'pointsTotal', 'questionCount', 'state', 'topic']); // closed by the reset: no title (round 2 R6 adds it only while published)
});

test('telemetry carries ids, counts, outcome and code only: no question, answer or title text', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  assert.ok(s.events.length >= 3);
  assert.ok(s.events.every((e) => e.runId.startsWith('prof-')));
  const blob = JSON.stringify(s.events);
  assert.ok(!/Which statement|Segmentation|Quiz:/.test(blob), blob);
  assert.ok(!/"(correct|answers|title|text)"/.test(blob), blob);
});

test('malformed action bodies are refused without touching Canvas', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  for (const body of [{}, { draftId, operationId: 'op-z', action: 'explode' }, { draftId, action: 'approve' }, { draftId: 7, operationId: 'op-y', action: 'approve' }]) {
    const r = await s.desk.action(body);
    assert.equal(r.ok, false);
  }
  assert.equal(s.calls.create.length, 0);
});

test('7b minors: topics() before the term returns the before-term reply, not a crash', () => {
  const s = setup({ now: new Date('2026-08-20T19:00:00Z') });
  const r = s.desk.topics(8);
  assert.equal(r.action, 'quiz_before_term');
  assert.match(r.reply, /first class is Tue, Aug 25/);
});

test('7b minors: one more re-checks closed after the model call', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  let release; const gate = new Promise((r) => { release = r; });
  const slow = createQuizDesk({ canvas: {}, createPost: async () => ({}), now: () => NOW, draftQuiz: async ({ count }) => ({ questions: Array.from({ length: count }, (_, i) => mkQ(i + 1)), by: 'mock', short: 0 }), draftOne: async () => { await gate; return { question: mkQ(60), by: 'mock' }; } });
  const t = await slow.turn('make a quiz on segmentation, 4 questions', { operationId: 'op-x1' });
  const p = slow.action({ draftId: t.draftId, operationId: 'op-more1', action: 'one_more' });
  await new Promise((r) => setImmediate(r));
  slow.reset();
  release();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.text, CLOSED_TEXT);
  assert.equal(draftId.startsWith('qd-'), true);
});

test('7b minors: a reset during the draft call leaves no live draft', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const desk = createQuizDesk({ canvas: {}, createPost: async () => ({}), now: () => NOW, draftQuiz: async ({ count }) => { await gate; return { questions: Array.from({ length: count }, (_, i) => mkQ(i + 1)), by: 'mock', short: 0 }; } });
  const p = desk.turn('make a quiz on segmentation, 4 questions', { operationId: 'op-y1' });
  await new Promise((r) => setImmediate(r));
  desk.reset();
  release();
  const r = await p;
  assert.equal(r.action, 'quiz_draft_failed');
  assert.equal(desk.card(), null);
  assert.equal((await desk.turn('make a quiz on segmentation, 4 questions', { operationId: 'op-y2' })).action, 'quiz_draft');
});

test('7b minors: approve on a published card returns the published text; draft() is null for a closed card', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const quiz = fullQuiz(s, draftId);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz });
  await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  const again = await s.desk.action({ draftId, operationId: 'op-a-again', action: 'approve', quiz });
  assert.equal(again.ok, true);
  assert.match(again.text, /^Published — /);
  assert.equal(s.calls.create.length, 1);
  assert.equal(s.desk.draft(draftId), null, 'M-1: past the draft state there is no key to fetch');
  s.desk.reset();
  assert.equal(s.desk.draft(draftId), null);
});

test('7b: topics() (interpret path) holds the question; a draft open answers with the open-draft notice', async () => {
  const s = setup();
  assert.equal(s.desk.topics(8).action, 'quiz_topics');
  assert.equal((await s.desk.turn('Topic 8 · Segmentation & targeting', { operationId: 'op-t1' })).action, 'quiz_draft');
  assert.equal(s.desk.topics().action, 'quiz_draft_open');
});

// ---- Final review fixes ------------------------------------------------------------------------------------------
const CHIPS = [[8, 'Topic 8 · Segmentation & targeting']];
const topicName = async (n) => (await import('../src/course-schedule.js')).TOPICS.find((t) => t.n === n).name;

test('C-1 desk: a chip’s exact text is claimed with no waiting question, a draft open, after publish and after a restart', async () => {
  const chip = async (n) => `Topic ${n} · ${await topicName(n)}`;
  const s = setup();
  assert.equal(CHIPS[0][1], await chip(8));
  // no waiting question (a restart): a chip starts a request with the default count
  const first = await s.desk.turn(await chip(8), { operationId: 'op-c1' });
  assert.equal(first.action, 'quiz_draft');
  assert.equal(s.desk.draft(first.draftId).quiz.questions.length, 5);
  // a draft open: a stale chip says so
  const open = await s.desk.turn(await chip(9));
  assert.deepEqual([open.action, open.reply], ['quiz_draft_open', 'You have a draft open (Topic 8). Approve or discard it first.']);
  // structured pick
  assert.equal((await s.desk.turn('anything', { quizTopic: 9 })).action, 'quiz_draft_open');
  // after publish the chip is a new request
  await s.desk.action({ draftId: first.draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, first.draftId) });
  await s.desk.action({ draftId: first.draftId, operationId: 'op-p', action: 'publish' });
  const posts = s.calls.post.length;
  assert.equal((await s.desk.turn(await chip(8))).action, 'quiz_draft');
  assert.equal(s.calls.post.length, posts, 'a chip never posts anything');
  // chips for a topic that has not been taught: the untaught reply, never a post
  const later = await setup().desk.turn(await chip(17));
  assert.equal(later.action, 'quiz_topics');
  assert.match(later.reply, /hasn't been covered yet/);
  // text that only looks like a chip (wrong name) is not claimed
  assert.equal(await setup().desk.turn('Topic 8 · Something else'), null);
});

test('M-2: a kept draft blocking a new quiz says it is saved in Canvas', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz: fullQuiz(s, draftId) });
  await s.desk.action({ draftId, operationId: 'op-k', action: 'keep_draft' });
  const want = 'You have a quiz saved as a draft in Canvas (Topic 8). Publish or discard it first.';
  assert.equal((await s.desk.turn('make a quiz on segmentation')).reply, want);
  assert.equal((await s.desk.turn(`Topic 9 · ${await topicName(9)}`)).reply, want);
  assert.equal(s.desk.topics().reply, want);
});

test('I-1 desk: only a number, "topic N", a chip or a short reply naming a topic answers a waiting question; it expires after 15 minutes', async () => {
  let t = NOW.getTime();
  const clock = () => new Date(t); // a movable clock
  const { createQuizDesk } = await import('../src/professor-quiz.js');
  const desk = createQuizDesk({ canvas: {}, createPost: async () => ({ http: 200, body: {} }), draftQuiz: async ({ count }) => ({ questions: Array.from({ length: count }, (_, i) => mkQ(i + 1)), by: 'mock', model: 'm', short: 0 }), now: clock });
  assert.equal((await desk.turn('make a quiz')).action, 'quiz_topics');
  for (const line of ['Reminder: read the pricing chapter before Friday', 'Great discussion on social media today, everyone', 'I liked the segmentation lecture a lot today', 'hello']) {
    assert.equal(await desk.turn(line), null, line);
  }
  assert.equal(desk.pending(), true, 'the question still waits');
  assert.equal((await desk.turn('segmentation please')).action, 'quiz_draft'); // 3 words naming a topic
  // expiry
  const d2 = createQuizDesk({ canvas: {}, createPost: async () => ({}), draftQuiz: async () => ({ questions: [mkQ(1)], by: 'mock', model: 'm', short: 0 }), now: clock });
  assert.equal((await d2.turn('make a quiz')).action, 'quiz_topics');
  t += 14 * 60_000;
  assert.equal(d2.pending(), true);
  t += 2 * 60_000;
  assert.equal(d2.pending(), false);
  assert.equal(await d2.turn('8'), null, 'a bare number no longer answers an expired question');
  assert.equal(await d2.turn('Topic 8'), null);
});

test('I-3: "draft one more" is told the questions the page holds (his edits), and refuses at 20', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const mine = ['My own rewritten question one here?', 'My own rewritten question two here?'];
  const r = await s.desk.action({ draftId, operationId: 'op-m1', action: 'one_more', existing: mine });
  assert.equal(r.ok, true);
  assert.equal(r.question.text, 'A brand new question 2 here?', 'draftOne saw exactly the page’s two texts');
  const full = Array.from({ length: 20 }, (_, i) => `Question number ${i} about segmentation?`);
  const refused = await s.desk.action({ draftId, operationId: 'op-m2', action: 'one_more', existing: full });
  assert.equal(refused.ok, false);
  assert.equal(refused.text, 'A quiz can have at most 20 questions.');
  for (const bad of [Array.from({ length: 21 }, () => 'x'), ['y'.repeat(301)], [5], 'not a list']) {
    const b = await s.desk.action({ draftId, operationId: `op-m-${Math.random().toString(36).slice(2, 8)}`, action: 'one_more', existing: bad });
    assert.equal(b.refused, true);
    assert.equal(b.code, 'bad_request');
  }
  // the same operation id with a different list is not the same request
  const reuse = await s.desk.action({ draftId, operationId: 'op-m1', action: 'one_more', existing: [...mine, 'extra one here?'] });
  assert.equal(reuse.code, 'operation_reused');
});

test('M-3: Canvas not configured is a definite answer (not retryable, nothing cached as unknown), text unchanged', async () => {
  const s = setup({ canvasScript: [{ ok: false, outcome: 'not_configured' }] });
  const { draftId } = await drafted(s);
  const r = await s.desk.action({ draftId, operationId: 'op-nc', action: 'approve', quiz: fullQuiz(s, draftId) });
  assert.equal(r.ok, false);
  assert.ok(!r.retryable && !r.unknownOutcome);
  assert.equal(r.text, "Canvas isn't connected, so nothing was sent.");
  assert.equal(r.state, 'draft');
});

test('M-4: approving after Discard says the draft was discarded; after a reset it says the app restarted', async () => {
  const s = setup();
  const a = await drafted(s);
  const quiz = fullQuiz(s, a.draftId);
  await s.desk.action({ draftId: a.draftId, operationId: 'op-d', action: 'discard' });
  const r = await s.desk.action({ draftId: a.draftId, operationId: 'op-after', action: 'approve', quiz });
  assert.equal(r.text, 'This draft was discarded.');
  const unknown = await s.desk.action({ draftId: 'qd-neverexisted', operationId: 'op-x', action: 'approve', quiz });
  assert.equal(unknown.text, CLOSED_TEXT);
});

test('M-8: a typed count survives the @assistant topics path', async () => {
  const s = setup();
  s.desk.topics(null, 8);
  assert.equal((await s.desk.turn('8')).action, 'quiz_draft');
  assert.equal(s.desk.draft(s.desk.card().draftId).quiz.questions.length, 8);
});

// ---- Part 17 faculty scenarios, round 2 ------------------------------------------------------------------------------
test('R6: the card summary carries the title and due date (never a question or an answer), so a published card reads right after a reload', async () => {
  const s = setup();
  const { draftId } = await drafted(s);
  const quiz = fullQuiz(s, draftId);
  assert.equal(s.desk.card().title, undefined, 'a draft: no title on the shared state');
  await s.desk.action({ draftId, operationId: 'op-a', action: 'approve', quiz });
  assert.equal(s.desk.card().title, undefined, 'saved, not published: still none');
  await s.desk.action({ draftId, operationId: 'op-p', action: 'publish' });
  const c = s.desk.card();
  assert.equal(c.state, 'published');
  assert.equal(s.desk.card().title !== undefined, true);
  assert.equal(c.title, quiz.title);
  assert.equal(c.dueAt, quiz.dueAt);
  assert.equal(c.minutes, quiz.minutes);
  assert.equal(c.attempts, quiz.attempts);
  const k = keys(c);
  for (const secret of ['questions', 'answers', 'correct', 'text']) assert.equal(k.has(secret), false, secret);
});
