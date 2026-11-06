// Review F (owner, 2026-11-06): what a STUDENT asks the Marketing 351 course assistant about the class. Code answers
// (src/student-course.js) from the shared class facts and from the notices this student was sent; a question goes to
// Dr. Dabirian only after the student's yes; the assistant never speaks as Dr. Dabirian. Mock router / mock or scripted
// models only (plumbing, not judgment): no network, no cost.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStack, openStream, post, waitFor, find, findAll, forRun } from './support/harness.js';
import { startFakeAnthropic, messageReply } from './support/fake-anthropic.js';
import {
  ALREADY_SENT_TEXT, GRADES_TEXT, IDENTITY_TEXT, LATE_YES_TEXT, NO_QUIZ_TEXT, OFFER_ASK_TEXT, OFFER_CLASS_TEXT, OFFER_DECISION_TEXT, OFFER_NOT_SENT_TEXT,
  OFFER_UNKNOWN_TEXT, SENT_TEXT, WHO_TEACHES_TEXT, asksAboutClassmates, cancelledDays, classFactsBlock, courseAnswer, dayAsked, isNo, yesOf,
} from '../src/student-course.js';
import { PRIVATE_DETAIL_TEXT } from '../src/classmates.js';
import { FINAL_EXAM, GRADING, MEETING, OFFICE_HOURS, TERM, meetsOn } from '../src/course-schedule.js';

process.env.ROUTER_MODE ??= 'mock'; // read when src/router.js is first imported (below, dynamically)
const NOW = new Date('2026-11-06T20:00:00Z'); // Fri, Nov 6, 2026, noon Pacific
const at = (q, notices = [], now = NOW) => courseAnswer(q, { now, notices });
const topicOf = (q, notices, now) => at(q, notices, now)?.topic ?? null;
const cancelNotice = (days, createdAt = '2026-11-06T18:00:00Z') => ({ kind: 'message', title: 'Class cancelled', createdAt, text: `Marketing 351 (10:00–11:15 AM, Mihaylo Hall 2405) is cancelled on ${days}.` });
const quizNotice = (over = {}) => ({ kind: 'message', title: 'Quiz', text: 'A quiz was published.', createdAt: '2026-11-05T18:00:00Z', quiz: { canvasQuizId: 4821, title: 'Topic 8 quiz', questions: 5, points: 15, minutes: 10, attempts: 1, dueAt: '2026-11-10T07:59:00Z', ...over } });

// ---- the class facts -------------------------------------------------------------------------------------------
test('class facts: grading adds to 100, the final exam is inside the term on a weekday, office hours are set', () => {
  assert.equal(GRADING.reduce((n, g) => n + g.percent, 0), 100);
  assert.ok(FINAL_EXAM.date >= TERM.start && FINAL_EXAM.date <= TERM.end);
  assert.equal(new Date(`${FINAL_EXAM.date}T12:00:00Z`).getUTCDay(), 4, 'Thu, Dec 17');
  assert.match(OFFICE_HOURS.timeLabel, /AM|PM/);
  assert.ok(meetsOn('2026-11-12') && !meetsOn('2026-11-13'));
  const facts = classFactsBlock(NOW);
  for (const want of ['Tue & Thu', 'Mihaylo Hall 5310', 'Thu, Sep 24', 'Thu, Oct 22', 'Thu, Dec 17', 'Participation', 'Next up: Topic 17']) assert.ok(facts.includes(want), want);
  assert.doesNotMatch(facts, /Alex|Sam|Mariana|@csu|888/, 'no student in the facts the model sees');
});

// ---- classmates: a fixed, polite decline — never a name, count, email, ID, level or major -------------------------
test('classmate questions in many phrasings get the privacy decline (names, emails, counts, levels, majors)', () => {
  const asks = [
    'Who else is in my Marketing 351 class?', 'Is Mariana Aguilar in my class?', 'Who are the seniors in my marketing class?',
    'Does Hana Yamamoto have the marketing quiz in Canvas?', "What's Sam Student's email?", 'How many students are in my class?',
    'Can I get a list of my classmates?', 'is jordan in my marketing class', 'Who is taking MKTG 351 with me?', 'Are there any finance majors in my class?',
    'Is my roommate in the class?', 'How big is my class?', "What's Mariana's phone number?", 'Did Sam finish the quiz?',
    'Can you give me the email of another student?', 'Show me the class roster', 'Is anyone from my dorm in my class?',
  ];
  for (const q of asks) {
    const r = at(q);
    assert.equal(r?.topic, 'classmates', q);
    assert.equal(r.text, null, `${q}: answered from the class list, not from fixed words`);
    assert.equal(r.roster, true, q);
    assert.equal(r.offer, undefined, `${q}: nothing offered or sent`);
  }
  for (const q of ["What's Sam's ID?", "What is Mariana's GPA?", 'Can I get the emails of the juniors in my marketing class?', 'Is there a class email list?', 'How can I contact Owen Bennett?']) assert.equal(at(q)?.topic, 'classmates', q);
  for (const q of ['How do I email Dr. Dabirian?', 'What is the email for Dr. Dabirian?']) assert.notEqual(at(q)?.topic, 'classmates', q);
  for (const q of ['What is market segmentation?', 'When is the final?', 'Who teaches Marketing 351?', 'Is Thursday class cancelled?', 'Does Canvas have the quiz?', 'Is Marketing 351 cancelled on Tuesday?']) assert.ok(!asksAboutClassmates(q), q);
});

