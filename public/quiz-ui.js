// Part 16: Dr. Dabirian's Canvas quiz in the Faculty view, and the student's quiz notice.
//   * Topic chips: the assistant's "Which topic should the quiz cover?" reply carries the course schedule
//     (`quizTopics`); a taught topic is a button, a later one is shown with its date and can't be picked.
//   * The quiz draft card: a summary slip, the settings, every question (edit, remove with undo, add one,
//     "draft one more with AI"), Approve & post to Canvas (disabled until the shared rules pass) and Discard.
//     Edits live in the page until Approve; Approve sends the whole final quiz. The card's element is kept in
//     place across redraws (like the HR card), so a half-typed question survives the Faculty view's refreshes.
//   * The Canvas cards: "Saved in Canvas" (unpublished) with Publish & notify / Keep as draft, then
//     "Published" with each student's notice state. Retryable results (Canvas didn't answer, the AI didn't
//     choose a tool) keep the same operation ID, so pressing the button again can't post twice.
// The answer key (which answer is correct) is fetched only by the Faculty view, only while it is showing, and
// is never put on the student's page. Everything is set with textContent.
import { checkQuiz, summaryLine } from '/shared/quiz-rules.js';
import { dayLabel, pacificDate } from '/shared/course-schedule.js';

const RANK = { draft: 0, saving: 1, saved: 2, kept: 3, publishing: 4, published: 5 };
const LETTERS = ['a', 'b', 'c', 'd'];
const COURSE_LABEL = 'MKTG 351 (Fall 2026)';
export const CLOSED_TEXT = 'This draft was closed when the app restarted.';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });
const partsFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const validDate = (iso) => typeof iso === 'string' && iso !== '' && !Number.isNaN(new Date(iso).getTime());
export const dueDay = (iso) => (validDate(iso) ? dayLabel(pacificDate(new Date(iso))) : '');
export const dueText = (iso) => (validDate(iso) ? `${dueDay(iso)}, ${timeFmt.format(new Date(iso)).replace(/ /g, ' ')}` : 'no due date');
// Pacific wall-clock <-> the datetime-local input ("YYYY-MM-DDTHH:MM"); the due date is always Pacific time.
function toInput(iso) {
  if (!validDate(iso)) return '';
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function fromInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!m) return '';
  const [y, mo, d, hh, mm] = m.slice(1).map(Number);
  for (const off of [7, 8]) { // PDT, then PST
    const guess = new Date(Date.UTC(y, mo - 1, d, hh + off, mm));
    if (toInput(guess.toISOString()) === value) return guess.toISOString();
  }
  return '';
}

// The quiz facts as the student reads them: “5 questions · 15 points · 10 minutes · 1 attempt · due Mon, Nov 9, 11:59 PM”
// (the due part in bold). Facts only — the notice never carries a question or an answer.
export function quizFactsLine(q, el) {
  return el('p', { className: 'quiz-facts' },
    el('b', { textContent: plural(q.questions, 'question') }),
    ` · ${plural(q.points, 'point')} · ${plural(q.minutes, 'minute')} · ${plural(q.attempts, 'attempt')} · due `,
    el('b', { textContent: dueText(q.dueAt) }));
}

