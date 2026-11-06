// Part 16, Task 7b: the quiz desk wired into the Faculty agent, the Hub's author proxy and the UI server, against a
// real Canvas stand-in (mock modes, pinned clock). These prove plumbing and code-decided outcomes, not live judgment.
// Temp stacks only: never the demo's ports and never data/*.json.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack, startCanvas, stopProcess, post, openStream, waitFor } from './support/harness.js';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';
import { TOPICS, dayLabel, taughtTopics } from '../src/course-schedule.js';

const NOW = '2026-11-04T20:00:00Z'; // Wed Nov 4 2026, Pacific noon: topics 1-16 taught
const MOCK = { hubEnv: { ROUTER_MODE: 'mock', HUB_STUDENTS: 'student-alex,student-sam' }, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' } };
const SAVED_TEXT = "Saved in Canvas as a draft (5 questions). Students can't see it yet.";
const TOPICS_REPLY = "Which topic should the quiz cover? Here's what Marketing 351 has covered so far — through Topic 16 (Tue, Nov 3).";
let s;
const stacks = [];

const start = async (over = {}) => {
  const st = await startStack({ library: false, professor: true, canvas: true, now: NOW, ...MOCK, ...over });
  stacks.push(st);
  return st;
};
before(async () => { s = await start({ hr: true, hrEnv: { HR_TEST_HOOKS: '1' } }); });
after(() => stacks.forEach((st) => st.kill()));
// Every test starts from a fresh classroom: chat, drafts, HR records and Canvas's quizzes (the Student's New conversation).
beforeEach(async () => {
  const r = await (await post(`${s.hub.url}/dev/classroom/reset`, {})).json();
  assert.equal(r.hr, 'reset');
  assert.deepEqual(await quizzes(), []);
});

const say = async (text, on = s, operationId = `op-${randomUUID()}`) => {
  const res = await post(`${on.ui.url}/api/professor/chat`, { operationId, text });
  return { http: res.status, ...(await res.json()) };
};
const state = async (on = s) => (await fetch(`${on.ui.url}/api/professor/state`)).json();
const quizzes = async (on = s) => (await (await fetch(`${on.canvas.url}/test/quizzes`)).json()).quizzes;
const getDraft = async (draftId, on = s) => { const r = await fetch(`${on.ui.url}/api/professor/quiz/${draftId}`); return { http: r.status, ...(await r.json()) }; };
const act = async (body, on = s) => { const r = await post(`${on.ui.url}/api/professor/quiz/actions`, { operationId: `op-${randomUUID()}`, ...body }); return { http: r.status, ...(await r.json()) }; };
const fullQuiz = (d) => { const { topic, title, pointsEach, minutes, attempts, dueAt, questions } = d.quiz; return { topic, title, pointsEach, minutes, attempts, dueAt, questions }; };
const draftTopic8 = async (on = s, text = 'make a quiz on segmentation') => {
  const r = await say(text, on);
  assert.equal(r.action, 'quiz_draft', JSON.stringify(r));
  const d = await getDraft(r.draftId, on);
  assert.equal(d.http, 200);
  return { r, d };
};
const keys = (v, out = new Set()) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); } return out; };
const inbox = async (on = s) => (await fetch(`${on.ui.url}/api/inbox`)).json();

test('a quiz request answers with the topic list: no HR call even with an HR card open, no direct post', async () => {
  const stream = await openStream(s.ui.url);
  try {
    const r0 = await say('I want to file for time off. My grandmother passed away, I need this Thursday and Friday');
    assert.equal(r0.action, 'staff');
    const before = await state();
    assert.ok(before.hrCard?.formRef, 'an HR card is open');
    const decisionsBefore = stream.events.filter((e) => e.type === 'staff_decision').length;

    const r = await say('@assistant create a quiz for Marketing 351');
    assert.equal(r.http, 200);
    assert.equal(r.action, 'quiz_topics');
    assert.equal(r.reply, TOPICS_REPLY);
    assert.equal(r.topics.taughtThrough, 16);
    assert.equal(r.topics.units.length, 3);
    const after = await state();
    assert.equal(after.hrCard.formRef, before.hrCard.formRef, 'the HR card is untouched');
    assert.equal(after.lessons.length, 0, 'nothing was posted to students');
    assert.equal((await (await fetch(`${s.hr.url}/test/hr/requests`)).json()).requests.length, 0, 'nothing filed with HR');
    assert.equal(stream.events.filter((e) => e.type === 'staff_decision').length, decisionsBefore, 'the staff desk did not run');
    const entry = after.chat.filter((m) => m.role === 'assistant').at(-1);
    assert.equal(entry.text, TOPICS_REPLY);
    assert.equal(entry.quizTopics.topics.taughtThrough, 16);
    // The topic answer reaches the same desk, not HR, while the card is open.
    const d = await say('Topic 8');
    assert.equal(d.action, 'quiz_draft');
    assert.equal((await state()).hrCard.formRef, before.hrCard.formRef);
  } finally { stream.close(); }
});