// ---- meeting time and place, term, next class ---------------------------------------------------------------------
test('when and where the class meets comes from the shared MEETING/TERM', () => {
  const want = 'Marketing 351 meets Tue & Thu, 10:00–11:15 AM in Mihaylo Hall 2405 (Fall 2026, Aug 25 – Dec 18).';
  for (const q of ['When does Marketing 351 meet?', 'Where is my marketing class?', 'What time is class?', 'What room is Marketing 351 in?', 'Which days does the class meet?',
    'Where is MKTG 351 held?', 'What are the class times?', 'what days is marketing class', 'Where does the lecture meet?', 'How often does the class meet?']) {
    assert.equal(at(q)?.text, want, q);
  }
  assert.equal(at('When is the next class?').text, 'The next Marketing 351 class is Tue, Nov 10, 10:00–11:15 AM in Mihaylo Hall 2405.');
  assert.match(at('When is the next class?', [cancelNotice('Tue, Nov 10')]).text, /Thu, Nov 12.*No class on Tue, Nov 10 \(cancelled\)/, 'a cancelled day is skipped and said');
  assert.match(at('When is the next class?', [], new Date('2026-11-25T20:00:00Z')).text, /Tue, Dec 1.*Thu, Nov 26 \(campus holiday\)/, 'Thanksgiving is skipped');
  assert.match(at('When does the semester end?').text, /^Fall 2026 runs Tue, Aug 25 – Fri, Dec 18\./);
  assert.match(MEETING.timeLabel, /10:00–11:15 AM/);
});

// ---- schedule: next topic / covered so far ------------------------------------------------------------------------
test('next topic and topics covered come from the schedule (taught = on or before today, Pacific)', () => {
  for (const q of ['What topic are we covering next?', "What's the next topic?", 'What are we learning next?', 'Which chapter is next in class?', 'What will we cover next?']) {
    assert.match(at(q)?.text ?? '', /^Next up is Topic 17, Personal selling, on Tue, Nov 10\./, q);
  }
  for (const q of ['What have we covered so far?', 'Which topics have we covered?', 'Where are we in the course?', 'What did we cover in class?', 'What topics did we learn so far?']) {
    const r = at(q);
    assert.match(r?.text ?? '', /^Marketing 351 has covered Topics 1–16 so far/, q);
    assert.doesNotMatch(r.text, /you taught|I taught/, q);
  }
  assert.match(at('What have we covered so far?', [], new Date('2026-08-20T20:00:00Z')).text, /No Marketing 351 topics have been taught yet/);
  assert.match(at("What's the next topic?", [], new Date('2026-11-10T20:00:00Z')).text, /Topic 18, Social media/, 'taught moves with today');
});

// ---- cancellations: true to what THIS student was sent ----------------------------------------------------------------
test('is class cancelled: a sent notice, an uncancelled class day, a non-meeting day, a holiday, outside the term', () => {
  const sent = [cancelNotice('Thu, Nov 12')];
  assert.equal(at('Is my marketing class cancelled on Thursday?', sent).text, 'Yes — Dr. Dabirian cancelled class on Thu, Nov 12 (sent Nov 6).');
  assert.equal(at('Is my marketing class cancelled on Thursday?').text, 'I don’t see a cancellation for Thu, Nov 12. Marketing 351 meets Tue & Thu, 10:00–11:15 AM in Mihaylo Hall 2405.', 'before any notice');
  assert.equal(at('Is class cancelled on Tuesday?', sent).text, 'I don’t see a cancellation for Tue, Nov 10. Marketing 351 meets Tue & Thu, 10:00–11:15 AM in Mihaylo Hall 2405.');
  assert.equal(at('Is there class on Friday?', sent).text, 'Marketing 351 doesn’t meet on Fridays — it meets Tue & Thu, 10:00–11:15 AM in Mihaylo Hall 2405.');
  assert.match(at('Do we have class on Wednesday?').text, /doesn’t meet on Wednesdays/);
  assert.equal(at('Is class cancelled on Nov 26?').text, 'Thu, Nov 26 is a campus holiday, so there’s no Marketing 351 class that day.');
  assert.match(at('Is class cancelled on Dec 22?').text, /outside the Fall 2026 term/);
  assert.equal(at('Is class cancelled on 11/12?', sent).text, 'Yes — Dr. Dabirian cancelled class on Thu, Nov 12 (sent Nov 6).', 'numeric date');
  assert.equal(at('Is class cancelled?', sent).text, 'Yes — Dr. Dabirian cancelled class on Thu, Nov 12 (sent Nov 6).', 'no day: upcoming notices');
  assert.match(at('Is class cancelled?').text, /^I don’t see any class cancellations\./);
  assert.match(at('Is there class tomorrow?').text, /doesn’t meet on Saturdays/, 'tomorrow from a Friday');
  assert.equal(at('Is class cancelled on Thursday?', [cancelNotice('Thu, Nov 12 and Tue, Nov 17')]).text, 'Yes — Dr. Dabirian cancelled class on Thu, Nov 12 (sent Nov 6).');
  // A day only mentioned in Dr. Dabirian's note under the notice is not a cancelled day.
  const withNote = [{ ...cancelNotice('Thu, Nov 12'), text: 'Marketing 351 is cancelled on Thu, Nov 12.\n\nFrom Dr. Dabirian: we make it up on Tue, Nov 17.' }];
  assert.deepEqual(cancelledDays(withNote).map((c) => c.date), ['2026-11-12']);
  assert.deepEqual(cancelledDays([{ title: 'Homework', text: 'Thu, Nov 12 is cancelled' }]), [], 'only real cancellation notices');
  assert.equal(dayAsked('next Tuesday', NOW), '2026-11-10');
  assert.equal(dayAsked('on thursday', new Date('2026-11-12T18:00:00Z')), '2026-11-12', 'today counts');
});