export function createQuizUi({ el, api, bubble, nameOf, posts, studentCount, studentState, DELIVERY, isShowing, sendTopic, redraw, pin }) {
  const views = new Map(); // draftId -> view
  let seq = 0;
  let pass = 0; // one render pass of the chat; views not drawn in a pass are forgotten
  const id = () => `${++seq}`;

  // ---- topic chips ------------------------------------------------------------------------------------------
  // `live` = this is the newest topic list, still waiting for his answer. Every older list is history: its chips are
  // disabled (a stale chip must never start anything). A tap is a structured pick (sendTopic), not typed text.
  function topicsBlock({ topics, highlight }, live = false) {
    const pick = el('div', { className: 'topic-pick', role: 'group', ariaLabel: 'Topics covered in class' });
    for (const u of topics.units) {
      const chips = el('div', { className: 'chips' });
      for (const t of u.topics) {
        const day = new Date(`${t.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
        const chip = el('button', { type: 'button', className: 'tchip', dataset: { topic: String(t.n) }, disabled: !t.taught || !live, ariaPressed: highlight === t.n ? 'true' : 'false' },
          el('b', { textContent: String(t.n) }), t.taught ? t.name : `${t.name} — ${day}`);
        if (t.taught && live) chip.addEventListener('click', () => { chip.setAttribute('aria-pressed', 'true'); sendTopic(t.n, `Topic ${t.n} · ${t.name}`); });
        chips.append(chip);
      }
      pick.append(el('div', { className: 'unit' }, el('h4', {}, `Exam ${u.unit} unit `, el('span', { textContent: `Topics ${u.from}–${u.to}` })), chips));
    }
    pick.append(el('p', { className: 'pick-foot', textContent: 'Or just type it — “a quiz on pricing”, “segmentation, 8 questions”.' }));
    return pick;
  }

  // ---- one quiz (draft card, then Canvas card) ----------------------------------------------------------------
  const snap = (q) => JSON.stringify({ text: q.text, answers: q.answers, correct: q.correct });
  function itemsFrom(questions) {
    return questions.map((q) => {
      const item = { id: id(), text: q.text, answers: [...q.answers], correct: q.correct, tag: 'ai', mode: 'view', n: 0 };
      item.orig = snap(item);
      return item;
    });
  }
  function view(draftId) {
    let v = views.get(draftId);
    if (v) return v;
    v = {
      draftId, loaded: false, loading: false, drafted: null, q: null, notice: null, lmsNotice: null, busy: false, approving: false,
      pending: null, after: null, canvasQuizId: null, courseLabel: null, prompt: null, approvedAt: null,
      li: el('li', { className: 'msg quiz-card', dataset: { dir: 'received', speaker: 'professor', draftId } }),
      lms: el('li', { className: 'msg lms-card', dataset: { dir: 'received', draftId } }),
    };
    views.set(draftId, v);
    return v;
  }
  async function load(v) {
    if (v.loading || v.tried) return;
    v.tried = true;
    v.loading = true;
    const r = await api(`/api/professor/quiz/${encodeURIComponent(v.draftId)}`).catch(() => null);
    v.loading = false;
    if (!views.has(v.draftId)) return;
    if (r?.ok && r.json?.quiz) {
      v.loaded = true;
      v.drafted = r.json.drafted ?? null;
      v.canvasQuizId = r.json.canvasQuizId ?? v.canvasQuizId;
      if (!v.q) v.q = { ...r.json.quiz, items: itemsFrom(r.json.quiz.questions), questions: undefined };
      redraw();
    } else if (!(r && r.status === 404)) {
      setTimeout(() => { v.tried = false; if (views.has(v.draftId)) redraw(); }, 3000); // try again shortly (a closed draft, 404, is not retried)
    }
  }

  const finalQuiz = (v) => ({
    topic: v.q.topic, title: v.q.title, pointsEach: v.q.pointsEach, minutes: v.q.minutes, attempts: v.q.attempts, dueAt: v.q.dueAt,
    questions: v.q.items.filter((i) => i.mode !== 'removed').map((i) => ({ text: i.text.trim(), answers: i.answers.map((a) => a.trim()), correct: i.correct })),
  });
  const counts = (v) => ({
    edited: v.q.items.filter((i) => i.mode !== 'removed' && i.tag === 'edited').length,
    added: v.q.items.filter((i) => i.mode !== 'removed' && i.tag === 'added').length,
    removed: v.q.items.filter((i) => i.mode === 'removed' && i.tag !== 'added').length,
  });
  const byYou = (c) => [c.edited && `${c.edited} edited`, c.added && `${c.added} added`, c.removed && `${c.removed} removed`].filter(Boolean).join(', ');

  function slipMeta(v) {
    const quiz = finalQuiz(v);
    const wrap = el('p', { className: 'm' });
    try {
      const parts = summaryLine(quiz).split(' · ');
      const last = parts.pop();
      wrap.append(el('b', { textContent: parts.shift() }), ` · ${parts.join(' · ')} · due `, el('b', { style: 'white-space:nowrap', textContent: last.replace(/^due /, '') }));
    } catch { wrap.textContent = 'Fill in the settings to see the summary.'; }
    return wrap;
  }
  function checkLine(v) {
    const quiz = finalQuiz(v);
    const r = checkQuiz(quiz, new Date());
    const n = quiz.questions.length;
    return r.ok ? { ok: true, node: el('span', { className: 'q-check', dataset: { ok: 'true' } }, el('b', { textContent: '✓' }), ` ${plural(n, 'question')} ready · ${plural(n * quiz.pointsEach, 'point')}`) }
      : { ok: false, node: el('span', { className: 'q-check', dataset: { ok: 'false' }, textContent: r.problem }) };
  }
  // Settings, the slip and the Approve button follow every keystroke; the question list is only redrawn on structure changes.
  function refresh(v) {
    if (!v.ui) return;
    v.ui.meta.replaceWith(v.ui.meta = slipMeta(v));
    v.ui.title.textContent = v.q.title || 'Untitled quiz';
    const c = checkLine(v);
    v.ui.check.replaceWith(v.ui.check = c.node);
    const off = v.busy || Boolean(v.discarded);
    v.ui.approve.disabled = !c.ok || off;
    v.ui.add.disabled = off;
    v.ui.more.disabled = off;
    v.ui.discard.disabled = off;
  }

  const fld = (label, input) => { input.id = `qf-${id()}`; return el('div', { className: 'fld' }, el('label', { htmlFor: input.id, textContent: label }), input); };
  const tagEl = (item) => el('span', { className: `q-tag ${item.tag === 'ai' ? 'ai' : 'you'}`, textContent: item.tag === 'ai' ? 'AI draft' : item.tag === 'edited' ? 'Edited by you' : 'Added by you' });
  function markEdited(item) {
    if (item.tag !== 'added') item.tag = snap(item) === item.orig ? 'ai' : 'edited';
  }
  function drawList(v) {
    const list = v.ui.list;
    list.replaceChildren(...v.q.items.map((item, i) => {
      if (item.mode === 'removed') {
        return el('li', { className: 'q removed', dataset: { removed: 'true' } },
          el('span', { textContent: `Question ${item.n} removed — “${item.text.trim().slice(0, 60)}${item.text.trim().length > 60 ? '…' : ''}”` }),
          el('button', { type: 'button', className: 'icon-btn', dataset: { act: 'undo' }, style: 'color:var(--professor);font-weight:700', textContent: 'Undo', onclick: () => { item.mode = 'view'; drawList(v); refresh(v); } }));
      }
      if (item.mode === 'edit') {
        const text = el('textarea', { value: item.text, ariaLabel: 'Question' });
        text.addEventListener('input', () => { item.text = text.value; markEdited(item); tag.replaceWith(tag = tagEl(item)); refresh(v); });
        let tag = tagEl(item);
        const radios = item.answers.map((a, k) => {
          const radio = el('input', { type: 'radio', name: `q-${v.draftId}-${item.id}`, checked: item.correct === k, ariaLabel: `Answer ${LETTERS[k]} is correct` });
          radio.addEventListener('change', () => { item.correct = k; markEdited(item); tag.replaceWith(tag = tagEl(item)); refresh(v); });
          const input = el('input', { type: 'text', value: a, ariaLabel: `Answer ${LETTERS[k]}` });
          input.addEventListener('input', () => { item.answers[k] = input.value; markEdited(item); tag.replaceWith(tag = tagEl(item)); refresh(v); });
          return el('li', {}, radio, el('span', { className: 'l', textContent: LETTERS[k] }), input);
        });
        return el('li', { className: 'q editing', dataset: { id: item.id } },
          el('div', { className: 'q-top' }, el('span', { className: 'num' }), el('p', { className: 'stem', style: 'font-weight:700', textContent: 'Editing question' }), tag),
          fld('Question', text),
          el('ul', { className: 'edit-opts', ariaLabel: 'Answers — pick the correct one' }, ...radios),
          el('div', { className: 'edit-foot' }, el('span', { textContent: 'The green dot marks the correct answer.' }),
            el('span', {}, el('button', { type: 'button', className: 'btn-link', style: 'font-size:.88rem', dataset: { act: 'done' }, textContent: 'Done', onclick: () => { markEdited(item); item.mode = 'view'; drawList(v); refresh(v); } }))));
      }
      return el('li', { className: 'q', dataset: { id: item.id } },
        el('div', { className: 'q-top' }, el('span', { className: 'num' }), el('p', { className: 'stem', textContent: item.text }), tagEl(item),
          el('span', { className: 'q-tools' },
            el('button', { type: 'button', className: 'icon-btn', dataset: { act: 'edit' }, textContent: 'Edit', onclick: () => { item.mode = 'edit'; drawList(v); refresh(v); } }),
            el('button', { type: 'button', className: 'icon-btn', dataset: { act: 'remove' }, textContent: 'Remove', onclick: () => { item.n = v.q.items.slice(0, i + 1).filter((x) => x.mode !== 'removed').length; item.mode = 'removed'; drawList(v); refresh(v); } }))),
        el('ul', { className: 'opts' }, ...item.answers.map((a, k) => el('li', { dataset: item.correct === k ? { correct: '' } : {} }, el('span', { className: 'l', textContent: LETTERS[k] }), a))));
    }));
  }

  function buildDraft(v) {
    const q = v.q;
    const head = el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: 'Course assistant · Quiz draft' }), el('time', { textContent: new Date(v.at ?? Date.now()).toLocaleTimeString([], { hour12: false }) }));
    const by = v.drafted?.model && v.drafted.by !== 'mock' ? v.drafted.model : null;
    const from = `${by ? `Drafted by ${by}` : 'Drafted by the offline mock (labelled placeholder questions)'} from the Topic ${q.topic} course notes — read every answer before approving.${v.drafted?.short > 0 ? ` The AI drafted ${q.items.length} of ${v.drafted.wanted} — add or draft the rest.` : ''}`;
    const title = el('p', { className: 't' });
    const meta = el('p', { className: 'm' });
    const inTitle = el('input', { type: 'text', value: q.title, maxLength: 120 });
    const inPoints = el('input', { type: 'number', min: 1, max: 10, step: 1, value: String(q.pointsEach) });
    const inMinutes = el('input', { type: 'number', min: 1, max: 120, step: 1, value: String(q.minutes) });
    const inDue = el('input', { type: 'datetime-local', value: toInput(q.dueAt) });
    const inAttempts = el('input', { type: 'number', min: 1, max: 3, step: 1, value: String(q.attempts) });
    inTitle.addEventListener('input', () => { q.title = inTitle.value; refresh(v); });
    inPoints.addEventListener('input', () => { q.pointsEach = inPoints.value === '' ? NaN : Number(inPoints.value); refresh(v); });
    inMinutes.addEventListener('input', () => { q.minutes = inMinutes.value === '' ? NaN : Number(inMinutes.value); refresh(v); });
    inDue.addEventListener('input', () => { q.dueAt = fromInput(inDue.value); refresh(v); });
    inAttempts.addEventListener('input', () => { q.attempts = inAttempts.value === '' ? NaN : Number(inAttempts.value); refresh(v); });
    const list = el('ol', { className: 'q-list' });
    const add = el('button', { type: 'button', className: 'ghost-btn', dataset: { act: 'add' }, textContent: '+ Add a question' });
    const more = el('button', { type: 'button', className: 'ghost-btn', dataset: { act: 'more' } }, el('span', { className: 'spark', textContent: '✦' }), ' Draft one more with AI');
    const approve = el('button', { type: 'button', className: 'btn-primary', dataset: { act: 'approve' }, textContent: 'Approve & post to Canvas' });
    const discard = el('button', { type: 'button', className: 'btn-link', dataset: { act: 'discard' }, textContent: 'Discard draft' });
    const check = el('span', { className: 'q-check' });
    const note = el('p', { className: 'q-error', hidden: true, role: 'status' });
    v.ui = { title, meta, list, check, approve, add, more, discard, note };
    add.addEventListener('click', () => {
      if (v.q.items.length >= 20) return;
      const item = { id: id(), text: '', answers: ['', '', '', ''], correct: null, tag: 'added', mode: 'edit', n: 0 };
      item.orig = snap(item);
      v.q.items.push(item);
      drawList(v);
      refresh(v);
      list.querySelector('.q.editing:last-child textarea')?.focus();
    });
    more.addEventListener('click', () => oneMore(v));
    approve.addEventListener('click', () => approveQuiz(v));
    discard.addEventListener('click', () => act(v, 'discard', {}, { ok: () => { v.discarded = true; } }));
    v.body = [
      head,
      el('p', { className: 'q-lead', textContent: "Here's a draft. Change anything you like, then approve it to post it to Canvas." }),
      el('section', { className: 'q-slip', ariaLabel: 'Summary' }, title, el('span', { className: 'state-badge', textContent: 'Not in Canvas yet' }), meta),
      el('p', { className: 'q-from', textContent: from }),
      el('div', { className: 'q-settings' }, fld('Quiz title', inTitle), fld('Points each', inPoints), fld('Minutes', inMinutes), fld('Due (Pacific)', inDue), fld('Attempts', inAttempts)),
      list,
      el('div', { className: 'add-row' }, add, more),
      el('div', { className: 'q-actions' }, approve, discard, check),
      note,
    ];
    v.li.replaceChildren(...v.body);
    drawList(v);
    refresh(v);
    showNote(v);
  }
  function showNote(v) {
    if (!v.ui) return;
    const n = v.notice;
    v.ui.note.hidden = !n;
    v.ui.note.dataset.kind = n?.kind ?? '';
    v.ui.note.textContent = n?.text ?? '';
  }

  // ---- talking to the server ---------------------------------------------------------------------------------
  // One operation ID per button press; it is reused when the answer was "try again" (nothing definite happened),
  // and replaced only after a definite outcome or when the values changed.
  async function send(v, action, extra = {}) {
    const key = JSON.stringify([action, extra.quiz ?? null, extra.existing ?? null]);
    if (v.pending?.key !== key) v.pending = { key, operationId: `op-${crypto.randomUUID()}` };
    const r = await api('/api/professor/quiz/actions', { method: 'POST', body: { draftId: v.draftId, operationId: v.pending.operationId, action, ...extra } }).catch(() => null);
    if (!r) return { error: 'Couldn’t reach the server. Press the button again — it won’t post twice.', retry: true };
    const body = r.json ?? {};
    const text = body.text ?? body.errors?._form ?? body.error ?? `Not done (HTTP ${r.status}).`;
    if (r.ok && body.ok) { v.pending = null; return { body }; }
    const retry = r.status === 503 || Boolean(body.retryable) || Boolean(body.unknownOutcome);
    if (!retry) v.pending = null;
    return { error: text, retry, body };
  }
  async function act(v, action, extra, { ok }) {
    if (v.busy) return;
    v.busy = true;
    v.doing = action;
    v.lmsNotice = null;
    drawCard(v);
    refresh(v);
    const r = await send(v, action, extra);
    v.busy = false;
    v.doing = null;
    if (r.body?.ok) { ok(r.body); v.lmsNotice = null; } else v.lmsNotice = { kind: r.retry ? 'warn' : 'bad', text: r.error };
    drawCard(v);
    refresh(v);
    redraw();
    pin();
  }
  // The Canvas card is drawn only once the quiz is saved in Canvas.
  const drawCard = (v) => { if (v.card && RANK[effective(v, v.card)] >= RANK.saved) drawLms(v, v.card); };
  async function approveQuiz(v) {
    const quiz = finalQuiz(v);
    if (v.busy || !checkQuiz(quiz, new Date()).ok) return;
    const c = counts(v);
    v.approveText = `${v.q.title.trim()} — ${plural(quiz.questions.length, 'question')}${byYou(c) ? ` (${byYou(c)} by you)` : ''}`;
    v.approvedAt = new Date().toISOString();
    v.approving = true;
    v.busy = true;
    v.notice = null;
    redraw();
    pin();
    const r = await send(v, 'approve', { quiz });
    v.busy = false;
    if (r.body?.ok) {
      v.after = 'saved';
      v.canvasQuizId = r.body.canvasQuizId ?? v.canvasQuizId;
      v.courseLabel = r.body.courseLabel ?? v.courseLabel;
      v.prompt = r.body.prompt ?? v.prompt;
    } else {
      v.approving = false; // the card reopens with the plain sentence
      v.notice = { kind: r.retry ? 'warn' : 'bad', text: r.error };
    }
    if (v.ui) showNote(v);
    redraw();
    pin();
  }
  async function oneMore(v) {
    if (v.busy) return;
    v.busy = true;
    v.notice = { kind: 'info', text: 'Asking the AI for one more question…' };
    showNote(v);
    refresh(v);
    // The questions he holds right now (edits, additions and removals included), so the AI doesn't repeat them.
    const existing = v.q.items.filter((i) => i.mode !== 'removed').map((i) => i.text.trim().slice(0, 300));
    if (existing.length >= 20) {
      v.busy = false;
      v.notice = { kind: 'bad', text: 'A quiz can have at most 20 questions.' };
      showNote(v);
      refresh(v);
      return;
    }
    const r = await send(v, 'one_more', { existing });
    v.busy = false;
    if (r.body?.ok && r.body.question) {
      const item = { id: id(), text: r.body.question.text, answers: [...r.body.question.answers], correct: r.body.question.correct, tag: 'ai', mode: 'view', n: 0 };
      item.orig = snap(item);
      v.q.items.push(item);
      v.notice = null;
      if (v.ui) drawList(v);
    } else v.notice = { kind: r.retry ? 'warn' : 'bad', text: r.error ?? 'No question came back.' };
    showNote(v);
    refresh(v);
  }

  // ---- the Canvas card ---------------------------------------------------------------------------------------
  function deliveries(v, card) {
    const post = posts().find((p) => p.quiz && p.quiz.canvasQuizId === (v.canvasQuizId ?? card?.canvasQuizId));
    const list = post?.deliveries?.length ? post.deliveries : (card?.deliveries ?? []).map((d) => ({ studentId: d.studentId, state: d.status }));
    if (!list.length) return el('p', { className: 'post-origin', textContent: post || v.after === 'published' ? 'Notice sent to the Hub…' : '' });
    return el('ul', { className: 'per-student' }, ...list.map((d) => {
      const [k, detail] = studentState(d);
      const [label, tone] = k === 'delivered' ? ['Notified', 'ok'] : (DELIVERY[k] ?? [k, 'warn']);
      return el('li', { dataset: { tone } }, el('span', { className: 'who', textContent: nameOf(d.studentId) }), el('span', { className: 'what', textContent: `${label}${detail ? ` — ${detail}` : ''}` }));
    }));
  }
  function effective(v, card) {
    const a = RANK[card?.state] ?? 0;
    const b = RANK[v.after] ?? 0;
    return b > a ? v.after : card?.state;
  }
  function drawLms(v, card) {
    const st = effective(v, card);
    const quizId = v.canvasQuizId ?? card?.canvasQuizId;
    const q = v.q ? finalQuiz(v) : null;
    const published = st === 'published';
    const head = el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: `Canvas LMS · ${published ? 'Published' : st === 'kept' ? 'Kept as draft' : 'Quiz saved'}` }), el('time', { textContent: new Date().toLocaleTimeString([], { hour12: false }) }));
    const title = q?.title ?? '';
    let lead;
    if (published) lead = el('p', { className: 'msg-text', style: 'margin:2px 0 0' }, el('span', { className: 'state-badge lms', textContent: '● Published' }), ` ${title ? `${title} is` : 'The quiz is'} open in Canvas (quiz #${quizId})${q ? `, due ${dueText(q.dueAt)}` : ''}.`);
    else if (st === 'kept') lead = el('p', { className: 'msg-text', style: 'margin:2px 0 0', textContent: `Kept as a draft in Canvas (quiz #${quizId}). Nobody was notified.` });
    else lead = el('p', { className: 'msg-text', style: 'margin:2px 0 0' }, 'Saved in Canvas as an ', el('b', { textContent: 'unpublished' }), " quiz — students can't see it yet.");
    const rows = published ? null : el('dl', { className: 'lms-row' },
      el('dt', { textContent: 'Canvas quiz' }), el('dd', { className: 'mono', textContent: `#${quizId} · ${v.courseLabel ?? COURSE_LABEL}` }),
      ...(q ? [
        el('dt', { textContent: 'Quiz' }), el('dd', { textContent: q.title }),
        el('dt', { textContent: 'Questions' }), el('dd', { textContent: `${q.questions.length} · ${plural(q.questions.length * q.pointsEach, 'point')} · ${plural(q.minutes, 'minute')} · ${plural(q.attempts, 'attempt')}` }),
        el('dt', { textContent: 'Due' }), el('dd', { textContent: dueText(q.dueAt) }),
      ] : []));
    const kids = [head, lead];
    if (rows) kids.push(rows);
    if (published) kids.push(deliveries(v, card));
    else {
      const working = st === 'publishing' || v.doing === 'publish';
      const publishBtn = el('button', { type: 'button', className: 'btn-primary lms', dataset: { act: 'publish' }, disabled: v.busy || st === 'publishing', textContent: 'Publish & notify students' });
      publishBtn.addEventListener('click', () => { act(v, 'publish', {}, { ok: (b) => { v.after = 'published'; v.publishedAt = new Date().toISOString(); v.deliveries = b.deliveries ?? null; } }); });
      const ask = el('div', { className: 'lms-ask' },
        el('p', {}, el('b', { textContent: 'Publish it now?' }), ` Publishing makes it visible in Canvas, and your ${plural(studentCount(), 'student')} get a notification.`),
        publishBtn, ' ');
      if (st !== 'kept') {
        const keep = el('button', { type: 'button', className: 'btn-link', style: 'color:var(--lms-ink)', dataset: { act: 'keep' }, disabled: v.busy || st === 'publishing', textContent: 'Keep as draft' });
        keep.addEventListener('click', () => { act(v, 'keep_draft', {}, { ok: () => { v.after = 'kept'; } }); });
        ask.append(keep);
      }
      if (working) ask.append(el('p', { className: 'lms-note' }, el('span', { className: 'working' }, el('i'), 'Publishing in Canvas…')));
      if (v.lmsNotice) ask.append(el('p', { className: 'q-error lms-note', dataset: { kind: v.lmsNotice.kind }, role: 'status', textContent: v.lmsNotice.text }));
      kids.push(ask);
    }
    v.lms.replaceChildren(...kids);
  }

  // ---- what the chat draws for a quiz entry ------------------------------------------------------------------
  const working = (text) => el('li', { className: 'msg', dataset: { dir: 'received', speaker: 'professor', working: 'true' } },
    el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: 'Course assistant' }), el('time', { textContent: new Date().toLocaleTimeString([], { hour12: false }) })),
    el('p', { className: 'msg-text' }, el('span', { className: 'working' }, el('i'), text)));
  // → an array of nodes (maybe empty) for the entry, or null to draw the entry as an ordinary bubble.
  function entry(m, card, chat) {
    if (!isShowing()) return [];
    const draftId = m.quiz.draftId;
    const live = card?.draftId === draftId && card.state !== 'closed';
    if (m.action !== 'quiz_draft') return live ? [] : null; // the cards say what these entries say
    if (!live) {
      views.delete(draftId);
      return chat.some((x) => x !== m && x.quiz?.draftId === draftId) ? [] : [bubble({ dir: 'info', speaker: 'professor', label: 'Course assistant · Quiz draft', at: m.at, text: CLOSED_TEXT })];
    }
    const v = view(draftId);
    v.at = v.at ?? m.at;
    v.pass = pass;
    v.card = card;
    load(v);
    const st = effective(v, card);
    if (st === 'draft' && !v.approving) {
      if (!v.q) {
        v.li.replaceChildren(el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: 'Course assistant · Quiz draft' })), el('p', { className: 'q-lead', textContent: 'Loading the draft…' }));
        v.ui = null;
        v.built = false;
      } else if (!v.built || !v.ui) { v.built = true; buildDraft(v); }
      return [v.li];
    }
    // The draft card is gone from the chat: his approval, then the Canvas card.
    const out = [];
    const title = v.q ? v.q.title.trim() : '';
    out.push(bubble({ dir: 'sent', speaker: 'student', label: 'You approved the quiz', at: v.approvedAt ?? m.at, text: v.approveText ?? `${title || `Topic ${card.topic} quiz`} — ${plural(card.questionCount, 'question')}` }));
    if (st === 'draft' || st === 'saving') out.push(working('Saving to Canvas…'));
    else {
      drawLms(v, card);
      if (st === 'published') out.push(bubble({ dir: 'sent', speaker: 'student', label: 'You', at: v.publishedAt ?? m.at, text: 'Publish & notify students' }));
      out.push(v.lms);
    }
    return out;
  }

  // Cards that must stay in place across a redraw (their element is never rebuilt).
  const kept = () => [...views.values()].flatMap((v) => [v.li, v.lms]);
  // Forget views whose elements are no longer drawn (the card closed, was discarded or replaced).
  const begin = () => { pass += 1; };
  function sync() {
    if (!isShowing()) {
      // Another tab is showing: the cards (and the answer key in them) leave the DOM, but his edits, any open
      // edit row, the pending operation ID and the notices stay in memory; they are redrawn from that state.
      for (const v of views.values()) { v.li.replaceChildren(); v.lms.replaceChildren(); v.built = false; v.ui = null; }
      return;
    }
    for (const [draftId, v] of views) if (v.pass !== pass) views.delete(draftId);
  }
  
  return { topicsBlock, entry, kept, begin, sync, dueText };
}