test('the code-matched request makes no model call (live Faculty against the fake provider)', async () => {
  const stub = await startFakeAnthropic();
  stub.respondWith(() => messageReply('{}'));
  const t = await start({ hr: false, professorEnv: { PROFESSOR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
  try {
    const r = await say('@assistant create a quiz for Marketing 351', t);
    assert.equal(r.action, 'quiz_topics');
    assert.equal(stub.requests.length, 0, 'no interpret, classifier or draft call');
  } finally { await stub.close?.(); }
});

test('Topic 8 afterwards drafts; "make a quiz on segmentation, 8 questions" asks for 8', async () => {
  await say('@assistant create a quiz for Marketing 351');
  const t8 = await say('Topic 8');
  assert.equal(t8.action, 'quiz_draft');
  assert.match(t8.draftId, /^qd-/);
  const d = await getDraft(t8.draftId);
  assert.equal(d.topic, 8);
  assert.equal(d.state, 'draft');
  assert.ok(d.quiz.questions.length >= 1);
  assert.ok(keys(d).has('correct'), 'the Faculty view fetch carries the answer key');
  assert.deepEqual((await act({ draftId: t8.draftId, action: 'discard' })).state, 'discarded');
  const more = await say('make a quiz on segmentation, 8 questions');
  assert.equal(more.action, 'quiz_draft');
  const d8 = await getDraft(more.draftId);
  assert.equal(d8.drafted.wanted, 8);
  assert.equal(d8.quiz.questions.length + d8.drafted.short, 8);
});

test('an untaught topic gets the exact reply and no draft; before the term gets the before-term reply', async () => {
  const pricing = TOPICS.find((t) => /pricing/i.test(t.name) && t.taught > '2026-11-04');
  assert.ok(pricing, 'a later pricing topic exists in the schedule');
  const r = await say('make a quiz on pricing');
  assert.equal(r.action, 'quiz_topics');
  assert.equal(r.reply, `${pricing.name} (Topic ${pricing.n}) is taught on ${dayLabel(pricing.taught)} — it hasn't been covered yet. Pick a covered topic.`);
  assert.equal(r.highlight, pricing.n);
  assert.ok([null, 'closed'].includes((await state()).quizCard?.state ?? null), 'no live draft (an earlier test’s closed card may remain)');

  const early = await start({ hr: false, now: '2026-08-20T19:00:00Z' });
  const e = await say('make a quiz on segmentation', early);
  assert.equal(e.reply, 'No Marketing 351 topics have been taught yet this term — the first class is Tue, Aug 25.');
  assert.equal((await state(early)).quizCard, null);
});

test('a second request with a draft open gets the exact notice', async () => {
  await draftTopic8();
  const r = await say('@assistant create another quiz');
  assert.equal(r.reply, 'You have a draft open (Topic 8). Approve or discard it first.');
  assert.equal(r.draftId, undefined);
});

test('the interpret path (@assistant, words code did not match) lists topics and never drafts', async () => {
  const r = await say('@assistant I need a quiz on segmentation');
  assert.equal(r.action, 'quiz_topics');
  assert.equal(r.highlight, 8);
  assert.ok([null, 'closed'].includes((await state()).quizCard?.state ?? null), 'no draft in the same turn');
  const next = await say('Topic 8');
  assert.equal(next.action, 'quiz_draft');
});

test('approve saves one unpublished quiz #4821; the same operationId is not a second quiz; an untaught topic is refused with nothing sent', async () => {
  const { r, d } = await draftTopic8();
  const operationId = `op-${randomUUID()}`;
  const body = { draftId: r.draftId, operationId, action: 'approve', quiz: fullQuiz(d) };
  const a = await act(body);
  assert.equal(a.http, 200, JSON.stringify(a));
  assert.equal(a.state, 'saved');
  assert.equal(a.canvasQuizId, 4821);
  assert.equal(a.text, SAVED_TEXT);
  assert.equal((await quizzes()).length, 1);
  assert.equal((await quizzes())[0].published, false);
  const again = await act(body);
  assert.equal(again.http, 200);
  assert.equal(again.canvasQuizId, 4821);
  assert.equal((await quizzes()).length, 1, 'one quiz in Canvas');
  const mine = (await state()).chat.filter((m) => m.quiz?.draftId === r.draftId && /Saved in Canvas/.test(m.text));
  assert.equal(mine.length, 1, 'the replay did not add a second chat entry');
  assert.equal(mine[0].text, 'Saved in Canvas as quiz #4821 (5 questions).');

  // Direct to the Faculty agent (no UI check in between): a quiz on topic 19 is refused as not taught.
  const { r: r2 } = await (async () => { await act({ draftId: r.draftId, action: 'discard' }); return draftTopic8(); })();
  const d2 = await getDraft(r2.draftId);
  const bad = await post(`${s.professor.url}/author/quiz-action`, { draftId: r2.draftId, operationId: `op-${randomUUID()}`, action: 'approve', quiz: { ...fullQuiz(d2), topic: 19 } });
  const badJson = await bad.json();
  assert.equal(bad.status, 422, JSON.stringify(badJson));
  assert.equal(badJson.code, 'not_taught');
  // …and through the UI server the shared check says so before anything is sent.
  const viaUi = await act({ draftId: r2.draftId, action: 'approve', quiz: { ...fullQuiz(d2), topic: 19 } });
  assert.equal(viaUi.http, 400);
  assert.equal((await quizzes()).length, 1, 'nothing more reached Canvas');
});

test('strict keys and id formats are refused at the UI server, the proxy and the Faculty agent', async () => {
  const { r, d } = await draftTopic8();
  assert.equal((await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d), extra: 1 })).http, 400);
  assert.equal((await act({ draftId: 'x', action: 'discard' })).http, 400);
  assert.equal((await act({ draftId: r.draftId, action: 'explode' })).http, 400);
  assert.equal((await act({ draftId: r.draftId, action: 'publish', quiz: fullQuiz(d) })).http, 400);
  assert.equal((await post(`${s.professor.url}/author/quiz-action`, { draftId: r.draftId, operationId: 'x', action: 'discard' })).status, 400);
  assert.equal((await getDraft('bad id!')).http, 404);
  assert.equal((await fetch(`${s.professor.url}/author/quiz/qd-nosuchdraft`)).status, 404);
  // A cross-site browser POST is refused at the Faculty agent (non-GET routes are origin-guarded).
  const cross = await fetch(`${s.professor.url}/author/quiz-action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ draftId: r.draftId, operationId: `op-${randomUUID()}`, action: 'discard' }) });
  assert.equal(cross.status, 403);
});

test('publish: Canvas publishes, Alex gets the notice (quiz facts, no answer key), Sam is queued', async () => {
  const { r, d } = await draftTopic8();
  await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
  const p = await act({ draftId: r.draftId, action: 'publish' });
  assert.equal(p.http, 200, JSON.stringify(p));
  assert.equal(p.state, 'published');
  assert.equal((await quizzes())[0].published, true);
  await waitFor(async () => (await inbox()).notices?.length || (await inbox()).messages?.length || JSON.stringify(await inbox()).includes('4821'), { what: 'notice in Alex’s inbox', timeout: 8000 });
  const box = await inbox();
  assert.ok(JSON.stringify(box).includes('4821'));
  assert.ok(!keys(box).has('correct'), 'no answer key in the inbox');
  assert.ok(!JSON.stringify(box).includes(d.quiz.questions[0].text), 'no question text in the inbox');
  const st = await state();
  const post1 = st.lessons.find((l) => l.quiz?.canvasQuizId === 4821);
  assert.ok(post1, 'the notice is a post');
  assert.equal(post1.audience, 'all');
  assert.ok(!keys(post1).has('correct'));
  await waitFor(async () => { const l = (await state()).lessons.find((x) => x.quiz); return l?.deliveries.find((x) => x.studentId === 'student-alex')?.state === 'delivered'; }, { what: 'Alex delivered', timeout: 8000 });
  const l = (await state()).lessons.find((x) => x.quiz);
  assert.equal(l.deliveries.find((x) => x.studentId === 'student-sam').state, 'queued');
  assert.equal(st.chat.filter((m) => m.quiz?.draftId === r.draftId && /Published in Canvas/.test(m.text)).length, 1);
});

test('keep as draft: exact copy, nobody notified; publishing later still works', async () => {
  const { r, d } = await draftTopic8();
  await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
  const k = await act({ draftId: r.draftId, action: 'keep_draft' });
  assert.equal(k.text, 'Kept as a draft in Canvas (quiz #4821). Nobody was notified.');
  assert.equal((await state()).lessons.length, 0);
  assert.equal((await state()).quizCard.state, 'kept');
  const p = await act({ draftId: r.draftId, action: 'publish' });
  assert.equal(p.http, 200);
  assert.equal((await quizzes())[0].published, true);
});

test('Canvas stopped: Approve gives the exact "didn’t answer" copy; after Canvas is back the retry files once', async () => {
  const { r, d } = await draftTopic8();
  const port = new URL(s.canvas.url).port;
  await stopProcess(s.canvas);
  const operationId = `op-${randomUUID()}`;
  const body = { draftId: r.draftId, operationId, action: 'approve', quiz: fullQuiz(d) };
  const down = await act(body);
  assert.equal(down.http, 503, JSON.stringify(down));
  assert.equal(down.text, "Canvas didn't answer. Nothing is posted until it confirms — press Approve again; it won't post twice.");
  assert.equal((await state()).quizCard.state, 'draft');
  s.canvas = await startCanvas({ PORT: port, CANVAS_TOKEN: s.canvasToken, CANVAS_TEST_HOOKS: '1', CANVAS_NOW: NOW });
  const up = await act(body);
  assert.equal(up.http, 200, JSON.stringify(up));
  assert.equal(up.canvasQuizId, 4821);
  assert.equal((await quizzes()).length, 1, 'filed once');
});

test('the state, the Faculty stream and the monitor never carry the answer key', async () => {
  const { r, d } = await draftTopic8();
  assert.ok(keys(d).has('correct'));
  assert.equal(JSON.stringify(await state()).includes('"correct"'), false);
  const st = await state();
  assert.deepEqual(Object.keys(st.quizCard).sort(), ['canvasQuizId', 'draftId', 'pointsTotal', 'questionCount', 'state', 'topic']); // a draft: no title on the shared state (round 2 R6 adds it only once published)
  const abort = new AbortController();
  const res = await fetch(`${s.ui.url}/api/ag-ui/professor/stream`, { signal: abort.signal });
  let text = '';
  (async () => { try { for await (const c of res.body.pipeThrough(new TextDecoderStream())) text += c; } catch { /* aborted */ } })();
  const monitor = await openStream(s.ui.url);
  await waitFor(() => text.includes('STATE_SNAPSHOT'), { what: 'professor snapshot' });
  await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
  await new Promise((x) => setTimeout(x, 800));
  abort.abort();
  monitor.close();
  assert.ok(text.includes('quizCard'), 'the card summary is in the Faculty snapshot');
  assert.equal(text.includes('"correct"'), false, 'no answer key in the Faculty stream');
  assert.equal(JSON.stringify(monitor.events).includes('"correct"'), false, 'no answer key in the monitor');
});

test('New conversation mid-draft closes the card; Canvas is empty; the next quiz is #4821 and its notice is delivered', async () => {
  const { r, d } = await draftTopic8();
  await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
  assert.equal((await quizzes()).length, 1);
  const reset = await (await post(`${s.hub.url}/dev/classroom/reset`, {})).json();
  assert.equal(reset.professors[Object.keys(reset.professors)[0]] !== undefined, true);
  const st = await state();
  assert.equal(st.quizCard.state, 'closed');
  assert.ok(!st.chat.some((m) => m.text === 'This draft was closed when the app restarted.'), 'review D17: no closed line in the chat');
  assert.equal(st.chat.length, 0, 'the reset leaves an empty chat');
  assert.deepEqual(await quizzes(), []);
  assert.equal((await getDraft(r.draftId)).http, 404, 'a closed draft is not served');
  const late = await act({ draftId: r.draftId, action: 'publish' });
  assert.equal(late.http, 409);
  assert.equal(late.text, 'This draft was closed when the app restarted.');

  const { r: r2, d: d2 } = await draftTopic8();
  assert.notEqual(r2.draftId, r.draftId);
  const a = await act({ draftId: r2.draftId, action: 'approve', quiz: fullQuiz(d2) });
  assert.equal(a.canvasQuizId, 4821);
  await act({ draftId: r2.draftId, action: 'publish' });
  await waitFor(async () => (await state()).lessons.find((x) => x.quiz)?.deliveries.find((y) => y.studentId === 'student-alex')?.state === 'delivered', { what: 'notice delivered', timeout: 8000 });
});

test('telemetry for the Faculty’s quiz runs carries no question, answer or title text', async () => {
  const stream = await openStream(s.ui.url);
  try {
    const { r, d } = await draftTopic8();
    await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
    await act({ draftId: r.draftId, action: 'publish' });
    await waitFor(() => stream.events.some((e) => e.type === 'mcp_call_result' && e.data?.moment === 'publish'), { what: 'publish call event', timeout: 8000 });
    const mine = stream.events.filter((e) => typeof e.runId === 'string' && e.runId.startsWith('prof-'));
    assert.ok(mine.length > 0, 'the quiz runs reach the monitor');
    assert.ok(mine.some((e) => e.type === 'mcp_call_result'));
    const blob = JSON.stringify(mine);
    assert.equal(blob.includes('"correct"'), false);
    assert.equal(blob.includes(d.quiz.title), false, 'no title');
    for (const q of d.quiz.questions) {
      assert.equal(blob.includes(q.text), false, 'no question text');
      for (const a of q.answers) assert.equal(blob.includes(a), false, 'no answer text');
    }
    const result = mine.find((e) => e.type === 'mcp_call_result' && e.data.moment === 'approve');
    assert.equal(result.data.quizId, 4821);
    const all = JSON.stringify(stream.events);
    assert.equal(all.includes(d.quiz.questions[0].text), false);
  } finally { stream.close(); }
});

test('PROFESSOR_NOW is ignored without PROFESSOR_TEST_HOOKS: the real clock decides', async () => {
  const t = await start({ hr: false, now: null, professorEnv: { PROFESSOR_NOW: '2026-08-20T19:00:00Z' } });
  const r = await say('@assistant create a quiz for Marketing 351', t);
  const taught = taughtTopics(new Date());
  if (!taught.length) {
    assert.equal(r.action, 'quiz_before_term');
  } else {
    assert.equal(r.action, 'quiz_topics');
    assert.equal(r.topics.taughtThrough, taught.at(-1).n);
    assert.notEqual(r.topics.taughtThrough, 0);
  }
});

test('live interpret decision "quiz" with a topic answers with the highlighted list and drafts nothing (scripted model: plumbing)', async () => {
  const stub = await startFakeAnthropic();
  stub.respondWith(() => messageReply(JSON.stringify({ action: 'quiz', reply: 'Picking a topic.', kind: 'message', audience: 'all', title: '', content: '', content_is_verbatim: false, seed_id: '', topic: '8' })));
  const t = await start({ hr: false, professorEnv: { PROFESSOR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
  try {
    const r = await say('@assistant could you help me test the class on segmentation', t);
    assert.equal(r.action, 'quiz_topics');
    assert.equal(r.highlight, 8);
    assert.equal(stub.requests.length, 1, 'one interpret call, no draft call');
    assert.ok([null, 'closed'].includes((await state(t)).quizCard?.state ?? null));
  } finally { await stub.close(); }
});

test('live decision "quiz" with a blank topic falls back to the request words: the list highlights Topic 8', async () => {
  const stub = await startFakeAnthropic();
  stub.respondWith(() => messageReply(JSON.stringify({ action: 'quiz', reply: 'Picking a topic.', kind: 'message', audience: 'all', title: '', content: '', content_is_verbatim: false, seed_id: '', topic: '' })));
  const t = await start({ hr: false, professorEnv: { PROFESSOR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
  try {
    const r = await say('@assistant I need a quiz on segmentation', t);
    assert.equal(r.action, 'quiz_topics');
    assert.equal(r.highlight, 8);
  } finally { await stub.close(); }
});

test('a reply to a student is a normal reply even if it reads like a quiz request; with @assistant it reaches the desk', async () => {
  const send = async (text) => { const res = await post(`${s.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text, replyTo: 'student-alex' }); return { http: res.status, ...(await res.json()) }; };
  const plain = await send('make a quiz on Topic 8');
  assert.equal(plain.http, 200, JSON.stringify(plain));
  assert.equal(plain.action, 'post');
  assert.ok(!['quiz_topics', 'quiz_draft'].includes(plain.action));
  assert.ok([null, 'closed'].includes((await state()).quizCard?.state ?? null), 'no draft was made');
  const viaAssistant = await send('@assistant make a quiz on Topic 8');
  assert.equal(viaAssistant.action, 'quiz_draft');
});