// ---- quizzes ----------------------------------------------------------------------------------------------------
test('quiz due: from the quiz notices this student received; none → “No quiz has been posted yet.”', () => {
  for (const q of ['When is the marketing quiz due?', 'Is there a quiz this week?', 'How long is the quiz?', 'Any quizzes posted?', 'When is the quiz due?', 'Where do I take the quiz?']) {
    assert.equal(at(q)?.text, NO_QUIZ_TEXT, q);
  }
  const one = at('When is the marketing quiz due?', [quizNotice()]).text;
  assert.equal(one, '“Topic 8 quiz” is due Mon, Nov 9, 11:59 PM: 5 questions, 10 minutes, 1 attempt.\n\nTake it in Canvas.');
  const two = at('When are the quizzes due?', [quizNotice(), { ...quizNotice({ canvasQuizId: 4822, title: 'Topic 9 quiz', questions: 1, attempts: 2, dueAt: '2026-11-17T07:59:00Z' }), createdAt: '2026-11-06T18:00:00Z' }]).text;
  assert.match(two, /^- “Topic 9 quiz” is due Mon, Nov 16, 11:59 PM: 1 question, 10 minutes, 2 attempts\.\n- “Topic 8 quiz”/, 'newest first, singular/plural right');
  assert.equal(at('When is the quiz due?', [quizNotice(), quizNotice()]).text.match(/Topic 8 quiz/g).length, 1, 'the same quiz once');
  assert.equal(at('Does Hana Yamamoto have the marketing quiz?', [quizNotice()]).topic, 'classmates', 'never about another student');
});

// ---- exams --------------------------------------------------------------------------------------------------------
test('exam dates come from UNITS and FINAL_EXAM — never invented', () => {
  const all = 'Marketing 351 has two unit exams (midterms): Unit 1 on Thu, Sep 24 and Unit 2 on Thu, Oct 22. The final exam is Thu, Dec 17, 10:00 AM–12:00 PM in Mihaylo Hall 2405.';
  for (const q of ['When is the marketing midterm?', 'When are the midterms?', 'What are the exam dates?', 'When is the midterm and final?']) assert.equal(at(q)?.text, all, q);
  for (const q of ['When is the final?', 'When is the final exam?', 'Where is the final exam?', 'what day is the marketing final']) assert.equal(at(q)?.text, 'The Marketing 351 final exam is Thu, Dec 17, 10:00 AM–12:00 PM in Mihaylo Hall 2405.', q);
  assert.equal(at('When was the unit 1 exam?').text, 'The Unit 1 exam was on Thu, Sep 24.');
  assert.match(at('When is the unit 3 exam?').text, /no separate Unit 3 exam.*final exam is Thu, Dec 17/);
  assert.match(at('When is the next exam?').text, /^The next exam is the final: Thu, Dec 17/);
  assert.match(at('When is the next exam?', [], new Date('2026-10-01T18:00:00Z')).text, /Unit 2 exam on Thu, Oct 22/);
  assert.equal(at("What's on the final?"), null, 'a content question is not a date question');
});

