// The Faculty agent's quiz desk (Part 16). Self-contained: Canvas, the post path, the model and the clock are injected.
// Drafts and Canvas cards live in memory only (never in data/): Canvas forgets its quizzes on every start.
// The answer key (`correct`) is handed out only by draft(); card(), entries and telemetry never carry questions.
import { randomUUID } from 'node:crypto';
import { TOPICS, TERM, taughtTopics, isTaught, topicFromWords, countFromWords, asksQuiz, dayLabel, pacificDate } from './course-schedule.js';
import { defaultSettings, checkQuiz, validExisting } from './quiz-rules.js';
import { draftQuiz as realDraftQuiz, draftOne as realDraftOne } from './quiz-model.js';
import { ROSTER_UNAVAILABLE_CODE } from './staff.js';

export const CLOSED_TEXT = 'This draft was closed when the app restarted.';
export const NOT_CONNECTED_TEXT = "Canvas isn't connected, so nothing was sent.";
export const DISCARDED_TEXT = 'This draft was discarded.';
export const NOTICE_NO_LIST_TEXT = "Published in Canvas, but I couldn't get your class list, so students weren't told yet. Press Publish again in a moment — they're notified only once.";
export const NOTICE_FAILED_TEXT = 'Published in Canvas, but the class notice did not go out. Press Publish again to send it; students are notified only once.';
const ASK_EXPIRES_MS = 15 * 60_000; // a waiting topic question, like the assistant's waiting meeting question
// A topic chip's own text (the page sends it as a structured pick; this is the safety net for the text itself).
export const chipText = (t) => `Topic ${t.n} · ${t.name}`;
export function chipTopicOf(text) {
  const m = /^Topic (\d{1,2}) · (.+)$/.exec(String(text ?? ''));
  if (!m) return null;
  const t = TOPICS.find((x) => x.n === Number(m[1]));
  return t && chipText(t) === m[0] ? t.n : null;
}
const OPEN_STATES = new Set(['draft', 'saving', 'saved', 'publishing', 'kept']);
const ACTIONS = new Set(['approve', 'publish', 'keep_draft', 'discard', 'one_more']);
const MAX_EXISTING = 20;

const failText = (outcome, verb) => {
  const again = verb === 'publish' ? 'Publish' : 'Approve';
  switch (outcome) {
    case 'unavailable':
    case 'uncertain':
      return verb === 'publish'
        ? "Canvas didn't answer, so the quiz may still be unpublished and nobody was notified. Press Publish again; it won't publish twice."
        : "Canvas didn't answer. Nothing is posted until it confirms — press Approve again; it won't post twice.";
    case 'tool_refused': return `Something went wrong on our side, so nothing was sent to Canvas. Press ${again} again.`;
    case 'tool_choice_failed': return `Something went wrong on our side, so nothing was sent to Canvas. Press ${again} again.`;
    case 'not_configured': return NOT_CONNECTED_TEXT;
    case 'closed': return CLOSED_TEXT;
    default: return 'Canvas could not complete that request.';
  }
};

const timeLabel = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
const dueLabel = (iso) => `${dayLabel(pacificDate(new Date(iso)))}, ${timeLabel(iso)}`;
const plural = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;