test('no CANVAS_TOKEN: the Faculty agent starts, drafts work, and Approve says Canvas isn’t connected', async () => {
  const t = await start({ hr: false, canvas: false });
  assert.equal(t.canvas, null);
  const { r, d } = await draftTopic8(t);
  const a = await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) }, t);
  assert.equal(a.text, "Canvas isn't connected, so nothing was sent.");
  assert.equal(a.ok, false);
  assert.equal(a.http, 200, 'M-3: a definite answer, not a 503 "try again"');
  assert.ok(!a.retryable && !a.unknownOutcome);
  assert.equal((await state(t)).quizCard.state, 'draft');
});

// ---- Final review C-1 (LIVE-2): a topic chip must never become a message to students or to HR ------------------------
// The page sends a tap as a structured pick (`quizTopic`); the Faculty agent also claims the chip's exact text, so a
// stale chip, a chip after a restart, a Reply chip and an open HR card cannot turn it into a post. Each row checks that
// no lesson/post was created and HR got nothing.
const CHIP8 = 'Topic 8 · Segmentation & targeting';
const chip = async (n, on = s, extra = {}) => {
  const t = TOPICS.find((x) => x.n === n);
  const res = await post(`${on.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text: `Topic ${n} · ${t.name}`, ...extra });
  return { http: res.status, ...(await res.json()) };
};
const noPostNoHr = async (before, on = s) => {
  const st = await state(on);
  assert.equal(st.lessons.length, before.lessons, 'no lesson or post was created');
  if (on.hr) assert.equal((await (await fetch(`${on.hr.url}/test/hr/requests`)).json()).requests.length, 0, 'nothing filed with HR');
  assert.equal(st.hrCard?.formRef ?? null, before.formRef, 'the HR card is as it was');
  return st;
};
const snapshot = async (on = s) => { const st = await state(on); return { lessons: st.lessons.length, formRef: st.hrCard?.formRef ?? null }; };

test('C-1 (a): a stale chip while a draft is open answers "You have a draft open", structured or as text; no post', async () => {
  await draftTopic8();
  const before = await snapshot();
  const typed = await say('Topic 9 · Marketing research');
  assert.equal(typed.action, 'quiz_draft_open');
  assert.equal(typed.reply, 'You have a draft open (Topic 8). Approve or discard it first.');
  const structured = await chip(9, s, { quizTopic: 9 });
  assert.equal(structured.action, 'quiz_draft_open');
  await noPostNoHr(before);
});

test('C-1 (b): a stale chip after Publish is a new quiz request, never a post (the only post is the quiz notice)', async () => {
  const { r, d } = await draftTopic8();
  await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
  await act({ draftId: r.draftId, action: 'publish' });
  const before = await snapshot();
  assert.equal(before.lessons, 1, 'just the notice');
  const again = await chip(8, s, { quizTopic: 8 });
  assert.equal(again.action, 'quiz_draft');
  const typed = await say(CHIP8, s);
  assert.equal(typed.action, 'quiz_draft_open');
  await noPostNoHr(before);
});

test('C-1 (c): after a Faculty restart (no waiting question in memory) a chip is still the quiz desk’s, not a post', async () => {
  const fresh = await start({ hr: false }); // a fresh Faculty process: pendingQuiz is memory-only, so it knows no waiting question
  const before = await snapshot(fresh);
  const t = await say(CHIP8, fresh);
  assert.equal(t.action, 'quiz_draft');
  assert.equal((await state(fresh)).lessons.length, before.lessons, 'no post');
  const fresh2 = await start({ hr: false });
  const st = await chip(8, fresh2, { quizTopic: 8 });
  assert.equal(st.action, 'quiz_draft');
  assert.equal((await state(fresh2)).lessons.length, 0);
});

test('C-1 (d): a chip with the Reply chip active (replyTo) creates no post to that student', async () => {
  const before = await snapshot();
  const withReply = await chip(8, s, { quizTopic: 8, replyTo: 'student-sam' });
  assert.equal(withReply.action, 'quiz_draft', JSON.stringify(withReply));
  const st = await state();
  assert.equal(st.lessons.length, before.lessons, 'nothing was sent to Sam');
  assert.ok(!st.chat.some((m) => m.replyTo), 'the chip message is not recorded as a reply to one student');
  // The chip's text with replyTo but WITHOUT the structured field: the safety net claims it as well.
  await act({ draftId: withReply.draftId, action: 'discard' });
  const textOnly = await say(CHIP8, s, `op-${randomUUID()}`);
  assert.equal(textOnly.action, 'quiz_draft');
  const raw = await post(`${s.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, text: 'Topic 9 · Marketing research', replyTo: 'student-sam' });
  assert.equal((await raw.json()).action, 'quiz_draft_open');
  assert.equal((await state()).lessons.length, before.lessons);
});