// ---- who teaches, identity, grades, grading, syllabus, office hours -------------------------------------------------
test('who teaches / are you Dr. Dabirian: the assistant never claims to be Dr. Dabirian', () => {
  for (const q of ['Who teaches Marketing 351?', 'Who is my professor for marketing?', 'Who is the instructor?', "What's my professor's name?", 'Who is Dr. Dabirian?', 'who teaches mktg 351']) {
    assert.equal(at(q)?.text, WHO_TEACHES_TEXT, q);
  }
  for (const q of ['Are you Dr. Dabirian?', 'Am I talking to Dr. Dabirian?', 'Who are you?', 'Are you a real person?']) assert.equal(at(q)?.text, IDENTITY_TEXT, q);
  for (const r of [WHO_TEACHES_TEXT, IDENTITY_TEXT]) assert.doesNotMatch(r, /\bI am Dr|\bI'm Dr/);
});

test('grades, grading, syllabus, office hours, course description: answered, never forwarded', () => {
  for (const q of ["What's my grade?", 'How am I doing in this class?', 'What did I get on the midterm?', 'Am I passing?', 'Can you check my grades?']) assert.equal(at(q)?.text, GRADES_TEXT, q);
  for (const q of ['How is the class graded?', 'How much is the final worth?', 'What percent are quizzes?', 'What is the grading breakdown?']) assert.match(at(q)?.text ?? '', /^Marketing 351 grading:\n- Unit exams \(2 × 20%\): 40%/, q);
  for (const q of ['Can I get the syllabus?', 'Where is the syllabus?', 'Send me the course outline']) {
    const t = at(q).text;
    assert.match(t, /Instructor: Dr\. Dabirian/);
    assert.match(t, /Unit 2 \(Topics 8–14, exam Thu, Oct 22\)/);
    assert.match(t, /Final exam: Thu, Dec 17/);
    assert.match(t, /The full syllabus is in Canvas\.$/);
  }
  for (const q of ["What are Dr. Dabirian's office hours?", 'When are office hours?', 'Where can I meet Dr. Dabirian?', "Where is the professor's office?"]) {
    assert.equal(at(q)?.text, 'Dr. Dabirian’s office hours are Tue & Thu, 11:30 AM–12:30 PM in Mihaylo Hall 5310, and by appointment.', q);
  }
  const offered = { kind: 'message', title: 'Office hours', text: 'x', createdAt: '2026-11-05T00:00:00Z', meeting: { meetingId: 'mt-abcdefgh', slots: [{ slotId: 's1', label: 'Tue, Nov 10, 2:00 PM' }] } };
  assert.match(at('When are office hours?', [offered]).text, /also offered you these meeting times: Tue, Nov 10, 2:00 PM\./, 'times Dr. Dabirian posted to this student');
  assert.match(at('What is this course about?').text, /^Marketing 351 is an introduction/);
});

// ---- offers: only when the student asks for Dr. Dabirian or only Dr. Dabirian can decide ---------------------------------
test('a message for the whole class, a request for Dr. Dabirian, a decision only they make → an offer (yes / no), never a send', () => {
  for (const q of ['Can you tell everyone in my marketing class that the study group meets tonight?', 'Please let the class know I found a blue umbrella', 'Message all my classmates about the study group',
    'Notify everyone that the review session moved', 'Can you remind the whole class to bring laptops?', 'tell my classmates the study group is at 6']) {
    const r = at(q);
    assert.equal(r?.offer, 'class_message', q);
    assert.equal(r.text, OFFER_CLASS_TEXT);
  }
  assert.equal(OFFER_CLASS_TEXT, 'Only Dr. Dabirian can message the whole class. Want me to send your message to Dr. Dabirian?');
  // Owner, 2026-11-06: written TO Dr. Dabirian, or an explicit “ask / tell Dr. Dabirian …” — sent at once, no offer.
  for (const q of ['Can you ask Dr. Dabirian if I can bring a laptop?', "I'll miss class Tuesday, can you let Dr. Dabirian know?", 'Tell my professor I am sick today', 'Please email the instructor about my seat', 'Could you pass this on to Dr. Dabirian: the slides are broken',
    'Hi Dr. Dabirian can I turn in my homework late', 'Dr. Dabirian, is the midterm open book?', 'Hello professor, I have a question about the case study', 'Can I turn in my homework late, Dr. Dabirian?', 'Dear Dr Dabirian I will be late tomorrow', 'Hey Dabirian quick question about the project']) {
    assert.equal(at(q)?.send, true, q);
    assert.equal(at(q).text, SENT_TEXT, q);
    assert.equal(at(q).offer, undefined, q);
  }
  for (const q of ['Hi Dr. Dabirian', 'Hi professor!', "What are Dr. Dabirian's office hours?", "Dr. Dabirian's office hours?", 'Who teaches Marketing 351?', 'Hi, when is the final?']) assert.notEqual(at(q)?.send, true, q);
  for (const q of ["I'll miss class on Tuesday", 'I will be absent from class Thursday']) {
    assert.equal(at(q)?.offer, 'ask', q);
    assert.equal(at(q).text, OFFER_ASK_TEXT);
  }
  for (const q of ['Can I get an extension on the homework?', 'Can I take a make-up exam?', 'Can I retake the quiz?', 'Is my absence excused?', 'I want to dispute my grade', 'Can I get accommodations for the final?', 'My grade is wrong on the midterm', 'Can I drop the class?']) {
    assert.equal(at(q)?.offer, 'decision', q);
    assert.equal(at(q).text, OFFER_DECISION_TEXT);
  }
  assert.equal(OFFER_DECISION_TEXT, 'That’s Dr. Dabirian’s call. Want me to send your question to them?');
  for (const t of [OFFER_ASK_TEXT, OFFER_CLASS_TEXT, OFFER_DECISION_TEXT, OFFER_UNKNOWN_TEXT]) assert.match(t, /\?$/, 'ends with the question, so “yes” goes back to the course');
});

test('concept questions and the course pack are left to the material (no code answer)', () => {
  for (const q of ["What's Sam's ID?", "What is Mariana's GPA?"]) assert.equal(at(q)?.topic, 'classmates', q);
  for (const q of ['What is market segmentation?', 'Explain the 4 Ps', 'What is SWOT in marketing', 'Can I hand in my homework late?', 'Give me an example of positioning',
    'How does pricing work?', 'What is customer value?', 'Explain the BCG matrix', 'What does branding mean?', 'Thanks!']) assert.equal(at(q), null, q);
});

test('yes / no to an offer: yes keeps extra words; no, nope, never mind decline; anything else is a new message', () => {
  assert.deepEqual(yesOf('yes'), { extra: '' });
  assert.deepEqual(yesOf('Yes please'), { extra: '' });
  assert.deepEqual(yesOf('yeah, send it'), { extra: '' });
  assert.deepEqual(yesOf('Sure!'), { extra: '' });
  assert.deepEqual(yesOf('ok go ahead'), { extra: '' });
  assert.deepEqual(yesOf('yes — and tell them I can bring a doctor’s note'), { extra: 'and tell them I can bring a doctor’s note' });
  assert.deepEqual(yesOf('Yes, I need it by Friday.'), { extra: 'I need it by Friday.' });
  for (const t of ['no', 'No thanks', 'nope', 'never mind', "don't send it", 'not now']) { assert.equal(yesOf(t), null, t); assert.ok(isNo(t), t); }
  for (const t of ['When is the final?', 'yesterday was fun', 'okayish', 'Nothing yet', 'no one told me the room for the exam was changed and I am confused about it']) assert.ok(!isNo(t), t);
  assert.equal(yesOf('When is the final?'), null);
  assert.equal(yesOf('yesterday'), null);
});

test('the student prompt: course assistant, never Dr. Dabirian, never about other students; a reply in their voice is repaired', async () => {
  const { SYSTEM, ON_BEHALF, voiceProblem } = await import('../src/professor-model.js');
  assert.match(SYSTEM, /^You are Dr\. Dabirian's course assistant/);
  assert.match(SYSTEM, /You are NOT Dr\. Dabirian: never claim to be them/);
  assert.match(SYSTEM, /Never state or guess anything about another student yourself/);
  assert.match(SYSTEM, /never write that you passed, sent or forwarded anything/);
  assert.doesNotMatch(SYSTEM, /Speak as the faculty member, in the first person/);
  assert.doesNotMatch(ON_BEHALF, /passed it to the faculty member/);
  for (const bad of ['I am Dr. Dabirian, and I teach Marketing 351.', "I'm Dr Dabirian.", 'As your professor, I expect it Friday.', 'I’m your instructor.', 'In my class we use SWOT.', 'I have passed this on to Dr. Dabirian.', 'I’ve sent your question to them.', 'I forwarded it.']) {
    assert.ok(voiceProblem(bad), bad);
  }
  for (const good of ['Dr. Dabirian teaches Marketing 351.', 'Segmentation splits a market into groups.', 'Dr. Dabirian’s message says the homework can be late.', 'I can explain it with an example.']) assert.equal(voiceProblem(good), null, good);
});

// ---- routing hints ----------------------------------------------------------------------------------------------------
test('routing: class phrasings match only the course capability; a classmate question is decided in code (no clarifying question)', async () => {
  process.env.STUDENT_MODE = 'mock';
  const { matchCapabilities, planRequest } = await import('../src/student-assistant.js');
  const { loadHubConfig } = await import('../src/config.js');
  const { ROUTER_SYSTEM } = await import('../src/router.js');
  const caps = Object.entries(loadHubConfig().destinations).filter(([, d]) => d.audience !== 'staff').map(([id, d]) => ({ id, name: d.name, tags: d.tags, description: d.description, examples: d.examples }));
  for (const c of caps) assert.ok(c.tags.length <= 24 && c.description.length <= 500, `${c.id}: fits the card limits (src/cards.js), or the Student never sees it`);
  for (const q of ['Is Mariana Aguilar in my class?', 'Who else is in my marketing class?', 'Can I get the syllabus?', 'When is the midterm?', 'Who are my classmates?', 'When is the final exam?', 'Is my marketing class cancelled on Thursday?']) {
    assert.deepEqual(matchCapabilities(q, caps).map((m) => m.id), ['marketing'], q);
  }
  for (const q of ["What's Sam Student's email?", 'Does Hana Yamamoto have the quiz?', 'How many students are in the section?']) {
    const plan = await planRequest({ question: q, capabilities: caps, recentTurns: [] });
    assert.equal(plan.action, 'send', q);
    assert.equal(plan.capability, 'marketing', q);
    assert.equal(plan.by, 'rule', q);
  }
  assert.match(ROUTER_SYSTEM, /classmates and other students in it/);
  assert.match(ROUTER_SYSTEM, /never to the library or tutoring/);
});

test('mock Hub router (labelled heuristic): a question naming the class goes to the course even when another service also scores', async () => {
  const { decideRoute } = await import('../src/router.js');
  const { PROFESSOR_DEFAULT_SKILLS } = await import('../src/course-pack.js');
  const skillsOf = (cfg) => cfg.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, examples: s.examples ?? [] }));
  const services = [
    { agentId: 'professor', name: 'Marketing 351 Faculty', publicName: 'Marketing 351', instructor: 'Dr. Dabirian', skills: skillsOf(PROFESSOR_DEFAULT_SKILLS) },
    { agentId: 'library', name: 'Library Agent', publicName: 'Library services', skills: [{ id: 'renewals', name: 'Renewals', description: 'Renew and extend loans.', tags: ['library', 'book', 'renew', 'extend', 'tonight', 'hours', 'study room'], examples: [] }] },
    { agentId: 'tutor', name: 'Tutor Agent', publicName: 'Tutoring', skills: [{ id: 'in-person', name: 'In-person tutoring', description: 'Meet a tutor.', tags: ['tutoring', 'meet', 'session', 'calculus', 'homework'], examples: [] }] },
  ];
  const route = async (q) => (await decideRoute({ question: q, services })).agentId ?? null;
  for (const q of ['When does Marketing 351 meet?', 'Can I get an extension on the homework for my marketing class?', 'Can you tell everyone in my marketing class that the study group meets tonight?',
    'Who are my classmates this term?', 'Where is the syllabus for this class?', 'When are office hours? I want to meet', 'When is the midterm? I need a tutoring session before it']) {
    assert.equal(await route(q), 'professor', q);
  }
  assert.equal(await route('Where can I find a book for my marketing class?'), 'library', 'leads like a library task: not the course');
  assert.equal(await route('Can I renew a library book tonight?'), 'library');
  assert.notEqual(await route('Can I meet a tutor for calculus homework?'), 'professor', 'no class words: never pulled to the course');
});