export function createQuizDesk({ canvas, createPost, draftQuiz = realDraftQuiz, draftOne = realDraftOne, now = () => new Date(), emit = () => {}, classCount = null } = {}) {
  const drafts = new Map();
  const discarded = new Set(); // draft ids the professor discarded (approving one says so, not "restart")
  const ops = new Map(); // operationId -> { sig, promise, done, result }
  let latest = null;
  let pendingQuiz = null;
  let resetGen = 0; // bumped by reset(): a draft call that finishes after it must not leave a live draft
  const clock = () => (typeof now === 'function' ? now() : now);
  const tell = (type, runId, data) => { try { emit(type, runId, data); } catch { /* telemetry must never break the desk */ } };

  // ---- topic list --------------------------------------------------------------------------------------------
  function topicsPayload() {
    const taught = taughtTopics(clock());
    const through = taught[taught.length - 1] ?? null;
    return {
      taughtThrough: through ? through.n : 0,
      throughDate: through ? through.taught : null,
      units: [...new Set(TOPICS.map((t) => t.unit))].map((unit) => {
        const list = TOPICS.filter((t) => t.unit === unit);
        return { unit, from: list[0].n, to: list[list.length - 1].n, topics: list.map((t) => ({ n: t.n, name: t.name, taught: t.taught <= pacificDate(clock()), date: t.taught })) };
      }),
    };
  }
  function topicsReply(reply, highlight = null) {
    const topics = topicsPayload();
    return { action: 'quiz_topics', reply: reply ?? `Which topic should the quiz cover? Here's what Marketing 351 has covered so far — through Topic ${topics.taughtThrough} (${dayLabel(topics.throughDate)}).`, topics, highlight };
  }
  const beforeTerm = () => ({ action: 'quiz_before_term', reply: `No Marketing 351 topics have been taught yet this term — the first class is ${dayLabel(TERM.start)}.` });

  // ---- chat turn ---------------------------------------------------------------------------------------------
  const pickTopic = (said) => {
    const bare = /^\s*#?\s*(\d{1,2})\s*$/.exec(said);
    if (bare) { const n = Number(bare[1]); return n >= 1 && n <= 20 ? n : null; }
    return topicFromWords(said);
  };
  const openDraft = () => [...drafts.values()].find((d) => OPEN_STATES.has(d.state)) ?? null;

  // A waiting topic question takes only a bare number, "topic N", a chip's text or a short (4 words or fewer) reply
  // that names a topic; anything else is a new message for the other handlers. It expires after 15 minutes.
  const asking = () => {
    if (pendingQuiz && clock().getTime() - pendingQuiz.at > ASK_EXPIRES_MS) pendingQuiz = null;
    return pendingQuiz;
  };
  const answersTopicQuestion = (text) => {
    if (/^\s*#?\s*\d{1,2}\s*$/.test(text) || /^\s*topic\s*#?\s*\d{1,2}\s*$/i.test(text)) return true;
    return text.trim().split(/\s+/).length <= 4 && topicFromWords(text) !== null;
  };
  const openText = (open) => (open.state === 'kept'
    ? `You have a quiz saved as a draft in Canvas (Topic ${open.topic}). Publish or discard it first.`
    : `You have a draft open (Topic ${open.topic}). Approve or discard it first.`);

  // quizTopic: the page's structured chip pick (a topic number). A chip's exact text is claimed the same way, whatever
  // else is going on (a draft open, a restart, a reply chip, an HR card): it is never a message for students or HR.
  async function turn(said, { operationId, quizTopic = null } = {}) {
    const text = String(said ?? '');
    const chip = quizTopic ?? chipTopicOf(text);
    const ask = chip === null && asksQuiz(text);
    const waiting = asking();
    if (chip === null && !ask && !(waiting && answersTopicQuestion(text))) return null;
    let n; let count;
    if (chip !== null) { n = chip; count = waiting?.count ?? 5; }
    else if (ask) { n = pickTopic(text); count = countFromWords(text) ?? 5; }
    else { n = pickTopic(text); count = waiting.count; if (n === null) return null; }
    const runId = `prof-${operationId ?? randomUUID().slice(0, 12)}`;
    if (!taughtTopics(clock()).length) { pendingQuiz = null; tell('quiz_turn', runId, { outcome: 'before_term' }); return beforeTerm(); }
    const open = openDraft();
    if (open) { tell('quiz_turn', runId, { outcome: 'draft_open', draftId: open.draftId }); return { action: 'quiz_draft_open', reply: openText(open) }; }
    if (n === null) { pendingQuiz = { count, at: clock().getTime() }; tell('quiz_turn', runId, { outcome: 'topics' }); return topicsReply(); }
    if (!isTaught(n, clock())) {
      pendingQuiz = { count, at: clock().getTime() };
      const t = TOPICS.find((x) => x.n === n);
      tell('quiz_turn', runId, { outcome: 'untaught', topic: n });
      return topicsReply(`${t.name} (Topic ${n}) is taught on ${dayLabel(t.taught)} — it hasn't been covered yet. Pick a covered topic.`, n);
    }
    pendingQuiz = null;
    count = Math.min(20, Math.max(1, count));
    const gen = resetGen;
    let res;
    try { res = await draftQuiz({ topic: n, count, emit: (type, data) => tell(type, runId, data) }); } catch { res = { questions: [], by: 'model_failed', short: count }; }
    if (gen !== resetGen) { tell('quiz_turn', runId, { outcome: 'reset_during_draft', topic: n }); return { action: 'quiz_draft_failed', reply: 'The class was reset while I was drafting, so no draft was kept. Ask again.' }; }
    if (!res || (res.by === 'model_failed' && !res.questions?.length)) {
      tell('quiz_turn', runId, { outcome: 'draft_failed', topic: n });
      return { action: 'quiz_draft_failed', reply: "I couldn't draft questions just now. Try again in a moment." };
    }
    const quiz = { topic: n, ...defaultSettings(n, clock()), questions: res.questions.map((q) => ({ ...q })) };
    const draft = { draftId: `qd-${randomUUID().slice(0, 12)}`, topic: n, state: 'draft', quiz, canvasQuizId: null, receipt: null, deliveries: null, noticeSent: false, by: res.by, model: res.model, short: res.short ?? 0, wanted: count };
    drafts.set(draft.draftId, draft);
    latest = draft.draftId;
    const t = TOPICS.find((x) => x.n === n);
    let reply = `Here's a draft quiz on Topic ${n} (${t.name}) — ${plural(quiz.questions.length, 'question')}. Read every answer before approving.`;
    if (draft.short > 0) reply += ` The AI drafted ${quiz.questions.length} of ${count} — add or draft the rest.`;
    tell('quiz_turn', runId, { outcome: 'drafted', draftId: draft.draftId, topic: n, questionCount: quiz.questions.length });
    return { action: 'quiz_draft', draftId: draft.draftId, reply, short: draft.short, entries: [{ role: 'assistant', text: reply, quiz: { draftId: draft.draftId } }] };
  }

  // ---- views -------------------------------------------------------------------------------------------------
  const clean = (v) => structuredClone(v);
  function draft(draftId) {
    const d = drafts.get(draftId);
    if (!d || d.state !== 'draft') return null; // the answer key leaves the server once the quiz is saved in Canvas
    return { draftId: d.draftId, topic: d.topic, state: d.state, canvasQuizId: d.canvasQuizId, quiz: clean(d.quiz), drafted: { by: d.by, model: d.model, short: d.short, wanted: d.wanted } };
  }
  function card() {
    const d = latest ? drafts.get(latest) : null;
    if (!d) return null;
    const n = d.quiz.questions.length;
    const c = { draftId: d.draftId, topic: d.topic, state: d.state, canvasQuizId: d.canvasQuizId, questionCount: n, pointsTotal: n * d.quiz.pointsEach };
    // Round 2 (R6): once published (the class is told these facts anyway) the title, due date, minutes and attempts too —
    // never a question or an answer — so the card still reads "… Topic 3 Quiz: … is open in Canvas (quiz #4821), due
    // Mon, Nov 9, 11:59 PM." after a reload. Before that the state (pushed to every page's stream) carries no title.
    if (d.state === 'published') Object.assign(c, { title: String(d.quiz.title ?? ''), dueAt: d.quiz.dueAt ?? null, minutes: d.quiz.minutes ?? null, attempts: d.quiz.attempts ?? null });
    if (d.deliveries) c.deliveries = d.deliveries.map((x) => ({ studentId: x?.studentId ?? null, status: x?.status ?? x?.state ?? null }));
    // Published in Canvas but the class notice did not go out: the card must say so and offer the retry, across redraws,
    // tab changes and reloads (the page reads this summary from /author/state). The sentence only, never a list or a name.
    if (d.state === 'published' && !d.noticeSent && d.noticeFailText) { c.noticePending = true; c.noticeText = d.noticeFailText; }
    return c;
  }
  function reset() {
    const entries = [];
    for (const d of drafts.values()) {
      if (d.state !== 'closed') { entries.push({ role: 'assistant', text: CLOSED_TEXT, quiz: { draftId: d.draftId } }); d.state = 'closed'; }
    }
    pendingQuiz = null;
    resetGen += 1;
    return { closed: entries.length, entries };
  }

  // ---- actions -----------------------------------------------------------------------------------------------
  const entry = (d, text) => ({ role: 'assistant', text, quiz: { draftId: d.draftId } });
  const closedResult = (d, draftId = null) => ({ ok: false, closed: true, state: 'closed', draftId: d?.draftId ?? draftId, text: d || !discarded.has(draftId) ? CLOSED_TEXT : DISCARDED_TEXT });
  const refuse = (d, code, text) => ({ ok: false, refused: true, code, state: d.state, draftId: d.draftId, text });

  async function approve(d, quiz, operationId, runId) {
    if (d.state === 'saved' || d.state === 'kept' || d.state === 'published') return { ok: true, already: true, state: d.state, draftId: d.draftId, canvasQuizId: d.canvasQuizId, text: d.state === 'published' ? publishedText(d) : "Saved in Canvas as an unpublished quiz — students can't see it yet." };
    if (d.state !== 'draft') return { ok: false, busy: true, state: d.state, draftId: d.draftId, text: 'Still working on this draft. Wait a moment.' };
    const checked = checkQuiz(quiz, clock());
    if (!checked.ok) return { ok: false, refused: true, code: checked.code, state: d.state, draftId: d.draftId, text: checked.problem, ...(checked.index === undefined ? {} : { index: checked.index }) };
    if (checked.quiz.topic !== d.topic) return refuse(d, 'bad_settings', "That quiz isn't on this draft's topic.");
    d.state = 'saving';
    const r = await canvas.createQuiz({ quiz: clean(checked.quiz), operationId, runId, isClosed: () => d.state === 'closed' });
    if (d.state === 'closed') return closedResult(d);
    if (!r.ok) {
      d.state = 'draft';
      if (r.outcome === 'refused') return { ok: false, refused: true, code: r.code ?? null, state: 'draft', draftId: d.draftId, text: r.reason ?? failText('refused', 'approve') };
      if (r.outcome === 'not_configured') return { ok: false, outcome: 'not_configured', state: 'draft', draftId: d.draftId, text: NOT_CONNECTED_TEXT }; // a definite answer, not a "try again"
      return { ok: false, retryable: true, outcome: r.outcome, unknownOutcome: r.outcome === 'uncertain' || r.outcome === 'unavailable', state: 'draft', draftId: d.draftId, text: failText(r.outcome, 'approve') };
    }
    const receipt = r.value?.receipt ?? r.value ?? {};
    d.quiz = clean(checked.quiz);
    d.canvasQuizId = receipt.quizId ?? null;
    d.receipt = receipt;
    d.state = 'saved';
    const n = typeof classCount === 'function' ? classCount() : null; // the real class size from CHRS, never the 2-person session list
    return {
      ok: true, state: 'saved', draftId: d.draftId, canvasQuizId: d.canvasQuizId, courseLabel: receipt.courseLabel ?? null,
      text: "Saved in Canvas as an unpublished quiz — students can't see it yet.",
      prompt: `Publish it now? Publishing makes it visible in Canvas, and ${Number.isInteger(n) ? `your ${n} ${n === 1 ? 'student' : 'students'}` : 'your students'} get a notification.`,
      entries: [entry(d, `Saved in Canvas as quiz #${d.canvasQuizId}`)],
    };
  }

  function noticeText(d) {
    const q = d.quiz;
    return `A new quiz is open in Canvas: ${q.title} — ${plural(q.questions.length, 'question')}, ${plural(q.questions.length * q.pointsEach, 'point')}, ${plural(q.minutes, 'minute')}, due ${dueLabel(q.dueAt)}. Take it in Canvas.`;
  }
  async function sendNotice(d) {
    const q = d.quiz;
    let r;
    try {
      r = await createPost({
        operationId: `quiz-notice-${d.draftId}`, kind: 'message', title: 'New quiz', text: noticeText(d), audience: 'all', verbatim: false,
        quiz: { canvasQuizId: d.canvasQuizId, title: q.title, questions: q.questions.length, points: q.questions.length * q.pointsEach, minutes: q.minutes, attempts: q.attempts, dueAt: q.dueAt },
      });
    } catch { r = null; }
    const ok = r && r.http >= 200 && r.http < 300 && r.body?.ack?.status !== 'rejected';
    if (ok) { d.noticeSent = true; d.deliveries = Array.isArray(r.body?.ack?.deliveries) ? r.body.ack.deliveries : []; }
    // The class list wasn't available, so nothing was addressed (the Hub never sends to a guessed list).
    d.noticeNoList = !ok && r?.body?.ack?.reason === ROSTER_UNAVAILABLE_CODE;
    return ok;
  }

  async function publish(d, operationId, runId) {
    if (d.state === 'published' && d.noticeSent) return { ok: true, already: true, state: 'published', draftId: d.draftId, canvasQuizId: d.canvasQuizId, text: publishedText(d) };
    if (d.state !== 'saved' && d.state !== 'kept' && d.state !== 'published') {
      return { ok: false, busy: true, state: d.state, draftId: d.draftId, text: d.state === 'draft' ? 'Approve the quiz first.' : 'Still working on this draft. Wait a moment.' };
    }
    const before = d.state;
    if (before !== 'published') {
      d.state = 'publishing';
      const r = await canvas.publishQuiz({ quizId: d.canvasQuizId, operationId, runId, isClosed: () => d.state === 'closed' });
      if (d.state === 'closed') return closedResult(d);
      if (!r.ok) {
        d.state = before;
        if (r.outcome === 'refused') return { ok: false, refused: true, code: r.code ?? null, state: before, draftId: d.draftId, text: r.reason ?? failText('refused', 'publish') };
        if (r.outcome === 'not_configured') return { ok: false, outcome: 'not_configured', state: before, draftId: d.draftId, text: NOT_CONNECTED_TEXT };
        return { ok: false, retryable: true, outcome: r.outcome, unknownOutcome: r.outcome === 'uncertain' || r.outcome === 'unavailable', state: before, draftId: d.draftId, text: failText(r.outcome, 'publish') };
      }
      d.state = 'published';
    }
    // Students are told only after Canvas confirmed, once per draft (the post's operationId is fixed).
    const sent = await sendNotice(d);
    if (d.state === 'closed') return closedResult(d);
    if (!sent) {
      d.noticeFailText = d.noticeNoList ? NOTICE_NO_LIST_TEXT : NOTICE_FAILED_TEXT;
      return { ok: false, retryable: true, published: true, state: 'published', draftId: d.draftId, canvasQuizId: d.canvasQuizId, text: d.noticeFailText };
    }
    d.noticeFailText = null;
    return { ok: true, state: 'published', draftId: d.draftId, canvasQuizId: d.canvasQuizId, deliveries: card()?.deliveries ?? [], text: publishedText(d), entries: [entry(d, `Published in Canvas (quiz #${d.canvasQuizId}). Students notified.`)] };
  }
  const publishedText = (d) => `Published — ${d.quiz.title} is open in Canvas (quiz #${d.canvasQuizId}), due ${dueLabel(d.quiz.dueAt)}.`;

  async function oneMore(d, body, runId) {
    if (d.state !== 'draft') return { ok: false, busy: true, state: d.state, draftId: d.draftId, text: 'Approve or discard the draft before changing it.' };
    if (!isTaught(d.topic, clock())) return refuse(d, 'not_taught', `Topic ${d.topic} has not been taught yet.`);
    // The page tells us the questions it holds now (his edits, additions and removals); else the draft's own.
    if (body.existing !== undefined && !validExisting(body.existing)) return refuse(d, 'bad_request', 'Malformed list of questions.');
    const existing = body.existing ?? d.quiz.questions.map((q) => String(q?.text ?? ''));
    if (existing.length >= MAX_EXISTING) return refuse(d, 'bad_question', 'A quiz can have at most 20 questions.');
    let r;
    try { r = await draftOne({ topic: d.topic, existing, emit: (type, data) => tell(type, runId, data) }); } catch { r = { question: null, by: 'model_failed' }; }
    if (d.state === 'closed') return closedResult(d);
    if (!r?.question) {
      const failed = !r || r.by === 'model_failed';
      return { ok: false, retryable: failed, state: d.state, draftId: d.draftId, text: failed ? "The AI couldn't draft another question just now. Try again in a moment." : 'There are no more new questions in the notes for this topic.' };
    }
    return { ok: true, state: d.state, draftId: d.draftId, question: { ...r.question } };
  }

  async function run(body, operationId, runId) {
    const d = drafts.get(body.draftId);
    if (!d) return closedResult(null, body.draftId);
    if (d.state === 'closed') return closedResult(d);
    switch (body.action) {
      case 'approve': return approve(d, body.quiz, operationId, runId);
      case 'publish': return publish(d, operationId, runId);
      case 'one_more': return oneMore(d, body, runId);
      case 'keep_draft': {
        if (d.state !== 'saved' && d.state !== 'kept') return { ok: false, busy: true, state: d.state, draftId: d.draftId, text: d.state === 'published' ? 'It is already published.' : 'Approve the quiz first.' };
        d.state = 'kept';
        const text = `Kept as a draft in Canvas (quiz #${d.canvasQuizId}). Nobody was notified.`;
        return { ok: true, state: 'kept', draftId: d.draftId, canvasQuizId: d.canvasQuizId, text, entries: [entry(d, text)] };
      }
      case 'discard': {
        if (d.state === 'saving' || d.state === 'publishing') return { ok: false, busy: true, state: d.state, draftId: d.draftId, text: 'Still working on this draft. Wait a moment.' };
        if (d.state === 'published') return { ok: false, busy: true, state: d.state, draftId: d.draftId, text: 'It is already published.' };
        const text = d.canvasQuizId ? `Discarded the card. Quiz #${d.canvasQuizId} stays unpublished in Canvas.` : 'Discarded the draft.';
        drafts.delete(d.draftId);
        discarded.add(d.draftId);
        if (latest === d.draftId) latest = null;
        return { ok: true, state: 'discarded', draftId: d.draftId, text, entries: [{ role: 'assistant', text, quiz: { draftId: d.draftId } }] };
      }
      default: return { ok: false, refused: true, code: 'bad_action', state: d.state, draftId: d.draftId, text: 'Unknown action.' };
    }
  }

  // Definite outcomes (ok / refused) are remembered by operationId; retryable and unknown ones never are.
  async function action(body = {}) {
    const { draftId, operationId, action: act } = body;
    if (typeof draftId !== 'string' || typeof operationId !== 'string' || !operationId || !ACTIONS.has(act)) {
      return { ok: false, refused: true, code: 'bad_request', text: 'Malformed quiz action.' };
    }
    const sig = JSON.stringify([draftId, act, act === 'approve' ? body.quiz ?? null : null, act === 'one_more' ? body.existing ?? null : null]);
    const known = ops.get(operationId);
    if (known) {
      if (known.sig !== sig) return { ok: false, refused: true, code: 'operation_reused', text: 'That request id was already used for something else.' };
      return known.promise.then((r) => ({ ...r, duplicate: true }));
    }
    const runId = `prof-${operationId}`;
    const promise = (async () => {
      let r;
      try { r = await run(body, operationId, runId); } catch { r = { ok: false, retryable: true, unknownOutcome: true, state: drafts.get(draftId)?.state ?? null, draftId, text: failText('uncertain', act === 'publish' ? 'publish' : 'approve') }; }
      tell('quiz_action', runId, { draftId, action: act, ok: r.ok, outcome: r.ok ? 'ok' : (r.outcome ?? (r.refused ? 'refused' : r.closed ? 'closed' : 'not_done')), code: r.code ?? null, quizId: r.canvasQuizId ?? null, questionCount: Array.isArray(body.quiz?.questions) ? body.quiz.questions.length : null });
      if (!(r.ok || r.refused)) ops.delete(operationId);
      return r;
    })();
    ops.set(operationId, { sig, promise });
    return promise;
  }

  return { turn, action, draft, card, reset, pending: () => Boolean(asking()), topics: (highlight = null, count = 5) => {
    if (!taughtTopics(clock()).length) return beforeTerm();
    const open = openDraft();
    if (open) return { action: 'quiz_draft_open', reply: openText(open) };
    pendingQuiz = { count: Number.isInteger(count) ? count : 5, at: clock().getTime() }; // the next topic number or name answers this list
    return topicsReply(null, highlight);
  } };
}