test('C-1 (e): a chip while an HR card is open goes to the quiz desk, not HR as a follow-up', async () => {
  const stream = await openStream(s.ui.url);
  try {
    const r0 = await say('I want to file for time off. My grandmother passed away, I need this Thursday and Friday');
    assert.equal(r0.action, 'staff');
    const before = await snapshot();
    assert.ok(before.formRef, 'an HR card is open');
    await waitFor(() => stream.events.some((e) => e.type === 'staff_decision'), { what: 'the first staff decision', timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    const decisions = stream.events.filter((e) => e.type === 'staff_decision').length;
    const viaPick = await chip(8, s, { quizTopic: 8 });
    assert.equal(viaPick.action, 'quiz_draft');
    await act({ draftId: viaPick.draftId, action: 'discard' });
    const viaText = await say(CHIP8, s);
    assert.equal(viaText.action, 'quiz_draft');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(stream.events.filter((e) => e.type === 'staff_decision').length, decisions, 'the staff desk did not run');
    await noPostNoHr(before);
  } finally { stream.close(); }
});

test('C-1: the structured pick is validated at every hop; the text must be the chip’s own', async () => {
  const bad = [
    { text: CHIP8, quizTopic: '8' }, { text: CHIP8, quizTopic: 99 }, { text: CHIP8, quizTopic: 0 },
    { text: 'Topic 8', quizTopic: 8 }, { text: 'Topic 8 · Something else', quizTopic: 8 }, { text: 'Topic 9 · Marketing research', quizTopic: 8 },
  ];
  for (const b of bad) {
    const ui = await post(`${s.ui.url}/api/professor/chat`, { operationId: `op-${randomUUID()}`, ...b });
    assert.equal(ui.status, 400, JSON.stringify(b));
  }
  // The Faculty agent refuses a mismatched pick too, even when the UI server is bypassed (through the Hub proxy).
  const viaHub = await post(`${s.hub.url}/dev/agents/professor/author/chat`, { operationId: `op-${randomUUID()}`, text: 'Topic 8', quizTopic: 8 });
  assert.equal(viaHub.status, 400);
  assert.equal((await state()).lessons.length, 0);
});

// ---- I-1: a waiting topic question swallows later class messages ---------------------------------------------------
test('I-1: while a topic question waits, a class message that merely mentions a topic word goes to the students', async () => {
  const ask = await say('@assistant create a quiz for Marketing 351');
  assert.equal(ask.action, 'quiz_topics');
  for (const line of ['Reminder: read the pricing chapter before Friday', 'Great discussion on social media today, everyone']) {
    const r = await say(line);
    assert.ok(!String(r.action).startsWith('quiz_'), `${line} -> ${r.action}`);
    assert.equal(r.post !== null && r.post !== undefined, true, `${line} was sent to the class`);
  }
  assert.equal((await state()).lessons.length, 2, 'both went out as the professor wrote them');
  // The question still waits (until it expires): a bare topic still answers it.
  assert.equal((await say('Topic 8')).action, 'quiz_draft');
});

test('I-3 + M-1: "draft one more" is told his edited list; the key is not served once the quiz is saved', async () => {
  const { r, d } = await draftTopic8();
  const mine = ['My own rewritten question one here?', 'My own rewritten question two here?'];
  const more = await act({ draftId: r.draftId, action: 'one_more', existing: mine });
  assert.equal(more.http, 200, JSON.stringify(more));
  assert.ok(more.question?.text && !mine.includes(more.question.text));
  // strict at the UI server and the Faculty agent: only Draft one more carries a list, at most 20 x 300 characters
  assert.equal((await act({ draftId: r.draftId, action: 'discard', existing: mine })).http, 400);
  assert.equal((await act({ draftId: r.draftId, action: 'one_more', existing: ['y'.repeat(301)] })).http, 400);
  assert.equal((await act({ draftId: r.draftId, action: 'one_more', existing: Array.from({ length: 21 }, () => 'x') })).http, 400);
  const full = await act({ draftId: r.draftId, action: 'one_more', existing: Array.from({ length: 20 }, (_, i) => `Question ${i} about segmentation?`) });
  assert.equal(full.text, 'A quiz can have at most 20 questions.');
  assert.equal((await post(`${s.professor.url}/author/quiz-action`, { draftId: r.draftId, operationId: `op-${randomUUID()}`, action: 'approve', quiz: fullQuiz(d), existing: mine })).status, 400);
  assert.equal((await getDraft(r.draftId)).http, 200, 'a draft still serves its key');
  await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
  assert.equal((await getDraft(r.draftId)).http, 404, 'M-1: saved in Canvas, no key to fetch');
  assert.equal((await fetch(`${s.professor.url}/author/quiz/${r.draftId}`)).status, 404);
});

// ---- review fixes (G1): B8 counts, C15 Canvas vs the class roster ----------------------------------------------------
const membershipOf = async (on = s) => (await state(on)).quizCard?.membership ?? null;
const settledMembership = (on = s) => waitFor(async () => { const m = await membershipOf(on); return m && m.status !== 'checking' ? m : null; }, { what: 'Canvas vs roster comparison', timeout: 15000 });

test('B8: the confirmation counts his edits and additions (real counts from code)', async () => {
  const { r, d } = await draftTopic8();
  const quiz = fullQuiz(d);
  quiz.questions[1] = { ...quiz.questions[1], text: `${quiz.questions[1].text.replace(/\?$/, '')} in your own words?` };
  quiz.questions.push({ text: 'A coffee chain targets frequent app users. Which basis of segmentation is this?', answers: ['Geographic', 'Demographic', 'Psychographic', 'Usage-rate'], correct: 3 });
  const a = await act({ draftId: r.draftId, action: 'approve', quiz });
  assert.equal(a.http, 200, JSON.stringify(a));
  assert.equal(a.text, "Saved in Canvas as a draft (6 questions, 1 edited and 1 added by you). Students can't see it yet.");
  assert.deepEqual([a.edited, a.added], [1, 1]);
  const st = await state();
  assert.deepEqual([st.quizCard.edited, st.quizCard.added], [1, 1]);
  assert.ok(st.chat.some((m) => m.text === 'Saved in Canvas as quiz #4821 (6 questions, 1 edited and 1 added by you).'));
});

test('C15: after Approve, Canvas is compared with a fresh class roster: 1 enrolled student is not in Canvas yet', async () => {
  const { r, d } = await draftTopic8();
  await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
  const m = await settledMembership();
  assert.deepEqual(m, { status: 'ok', canvasCount: 24, rosterCount: 25, missing: ['student-hana-yamamoto'], extra: [] });
  const st = JSON.stringify(await state());
  assert.ok(!st.includes('Yamamoto') && !st.includes('Hana '), 'no names in the shared state');
  const names = await (await fetch(`${s.ui.url}/api/professor/roster/names`)).json();
  assert.equal(names.names['student-hana-yamamoto'], 'Hana Yamamoto', 'the Faculty view resolves the name through the names path');
  // Publish is not blocked by the mismatch.
  const p = await act({ draftId: r.draftId, action: 'publish' });
  assert.equal(p.http, 200, JSON.stringify(p));
});

test('C15: telemetry for the comparison carries counts only', async () => {
  const stream = await openStream(s.ui.url);
  try {
    const { r, d } = await draftTopic8();
    await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
    await settledMembership();
    const ev = await waitFor(() => stream.events.find((e) => e.type === 'quiz_membership'), { what: 'quiz_membership event', timeout: 8000 });
    assert.deepEqual([ev.data.status, ev.data.canvasCount, ev.data.rosterCount, ev.data.missingCount, ev.data.extraCount], ['ok', 24, 25, 1, 0]);
    const all = JSON.stringify(stream.events);
    assert.ok(!all.includes('Yamamoto') && !all.includes('student-hana-yamamoto'), 'no name or id in telemetry');
    assert.ok(stream.events.some((e) => e.type === 'mcp_call_started' && e.data?.tool === 'list_course_students'));
  } finally { stream.close(); }
});

test('C15: New conversation forgets the comparison; the next approval compares again', async () => {
  const { r, d } = await draftTopic8();
  await act({ draftId: r.draftId, action: 'approve', quiz: fullQuiz(d) });
  await settledMembership();
  await post(`${s.hub.url}/dev/classroom/reset`, {});
  const names = await (await fetch(`${s.ui.url}/api/professor/roster/names`)).json();
  assert.equal(names.names['student-hana-yamamoto'], undefined, 'a closed draft names nobody');
  const { r: r2, d: d2 } = await draftTopic8();
  await act({ draftId: r2.draftId, action: 'approve', quiz: fullQuiz(d2) });
  assert.deepEqual((await settledMembership()).missing, ['student-hana-yamamoto']);
});

test('C15: CHRS down — "I couldn\'t compare …"; Canvas still publishes', async () => {
  const own = await start({ chrs: true });
  try {
    const r0 = await say('make a quiz on segmentation', own);
    const d0 = await getDraft(r0.draftId, own);
    await stopProcess(own.chrs);
    const a = await act({ draftId: r0.draftId, action: 'approve', quiz: fullQuiz(d0) }, own);
    assert.equal(a.http, 200);
    const m = await waitFor(async () => { const x = (await state(own)).quizCard?.membership; return x?.status === 'failed' ? x : null; }, { what: 'failed comparison', timeout: 70000 });
    assert.equal(m.text, "I couldn't compare Canvas with your class roster just now.");
    assert.equal(m.missing, undefined, 'no list on a failed comparison');
    const p = await act({ draftId: r0.draftId, action: 'publish' }, own);
    assert.ok(p.ok || p.published, JSON.stringify(p)); // published in Canvas (the class notice needs the roster too)
    assert.equal((await quizzes(own))[0].published, true);
  } finally { own.kill(); }
});