// ---- end to end on a mock stack -----------------------------------------------------------------------------------------
const stacks = [];
const streams = [];
after(() => { for (const s of streams) s.close(); for (const s of stacks) s.kill(); });
async function classroom({ professorEnv = {}, uiEnv = {} } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'a2a-f-'));
  const s = await startStack({
    library: false, professor: true, tutorEnv: { TUTOR_MODE: 'mock', TUTOR_SCOPE_ENFORCEMENT: 'off' },
    hubEnv: { ROUTER_MODE: 'mock', HUB_TELEMETRY_SHOW_CONTENT: '1', HUB_STUDENTS: 'student-alex,student-sam' },
    uiEnv: { STUDENT_INBOX_FILE: join(d, 'inbox.json'), ...uiEnv },
    professorEnv: { PROFESSOR_OUTBOX_FILE: join(d, 'outbox.json'), PROFESSOR_TEST_HOOKS: '1', PROFESSOR_NOW: '2026-11-06T20:00:00Z', ...professorEnv },
  });
  stacks.push(s);
  const stream = await openStream(s.ui.url);
  streams.push(stream);
  return { s, stream };
}
const state = async (s) => (await fetch(`${s.ui.url}/api/professor/state`)).json();
function asker(s, stream) {
  let contextId;
  return async (text, extra = {}) => {
    const res = await post(`${s.ui.url}/api/runs`, { text, ...(extra.capability === null ? {} : { capability: 'marketing' }), ...(contextId ? { contextId } : {}), ...extra.body });
    assert.equal(res.status, 202);
    const body = await res.json();
    contextId = body.contextId;
    await waitFor(() => find(forRun(stream.events, body.runId), 'student', 'reply_received'), { timeout: 15000, what: `reply to “${text}”` });
    return { ...find(forRun(stream.events, body.runId), 'student', 'reply_received').data, events: forRun(stream.events, body.runId) };
  };
}
const handOvers = async (s) => (await state(s)).chat.filter((m) => m.action === 'answer_student' && m.needsProfessor);

test('end to end: class facts and classmates are answered by the course assistant (labelled so), nothing reaches Dr. Dabirian', async () => {
  const { s, stream } = await classroom();
  const ask = asker(s, stream);
  for (const [q, want] of [
    ['Who else is in my Marketing 351 class?', /^Marketing 351 has 25 students — you and 24 classmates:\n\n- Mariana Aguilar — Junior, Marketing · maguilar@csu\.fullerton\.example\n/],
    ['Is Mariana Aguilar in my class?', 'Yes — Mariana Aguilar is in Marketing 351 (Junior, Marketing). Their campus email is maguilar@csu.fullerton.example.'],
    ["What's Sam Student's student ID?", PRIVATE_DETAIL_TEXT], ['Who teaches Marketing 351?', WHO_TEACHES_TEXT],
    ['When does Marketing 351 meet?', 'Marketing 351 meets Tue & Thu, 10:00–11:15 AM in Mihaylo Hall 2405 (Fall 2026, Aug 25 – Dec 18).'], ["What's my grade?", GRADES_TEXT],
    ['When is the marketing quiz due?', NO_QUIZ_TEXT], ['Is my marketing class cancelled on Thursday?', 'I don’t see a cancellation for Thu, Nov 12. Marketing 351 meets Tue & Thu, 10:00–11:15 AM in Mihaylo Hall 2405.'],
  ]) {
    const r = await ask(q);
    if (want instanceof RegExp) assert.match(r.text, want, q); else assert.equal(r.text, want, q);
    // Security review: classmates' names and emails stay in the student's reply — the agent's event feed says only what it did.
    const published = find(r.events, 'professor', 'reply_published');
    if (/@csu\.fullerton\.example/.test(r.text)) assert.match(published?.data?.text ?? 'NO EVENT', /^Answered from the class list \(\w+\)\.$/, `${q}: feed redacted`);
    assert.equal(r.servedBy, 'professor', q);
    assert.equal(r.professor.onBehalf, true, `${q}: labelled “Dr. Dabirian’s course assistant”, never “Dr. Dabirian”`);
    assert.equal(r.professor.outcome, 'answer');
    assert.equal(r.professor.decidedBy, 'code');
    assert.doesNotMatch(r.text, /I am Dr|I’m Dr|I'm Dr/);
  }
  assert.equal((await state(s)).chat.length, 0, 'none of it was put in Dr. Dabirian’s chat');
  // A cancellation Dr. Dabirian sent to the class: the same question now says yes.
  const posted = await post(`${s.ui.url}/api/professor/lessons`, { operationId: `op-${randomUUID()}`, kind: 'message', audience: 'all', title: 'Class cancelled', text: 'Marketing 351 (10:00–11:15 AM, Mihaylo Hall 2405) is cancelled on Thu, Nov 12.' });
  assert.equal(posted.status, 200);
  await waitFor(() => findAll(stream.events, 'student', 'lesson_received').find((e) => e.data.title === 'Class cancelled'), { what: 'the notice reaches Alex' });
  assert.match((await ask('Is my marketing class cancelled on Thursday?')).text, /^Yes — Dr\. Dabirian cancelled class on Thu, Nov 12 \(sent \w{3} \d{1,2}\)\.$/);
  assert.match((await ask('When is the next class?')).text, /Tue, Nov 10/);
});

test('end to end: an offer waits for yes — no sends nothing, yes (with extra words) sends once, a new message drops it, a late yes is told honestly', async () => {
  const { s, stream } = await classroom({ professorEnv: { PROFESSOR_OFFER_TTL_MS: '1500' } });
  const ask = asker(s, stream);
  let r = await ask('Can I get an extension on the homework?');
  assert.equal(r.text, OFFER_DECISION_TEXT);
  assert.equal(r.professor.outcome, 'offered');
  r = await ask('no thanks');
  assert.equal(r.text, OFFER_NOT_SENT_TEXT);
  assert.equal((await state(s)).chat.length, 0, '“no”: nothing sent');

  r = await ask("I'll miss class on Tuesday");
  assert.equal(r.text, OFFER_ASK_TEXT);
  r = await ask('yes, I have a doctor appointment');
  assert.equal(r.text, SENT_TEXT);
  assert.equal(r.professor.outcome, 'needs_professor');
  let chat = (await state(s)).chat;
  const sent = chat.find((m) => m.role === 'student');
  assert.equal(sent.text, "I'll miss class on Tuesday\n\nI have a doctor appointment", 'the extra words travel with the question');
  assert.equal(sent.studentId, 'student-alex');
  assert.equal((await handOvers(s)).length, 1, 'one hand-over card for Dr. Dabirian');
  r = await ask('yes');
  assert.equal(r.text, ALREADY_SENT_TEXT, 'a second yes sends nothing again');
  assert.equal((await handOvers(s)).length, 1);

  r = await ask('Can you tell everyone in my marketing class that the study group meets tonight?');
  assert.equal(r.text, OFFER_CLASS_TEXT);
  r = await ask('When is the final?');
  assert.match(r.text, /Thu, Dec 17/, 'a new message is answered; the held one drops');
  r = await ask('yes');
  assert.equal(r.text, LATE_YES_TEXT);
  assert.equal((await handOvers(s)).length, 1, 'the dropped message was never sent');

  r = await ask('Can I take a make-up exam?');
  assert.equal(r.text, OFFER_DECISION_TEXT);
  await new Promise((done) => setTimeout(done, 1700));
  r = await ask('yes');
  assert.equal(r.text, LATE_YES_TEXT, 'the offer timed out');
  assert.equal((await handOvers(s)).length, 1);
  chat = (await state(s)).chat;
  assert.ok(!chat.some((m) => /make-up exam|study group/.test(m.text ?? '')), 'nothing unconfirmed reached Dr. Dabirian');
});

test('end to end: a message written to Dr. Dabirian is sent at once (owner, 2026-11-06) — no “Want me to send…?”', async () => {
  const { s, stream } = await classroom();
  const ask = asker(s, stream);
  let r = await ask('Hi Dr. Dabirian can I turn in my homework late');
  assert.equal(r.text, SENT_TEXT);
  assert.equal(r.professor.outcome, 'needs_professor');
  assert.equal(r.professor.decidedBy, 'code');
  const chat = (await state(s)).chat;
  assert.equal(chat.find((m) => m.role === 'student')?.text, 'Hi Dr. Dabirian can I turn in my homework late', 'sent word for word');
  assert.equal((await handOvers(s)).length, 1, 'one hand-over card for Dr. Dabirian');
  r = await ask('yes');
  assert.equal(r.text, ALREADY_SENT_TEXT, 'nothing waits for a yes; a yes sends nothing again');
  assert.equal((await handOvers(s)).length, 1);
});

test('end to end: ↩ Reply to Dr. Dabirian’s own message is still a direct relay (the student pressed Reply)', async () => {
  const { s, stream } = await classroom();
  const posted = await post(`${s.ui.url}/api/professor/lessons`, { operationId: `op-${randomUUID()}`, kind: 'message', audience: 'student-alex', title: 'Draft', text: 'Please resend your positioning draft.' });
  assert.equal(posted.status, 200);
  const msg = (await waitFor(() => findAll(stream.events, 'student', 'lesson_received').find((e) => e.data.title === 'Draft'), { what: 'delivery' })).data;
  const res = await post(`${s.ui.url}/api/runs`, { text: 'Can I get an extension on it?', lessonDeliveryId: msg.deliveryId });
  const { runId } = await res.json();
  await waitFor(() => find(forRun(stream.events, runId), 'student', 'reply_received'), { what: 'reply' });
  const r = find(forRun(stream.events, runId), 'student', 'reply_received').data;
  assert.equal(r.professor.outcome, 'relayed', 'no offer: the student chose to reply to Dr. Dabirian');
  assert.equal(r.text, 'Dr. Dabirian will get back to you.');
  assert.ok((await state(s)).chat.some((m) => m.role === 'student' && m.relayed && m.text === 'Can I get an extension on it?'));
});

test('end to end: a classmate question with no course words reaches the course (Student agent rule, no clarifying question)', async () => {
  const { s, stream } = await classroom({ uiEnv: { STUDENT_MODE: 'mock' } });
  const ask = asker(s, stream);
  await ask('When is the final?'); // the Student agent reads the university's card on its first request
  await waitFor(() => find(stream.events, 'student', 'card_discovered'), { what: 'card' });
  const r = await ask("What's Sam Student's email?", { capability: null });
  assert.equal(find(r.events, 'student', 'request_planned')?.data.by, 'rule', 'decided in code, no model');
  assert.equal(r.servedBy, 'professor');
  assert.equal(r.text, 'Sam Student’s campus email is sstudent@csu.fullerton.example. They’re a senior majoring in Marketing.');
  assert.equal(find(r.events, 'student', 'clarification_asked'), undefined);
});

test('end to end (scripted model — plumbing): a reply in Dr. Dabirian’s voice is repaired; the prompt carries the class facts and the assistant’s role', async () => {
  const stub = await startFakeAnthropic();
  let n = 0;
  stub.respondWith(() => messageReply(JSON.stringify(n++ === 0
    ? { kind: 'answer', text: 'I am Dr. Dabirian, and I teach customer value in my class.', topic_ids: ['value-and-needs'] }
    : { kind: 'answer', text: 'Dr. Dabirian’s course covers customer value: what a customer gets minus what they give up.', topic_ids: ['value-and-needs'] })));
  try {
    const { s, stream } = await classroom({ professorEnv: { PROFESSOR_MODE: 'live', ANTHROPIC_API_KEY: `sk-ant-test-${randomUUID()}`, ANTHROPIC_BASE_URL: stub.url, TUTOR_LOAD_DOTENV: '0' } });
    const r = await asker(s, stream)('Explain customer value with an example');
    assert.equal(r.text, 'Dr. Dabirian’s course covers customer value: what a customer gets minus what they give up.');
    assert.equal(r.professor.onBehalf, true);
    assert.equal(stub.requests.length, 2, 'one repair');
    const system = JSON.stringify(stub.requests[0].body.system);
    assert.match(system, /course assistant/);
    assert.match(system, /You are NOT Dr\. Dabirian/);
    const user = JSON.stringify(stub.requests[0].body.messages);
    assert.match(user, /<class_facts>/);
    assert.match(user, /Mihaylo Hall 5310/);
    assert.match(JSON.stringify(stub.requests[1].body.messages), /never speak as them/);
  } finally {
    await stub.close();
  }
});
