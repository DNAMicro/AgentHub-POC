// Part 9: the classroom in the browser.
//   * Conversation view: the Student agent's course inbox (lessons the university delivered, persisted by
//     the Student agent), a one-time "course available" notice, a toast for a newly delivered lesson, the
//     lesson itself (Start lesson / Ask about this lesson / Save for later) and the "About: lesson" chip
//     that makes follow-up questions carry the lesson reference.
//     Messages (announcements, notes, replies) aren't in the inbox: they arrive in the chat itself, with a
//     Reply button that makes the next message a reply to that one (it goes to whoever sent it).
//   * Faculty view: the professor's chat — post, watch delivery state, see students' replies and the
//     course assistant's answers, and reply to one student.
// Everything here comes from the UI server's APIs and real events. A toast or a delivery never marks a
// lesson opened: only opening it does. Lesson text is content — always set with textContent.
//
// HR (staff only): when the professor asks for time off, HR's card comes back in the Professor state
// (`hrCard`: formRef, the A2UI messages HR sent, and a summary HR worked out by code). The card is drawn
// here as HR's chat bubble: a summary slip readable in 3 seconds (what, when, what is left), the fields
// from HR's A2UI surface (official renderer, editable in place; the two pickers styled as dropdowns),
// notes behind ⓘ icons, Submit request / Cancel.
// Buttons post the renderer's action to /api/professor/hr/actions → Hub → Professor agent → Hub → HR.
import { MessageProcessor, basicCatalog } from './vendor/a2ui.js';
import { createQuizUi, dueDay } from './quiz-ui.js';
import { createRosterUi } from './roster-ui.js';
import { renderRichText } from './rich-text.js';
import { A2UI_VERSION, reasonPicker, validateFinal } from '/shared/forms.js';
import { CREDIT_LABEL, CREDIT_OF_TYPE, NOTE_PRIVACY, PROOF, STANDARD_DAY, daysText, defaultReason, isPair, nameOf as absenceName, shortDate, spreadOf, titleOf, whenText, workdays } from '/shared/absence-types.js';
const $ = (id) => document.getElementById(id);
const el = (tag, { dataset = {}, ...props } = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset); // dataset itself is read-only; its entries aren't
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const isMessage = (x) => x?.kind === 'message';
const untitled = (x) => x?.title || (isMessage(x) ? 'Untitled message' : 'Untitled lesson');
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: draft lives only in the page */ } },
};
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export function createClassroom({ sendChat, showConversation, focusComposer, followLog, onInboxChange = () => {} }) {
  const els = {
    toggle: $('inbox-toggle'), unread: $('inbox-unread'), inbox: $('inbox'), list: $('lesson-list'),
    notice: $('course-notice'), noticeTitle: $('course-notice-title'), noticeText: $('course-notice-text'), noticeOk: $('course-notice-ok'), noticeAsk: $('course-notice-ask'),
    chip: $('about-chip'), chipPrefix: $('about-prefix'), chipTitle: $('about-title'), chipClear: $('about-clear'),
    dialog: $('lesson-dialog'), dCourse: $('lesson-dialog-course'), dTitle: $('lesson-dialog-title'), dText: $('lesson-dialog-text'),
    start: $('lesson-start'), ask: $('lesson-ask'), save: $('lesson-save'), close: $('lesson-close'),
    toasts: $('toasts'), tab: $('tab-conversation'),
  };
  let inbox = { lessons: [], notices: [], unread: 0 };
  let about = null; // { deliveryId, title, reply? } (a lesson or a message) or { capability, title } (a course) — follow-ups carry it
  let showing = null; // the lesson open in the dialog

  // ---- inbox -------------------------------------------------------------------------------------------
  async function refreshInbox() {
    const r = await api('/api/inbox').catch(() => null);
    if (!r?.ok) return;
    inbox = r.json;
    renderInbox();
    onInboxChange();
  }
  const stateOf = (l) => (l.openedAt ? 'opened' : 'new');
  function renderInbox() {
    // Messages are shown in the chat; the inbox lists lessons only. The tab's dot counts both.
    const lessons = inbox.lessons.filter((l) => !isMessage(l));
    const unreadLessons = inbox.unreadLessons ?? lessons.filter((l) => !l.openedAt).length;
    const has = lessons.length > 0;
    els.toggle.hidden = !has;
    els.unread.hidden = unreadLessons === 0;
    els.unread.textContent = String(unreadLessons);
    els.unread.setAttribute('aria-label', `${unreadLessons} unread`);
    els.tab.dataset.unread = String(inbox.unread);
    const notice = inbox.notices.find((n) => !n.seenAt);
    els.notice.hidden = !notice;
    if (notice) {
      els.noticeTitle.textContent = `${notice.courseTitle} is now available.`;
      els.noticeText.textContent = `Ask its faculty member anything about the course here; new lessons from ${notice.professorName ?? 'the faculty member'} will appear in this inbox.`;
      els.notice.dataset.id = notice.noticeId;
      els.notice.dataset.course = notice.courseTitle;
    }
    els.inbox.hidden = !(notice || (has && els.toggle.getAttribute('aria-expanded') === 'true'));
    els.list.replaceChildren(...lessons.map((l) => el('li', { className: 'lesson-item', dataset: { state: stateOf(l), saved: String(Boolean(l.savedAt)), kind: l.kind ?? 'lesson' } },
      el('span', { className: 'lesson-flag', textContent: l.openedAt ? 'Opened' : 'New' }),
      el('span', { className: 'lesson-name' }, el('span', { className: 'kind-tag', textContent: isMessage(l) ? 'Message' : 'Lesson' }), ` ${untitled(l)}`),
      el('span', { className: 'lesson-meta', textContent: `${l.courseTitle}${l.toAll ? ' · to the whole class' : ''} · ${when(l.receivedAt)}${l.savedAt ? ' · saved for later' : ''}` }),
      el('button', { type: 'button', className: 'inline-action', textContent: isMessage(l) ? 'View message' : 'View lesson', onclick: () => openLesson(l.deliveryId) }))));
  }
  els.toggle.addEventListener('click', () => {
    const open = els.toggle.getAttribute('aria-expanded') !== 'true';
    els.toggle.setAttribute('aria-expanded', String(open));
    renderInbox();
  });
  const noticeSeen = async () => {
    await api(`/api/notices/${encodeURIComponent(els.notice.dataset.id)}/seen`, { method: 'POST' }).catch(() => null);
    refreshInbox();
  };
  els.noticeOk.addEventListener('click', noticeSeen);
  // "Ask a question": the next message asks for the course's public capability; the Hub still routes it.
  els.noticeAsk.addEventListener('click', () => {
    setAbout({ capability: 'marketing', title: els.notice.dataset.course });
    noticeSeen();
    focusComposer();
  });

  // ---- one lesson (opening it is the student's action: that, and only that, sends "opened") --------------
  async function openLesson(deliveryId) {
    dismissToasts(deliveryId);
    const r = await api(`/api/inbox/${encodeURIComponent(deliveryId)}/open`, { method: 'POST' });
    if (!r.ok) return;
    showing = r.json;
    els.dCourse.textContent = `${isMessage(showing) ? 'Message' : 'Lesson'} · ${showing.courseTitle} · from ${showing.professorName ?? 'the faculty member'}${showing.toAll ? ' to the whole class' : ''} · ${when(showing.postedAt)}`;
    els.dTitle.textContent = untitled(showing);
    // A message has nothing to "start"; both can be asked about and saved.
    els.start.hidden = isMessage(showing);
    els.ask.textContent = isMessage(showing) ? 'Ask about this message' : 'Ask about this lesson';
    renderRichText(els.dText, showing.text); // the course pack's paragraphs and lists, as written
    els.save.disabled = Boolean(showing.savedAt);
    els.save.textContent = showing.savedAt ? 'Saved' : 'Save for later';
    showConversation();
    if (!els.dialog.open) els.dialog.showModal();
    refreshInbox();
  }
  function setAbout(target) {
    about = !target ? null : target.capability ? { capability: target.capability, title: target.title }
      : { deliveryId: target.deliveryId, title: target.reply ? target.from : untitled(target), reply: Boolean(target.reply) };
    els.chip.hidden = !about;
    els.chipPrefix.textContent = about?.reply ? 'Replying to' : 'About';
    els.chipTitle.textContent = about?.title ?? '';
  }
  // The Reply button on a message in the chat: the next message goes back to whoever sent that message
  // (the Hub routes it by its own delivery record), then the chip goes away — one reply, like a chat.
  function replyTo(m) {
    setAbout({ deliveryId: m.deliveryId, reply: true, from: m.from });
    focusComposer();
  }
  // A message counts as opened once it has actually been on the student's screen (the chat visible,
  // the page in front) — only then does the signed "opened" receipt go to the Hub and the professor.
  const seen = new Set();
  const watcher = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || document.visibilityState !== 'visible') continue;
      const id = e.target.dataset.delivery;
      watcher.unobserve(e.target);
      if (seen.has(id)) continue;
      seen.add(id);
      // Only a message still in the inbox and not yet opened: a page can briefly show a message the Student
      // agent no longer has (e.g. history from before a New conversation), and its "open" would be a 404.
      refreshInbox()
        .then(() => {
          const l = inbox.lessons.find((x) => x.deliveryId === id);
          if (!l || l.openedAt) return null;
          return api(`/api/inbox/${encodeURIComponent(id)}/open`, { method: 'POST' }).then(() => refreshInbox());
        })
        .catch(() => seen.delete(id));
    }
  }, { threshold: 0.6 }) : null;
  function messageShown(item) {
    const l = inbox.lessons.find((x) => x.deliveryId === item.dataset.delivery);
    if (l?.openedAt) return;
    watcher?.observe(item);
  }
  // Coming back to the page: messages still on screen count as seen now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !watcher) return;
    for (const item of document.querySelectorAll('#student-log li[data-delivery]')) if (!seen.has(item.dataset.delivery)) { watcher.unobserve(item); watcher.observe(item); }
  });
  els.chipClear.addEventListener('click', () => setAbout(null));
  els.start.addEventListener('click', () => {
    const lesson = showing;
    els.dialog.close();
    setAbout(lesson);
    sendChat(`I’m starting the lesson “${untitled(lesson)}”.`, { lessonDeliveryId: lesson.deliveryId });
  });
  els.ask.addEventListener('click', () => {
    setAbout(showing);
    els.dialog.close();
    focusComposer();
  });
  els.save.addEventListener('click', async () => {
    await api(`/api/inbox/${encodeURIComponent(showing.deliveryId)}/save`, { method: 'POST' });
    els.dialog.close();
    refreshInbox();
  });
  els.close.addEventListener('click', () => els.dialog.close());

  // ---- toast: announces a delivery; never opens it, never takes focus -------------------------------------
  // The stack sits just under the header and the tab bar, wherever they wrap to, so it never covers the status pills.
  function placeToasts() {
    const tabs = document.querySelector('.tabs');
    const bottom = tabs ? tabs.getBoundingClientRect().bottom : 0;
    els.toasts.style.top = `${Math.max(0, Math.ceil(bottom)) + 8}px`;
  }
  window.addEventListener('resize', placeToasts);
  window.addEventListener('scroll', placeToasts, { passive: true });
  function toast(data) {
    placeToasts();
    const item = el('div', { className: 'toast', dataset: { delivery: data.deliveryId, ...(data.quiz ? { kind: 'quiz' } : {}) } },
      el('p', { className: 'toast-title', textContent: data.quiz ? `New quiz in ${data.courseTitle ?? 'Marketing 351'}` : isMessage(data) ? `New message from ${data.professorName ?? 'your faculty member'}` : `New ${data.courseTitle ?? 'course'} lesson` }),
      el('p', { className: 'toast-text', textContent: data.quiz ? `${data.quiz.title} — due ${dueDay(data.quiz.dueAt)}` : untitled(data) }),
      el('div', { className: 'toast-actions' },
        data.quiz ? null : el('button', { type: 'button', textContent: isMessage(data) ? 'View message' : 'View lesson', onclick: () => openLesson(data.deliveryId) }),
        el('button', { type: 'button', className: 'quiet', textContent: 'Dismiss', onclick: () => item.remove() })));
    els.toasts.append(item);
    // Leaves on its own after a while unless the pointer or keyboard is on it.
    const timer = setInterval(() => { if (!item.matches(':hover, :focus-within')) { item.remove(); clearInterval(timer); } }, 15000);
  }
  function dismissToasts(deliveryId) {
    for (const t of els.toasts.querySelectorAll('.toast')) if (t.dataset.delivery === deliveryId) t.remove();
  }

  // ---- Faculty view: a chat ---------------------------------------------------------------------------
  // The professor writes naturally; the Professor agent's model decides whether that is a post (a lesson
  // or a message, for the whole class or a tagged student), a question about the class, or needs one
  // question back — and code checks it before anything is sent. Each post appears in the chat with exactly
  // what was sent, to whom, and each student's delivery state (from the Hub).
  const pv = {
    view: $('view-professor'), log: $('prof-log'), form: $('prof-form'), input: $('prof-message'), send: $('prof-send'), error: $('prof-error'),
    roster: $('prof-roster'), course: $('author-course'), mentions: $('mention-list'),
    replyChip: $('prof-reply-chip'), replyName: $('prof-reply-name'), replyClear: $('prof-reply-clear'),
    waiting: $('prof-waiting'),
  };
  const follow = followLog(pv.log);
  const DRAFT_KEY = 'a2a-spike:professor-draft';
  let roster = [];
  // Classmates' names (studentId → "First Last") come only from the Faculty view's own roster fetch, while the Faculty tab
  // shows, and leave the page when another tab shows (like the quiz key) — never from the state the stream pushes to every
  // page (final review finding 6). Unknown: a neutral “A student”, never the raw id.
  const names = new Map();
  let namesAsked = 0;
  let namesLoading = false;
  const namesTried = new Set(); // ids already asked about: a new unknown id is fetched at once, an id still unknown at most every 15 s
  let namesToken = 0;
  const knownName = (id) => names.get(id) ?? roster.find((r) => r.studentId === id)?.name ?? null;
  let posts = new Map(); // key → post with deliveries
  let chat = [];
  let pending = null; // { text, operationId } while a message is being worked on
  let lastRendered = '';
  let replyingTo = null; // a student id: the professor's next message goes to that student only
  let answering = null; // the chat id of the student's message that Reply was pressed on (a hand-over)
  function setReplyingTo(studentId, entryId = null) {
    replyingTo = studentId;
    answering = studentId ? entryId : null;
    pv.replyChip.hidden = !studentId;
    pv.replyName.textContent = studentId ? nameOf(studentId) : '';
    if (studentId) pv.input.focus();
  }
  pv.replyClear.addEventListener('click', () => setReplyingTo(null));
  const replyButton = (studentId, entryId = null) => el('button', { type: 'button', className: 'reply-action', textContent: '↩ Reply', title: `Reply to ${nameOf(studentId)} only`, ariaLabel: `Reply to ${nameOf(studentId)}`, onclick: () => setReplyingTo(studentId, entryId) });
  let attempt = store.get(`${DRAFT_KEY}:attempt`); // a retry of the same text reuses its operation id
  pv.input.value = store.get(DRAFT_KEY) ?? '';
  const firstName = (st) => (st.name ?? st.studentId).split(' ')[0];
  const ASSISTANT = { studentId: 'assistant', name: 'assistant', label: 'Course assistant — writes, sends course lessons, answers questions' };

  const DELIVERY = {
    queued: ['Not delivered yet', 'busy'], delivered: ['Delivered', 'ok'], opened: ['Opened', 'ok'],
    uncertain: ['Checking whether it arrived', 'warn'], failed: ['Could not be delivered', 'bad'], sending: ['Sending…', 'busy'],
  };
  function studentState(d) {
    if (d.opened) return ['opened', when(d.openedAt)];
    if (d.state === 'queued') return ['queued', d.lastError === 'student_offline' || /refused/.test(d.lastError ?? '') ? `${knownName(d.studentId)?.split(' ')[0] ?? 'this student'} isn't online. It will arrive when they are.` : 'It will be retried.'];
    if (d.state === 'delivered') return ['delivered', when(d.deliveredAt)];
    return [d.state, null]; // the raw error code is for the technical views, not the faculty member
  }
  const nameOf = (id) => String(id).split(',').map((x) => knownName(x) ?? 'A student').join(', ');

  function bubble({ dir, speaker, label, at, text }) {
    return el('li', { className: 'msg', dataset: { dir, speaker } },
      el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: label }), el('time', { dateTime: at ?? '', textContent: at ? new Date(at).toLocaleTimeString([], { hour12: false }) : '' })),
      renderRichText(el('div', { className: 'msg-text' }), text, { split: dir !== 'sent' && speaker !== 'student' })); // a person's own words are never split
  }
  // What was sent, to whom, whose words, and each student's state.
  function postCard(p) {
    const isMsg = p.kind === 'message';
    const origin = p.seedId ? 'Course lesson, as written in the course pack' : p.source !== 'chat' ? 'Sent from the course API' : p.verbatim ? 'Your words' : 'Written by your assistant from your instruction';
    return el('li', { className: 'msg post-card', dataset: { dir: 'received', speaker: 'professor', kind: p.kind } },
      el('div', { className: 'msg-head' },
        el('span', { className: 'msg-dir' }, el('span', { className: 'kind-tag', textContent: isMsg ? 'Message' : 'Lesson' }), ` ${p.title || (isMsg ? 'Message' : 'Lesson')}`),
        el('time', { textContent: `to ${p.audience === 'all' ? `the whole class (${p.deliveries.length || '…'})` : p.audience.split(',').map(nameOf).join(', ')}` })),
      renderRichText(el('div', { className: 'msg-text post-text' }), p.text, { split: p.verbatim === false }),
      el('p', { className: 'post-origin', dataset: { verbatim: String(p.verbatim !== false) }, textContent: origin }),
      p.meetingState ? el('ul', { className: 'per-student meeting-state' }, ...p.meetingState.map((x) => el('li', { dataset: { tone: x.bookedBy ? 'ok' : 'busy' } }, el('span', { className: 'who', textContent: x.label }), el('span', { className: 'what', textContent: x.bookedBy ? `Booked by ${nameOf(x.bookedBy)}` : 'Open' })))) : null,
      deliveryLines(p));
  }
  // The professor's own message, sent straight to students: who it went to and each student's state.
  function sentPost(m, p) {
    const li = bubble({ dir: 'sent', speaker: 'student', label: `You → ${p.audience === 'all' ? `the whole class (${p.deliveries.length || '…'})` : nameOf(p.audience)}`, at: m.at, text: m.text });
    li.classList.add('sent-post');
    li.dataset.kind = p.kind;
    li.append(
      el('p', { className: 'post-origin' }, el('span', { className: 'kind-tag', textContent: p.kind === 'message' ? 'Message' : 'Lesson' }), ` ${p.title}`),
      deliveryLines(p));
    return li;
  }
  // Plain words for why the Hub refused a post; anything unknown is a retry, never a code.
  const notSentText = (reason) => (/student|audience|recipient|enrol/i.test(reason ?? '') ? 'Not sent — those students aren’t in this class.' : 'Not sent — please try again.');
  function deliveryLines(p) {
    if (p.hubStatus === 'rejected') return el('p', { className: 'post-origin', dataset: { verbatim: 'false' }, textContent: notSentText(p.hubReason) });
    if (!p.deliveries.length) return el('p', { className: 'post-origin', textContent: p.hubAccepted ? 'Sending…' : 'Not confirmed yet — it will be retried.' });
    return deliveryList(p.deliveries, p.key);
  }
  // One row per student; for a big audience (more than 3) a one-line summary and the rows folded away. "Opened" counts as
  // delivered. `notified` words a delivered row "Notified" (the quiz notice). The fold stays open across redraws.
  const BIG_AUDIENCE = 3;
  const foldOpen = new Set();
  const personName = (d) => knownName(d.studentId) ?? 'A student';
  function deliveryRows(list, notified = false) {
    return el('ul', { className: 'per-student' }, ...list.map((d) => {
      const [k, detail] = studentState(d);
      const [label, tone] = notified && k === 'delivered' ? ['Notified', 'ok'] : (DELIVERY[k] ?? [k, 'warn']);
      return el('li', { dataset: { tone } }, el('span', { className: 'who', textContent: personName(d) }), el('span', { className: 'what', textContent: `${label}${detail ? ` — ${detail}` : ''}` }));
    }));
  }
  function deliveryList(list, key, notified = false) {
    if (list.length <= BIG_AUDIENCE) return deliveryRows(list, notified);
    const kinds = list.map((d) => studentState(d)[0]);
    const delivered = kinds.filter((k) => k === 'delivered' || k === 'opened').length;
    const waiting = kinds.filter((k) => k === 'queued').length;
    const failed = kinds.filter((k) => k === 'failed').length;
    const other = list.length - delivered - waiting - failed;
    const details = el('details', { className: 'dlist', dataset: { count: String(list.length) } },
      el('summary', { textContent: `Show all ${list.length} students` }), deliveryRows(list, notified));
    details.open = foldOpen.has(key);
    details.addEventListener('toggle', () => { if (details.open) foldOpen.add(key); else foldOpen.delete(key); });
    return el('div', { className: 'dlist-wrap' },
      el('div', { className: 'dsum' },
        el('span', { className: 'pill ok', textContent: `Delivered to ${delivered}` }),
        ...(waiting ? [el('span', { className: 'pill', textContent: `${waiting} not online yet — they'll get it when they are` })] : []),
        ...(failed ? [el('span', { className: 'pill', dataset: { tone: 'bad' }, textContent: `${failed} could not be delivered` })] : []),
        ...(other ? [el('span', { className: 'pill', textContent: `${other} still sending or not confirmed` })] : [])),
      details);
  }
  // A student's reply to a post: who wrote it, to what, and a Reply button (to that student only).
  function studentReply(m) {
    const re = m.about ? ` · re: “${m.about.title || (m.about.kind === 'message' ? 'your message' : 'your lesson')}”` : '';
    const li = bubble({ dir: 'received', speaker: 'student', label: `${nameOf(m.studentId)}${m.relayed ? ' → you' : ' → course assistant'}${re}`, at: m.at, text: m.text });
    li.classList.add('student-reply');
    li.append(replyButton(m.studentId));
    return li;
  }
  // A hand-over (a question the assistant passed to the professor): ONE card — the student's message, one
  // Reply, and a strip with its state (waiting → answered) and what the assistant told the student.
  function handover(m, r) {
    const li = bubble({ dir: 'received', speaker: 'student', label: `${nameOf(m.studentId)} → you`, at: m.at, text: m.text });
    li.classList.add('student-reply', 'handover');
    li.dataset.state = r.answeredAt ? 'answered' : 'waiting';
    li.append(replyButton(m.studentId, m.id), el('p', { className: 'handover-status' },
      el('strong', { textContent: r.answeredAt ? `✓ Answered at ${clock(r.answeredAt)}` : 'Waiting for your answer' }),
      el('span', { className: 'told' }, 'Assistant told them ', el('q', { textContent: r.text }))));
    return li;
  }
  // The assistant answering a student for the professor — shown so the professor sees every exchange.
  function assistantAnswer(m) {
    const li = bubble({ dir: m.failed ? 'error' : 'info', speaker: 'professor', label: `Course assistant → ${nameOf(m.to)}${m.onBehalf ? ' (for you)' : ''}`, at: m.at, text: m.text });
    if (m.needsProfessor) li.append(el('p', { className: 'needs-you', textContent: 'Needs your answer — the assistant didn’t decide this.' }), replyButton(m.to));
    return li;
  }
  // ---- Part 16: the Canvas quiz (topic chips, the draft card, the Canvas cards) — see quiz-ui.js ----------
  let rosterCount = null; // professorState.professor.roster.count: how many students CHRS says are enrolled (null until the Hub has asked)
  let quizAsking = false; // professorState.professor.quizAsking: the assistant is still waiting for a topic
  let quizCard = null; // professorState.professor.quizCard: draft id, state, Canvas quiz number, counts (never questions or answers)
  const quiz = createQuizUi({
    el, api, bubble, nameOf: (id) => nameOf(id), posts: () => [...posts.values()], studentCount: () => rosterCount, deliveryList,
    isShowing: () => !pv.view.hidden,
    sendTopic: (n, text) => sendTopicPick(n, text), // a chip tap is a structured pick: never typed text, never a reply to one student
    redraw: () => { lastRendered = ''; renderProfessor(); },
    pin: () => follow.pin(),
  });
  const rosterUi = createRosterUi({ el, api, bubble, isShowing: () => !pv.view.hidden });
  // ---- HR (staff only): the open time-off card ------------------------------------------------------
  // One card at a time (HR re-issues it with a new formRef after a follow-up message). The rendered card
  // is kept across re-renders (same element, same renderer) so what the professor typed is never lost.
  // Approved design (docs/superpowers/specs/2026-11-03-hr-card-redesign.html), readable in 3 seconds:
  //   lead line → the summary slip (what, when, what is left) → “Picked from what you wrote” → HR's A2UI
  //   surface (two dropdowns, dates and hours, note with an ⓘ) → Submit request / Cancel.
  // The slip is recomputed here from the surface's data model with the shared module, so it follows what
  // the professor changes on the card; HR checks everything again on Submit (the server is the authority).
  const HR_LABEL = 'HR · Time off';
  const SUMMARY_PATHS = ['/absenceType', '/absenceReason', '/beginDate', '/endDate', '/hours'];
  let hrCard = null; // professorState.professor.hrCard
  let hr = null; // { formRef, surfaceId, li, processor, surface, slip, because, applied, busy, attempt, notice, lead, subs, type, orig, card }
  let tipCount = 0;
  const first = (v) => [].concat(v ?? [])[0] ?? '';
  const hoursText = (h) => `${Number(h.toFixed(2))} ${h === 1 ? 'hour' : 'hours'}`;
  function hrDispose() {
    if (!hr) return;
    for (const sub of hr.subs ?? []) sub.unsubscribe();
    if (hr.processor) hr.processor.processMessages([{ version: A2UI_VERSION, deleteSurface: { surfaceId: hr.surfaceId } }]);
    hr = null;
  }
  function hrNotice(kind, lines) {
    hr.notice.dataset.kind = kind;
    hr.notice.replaceChildren(...[...new Set([].concat(lines).filter(Boolean))].map((t) => el('p', { textContent: t }))); // HR's reason often repeats its field error
  }
  // ⓘ: a note behind an icon — shown on hover, keyboard focus and tap (click toggles aria-expanded).
  // Esc hides it while the icon keeps focus (WCAG 1.4.13); it shows again on the next focus or tap.
  function infoTip(text, label = 'More information') {
    const id = `hr-tip-${++tipCount}`;
    const button = el('button', { type: 'button', textContent: 'i', ariaLabel: label, ariaExpanded: 'false' });
    button.setAttribute('aria-describedby', id);
    const wrap = el('span', { className: 'hr-info' }, button, el('span', { id, role: 'tooltip', textContent: text }));
    button.addEventListener('click', () => { wrap.classList.remove('tip-hidden'); button.setAttribute('aria-expanded', String(button.getAttribute('aria-expanded') !== 'true')); });
    button.addEventListener('blur', () => { wrap.classList.remove('tip-hidden'); button.setAttribute('aria-expanded', 'false'); });
    button.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); wrap.classList.add('tip-hidden'); button.setAttribute('aria-expanded', 'false'); } });
    return wrap;
  }
  // “Thu, Nov 5 to Fri, Nov 6, 2 days” → the day(s) in bold, the rest plain (textContent only).
  const DAY_RE = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2}(?: (?:from|until) \d{1,2}:\d{2})?(?: to (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2})?|the next \d+ days/g;
  function boldDays(text) {
    const out = [];
    let at = 0;
    for (const m of text.matchAll(DAY_RE)) {
      if (m.index > at) out.push(text.slice(at, m.index));
      out.push(el('b', { textContent: m[0] }));
      at = m.index + m[0].length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }
  // The card's current values, as the professor sees them.
  function hrNow() {
    const dm = hr.surface.dataModel;
    const hoursRaw = String(dm.get('/hours') ?? '').trim();
    return { type: first(dm.get('/absenceType')), reason: first(dm.get('/absenceReason')), beginDate: String(dm.get('/beginDate') ?? '').slice(0, 10), endDate: String(dm.get('/endDate') ?? '').slice(0, 10), hours: hoursRaw === '' ? NaN : Number(hoursRaw), hoursRaw };
  }
  // The “when” line and the hours this request uses (null when they can't be worked out yet).
  function whenOf(v, card) {
    if (!v.beginDate || !v.endDate) return { text: 'Dates still needed', missing: true, used: null };
    const days = workdays(v.beginDate, v.endDate);
    const range = v.beginDate === v.endDate ? shortDate(v.beginDate) : `${shortDate(v.beginDate)} to ${shortDate(v.endDate)}`;
    if (!days.length) return { text: `${range}, no working days`, missing: true, used: null };
    if (!Number.isFinite(v.hours) || v.hours <= 0) return { text: `${range}, hours still needed`, missing: true, used: null };
    // A time read from the words (and the words' spread choice) holds only while the dates and hours are
    // still the ones HR filled in.
    const same = v.beginDate === hr.orig.beginDate && v.endDate === hr.orig.endDate && v.hoursRaw === hr.orig.hoursRaw;
    const spread = same && card.spread?.mode ? card.spread : spreadOf(days.length, v.hours, null);
    if (spread.mode === 'ask') return { text: `${range}, ${hoursText(v.hours)} — HR will ask how to spread them`, missing: false, used: v.hours };
    if (spread.mode === 'invalid') {
      const tooMany = v.hours > STANDARD_DAY * days.length;
      return { text: `${range}, ${hoursText(v.hours)} ${tooMany ? 'is more than these days allow' : '— these hours don’t fit the dates'}`, missing: true, used: null };
    }
    const text = whenText({ beginDate: v.beginDate, endDate: v.endDate, hours: v.hours, spread, startAt: same ? card.startAt ?? null : null, side: same ? card.side ?? null : null });
    return { text, missing: false, used: v.hours };
  }
  // HR's lead asks for the kind of leave when it had none. Once the professor picks a name on the card, the
  // lead follows the approved rules (page chrome; HR's own text comes back if the name is cleared).
  const NO_NAME_LEAD = /^What kind of time off is this\?/;
  const SORRY = (type, reason) => type === 'BRV' || (type === 'OTH' && (reason === '30' || reason === '40')) || (type === 'SCK' && reason === 'BRV');
  const leadFor = (type, reason) => (SORRY(type, reason) ? "I'm sorry for your loss. Check it and submit." : type === 'SCK' && reason === 'SCK' && !hr?.card?.appointment ? 'Feel better soon. Check it and submit.' : 'Check it and submit.');
  // No name yet and HR offered choices: the question, then the choices as pills, then HR's “If none of these fit …”.
  function drawLead(v) {
    const named = Boolean(v.type && absenceName(v.type));
    const asking = NO_NAME_LEAD.test(hr.leadText) && !named;
    const offer = asking && hr.choices.childElementCount > 0;
    const text = NO_NAME_LEAD.test(hr.leadText) && named ? leadFor(v.type, v.reason) : offer ? hr.leadText.match(NO_NAME_LEAD)[0] : hr.leadText;
    if (hr.lead.textContent !== text) hr.lead.textContent = text;
    const hint = offer ? hr.leadText.replace(NO_NAME_LEAD, '').trim() : '';
    if (hr.hint.textContent !== hint) hr.hint.textContent = hint;
    hr.choices.hidden = !offer;
    hr.hint.hidden = !offer || !hint;
  }
  // The 3-second summary: what, when, and what is left after this request.
  function drawSlip() {
    const card = hr.card;
    const v = hrNow();
    const named = Boolean(v.type && absenceName(v.type));
    const { title, subtitle } = named ? titleOf(v.type, v.reason) : { title: null, subtitle: null };
    const whatRow = el('div', { className: 'hr-what-row' }, el('p', { className: `hr-what${named ? '' : ' empty'}`, textContent: title ?? 'Choose the kind of leave' }), named && PROOF[v.type] ? infoTip(PROOF[v.type]) : null);
    const when = whenOf(v, card);
    const whenEl = el('p', { className: 'hr-when', dataset: { missing: String(when.missing) } }, ...boldDays(when.text));
    const impact = el('div', { className: 'hr-impact' });
    const creditKey = named ? CREDIT_OF_TYPE[v.type] : null;
    const now = creditKey ? Number(card.balances?.[creditKey]) : NaN;
    if (!named) impact.append(el('p', { className: 'hr-free', textContent: 'Your balance shows here once you choose the kind of leave.' }));
    else if (!creditKey) impact.append(el('p', { className: 'hr-free', textContent: `${title} doesn't use your vacation or sick leave.` }));
    else if (!Number.isFinite(now)) impact.append(el('p', { className: 'hr-free', textContent: `HR will check your ${CREDIT_LABEL[creditKey]} balance.` }));
    else if (when.used == null) impact.append(el('p', { className: 'hr-free', textContent: `You have ${daysText(now)} of ${CREDIT_LABEL[creditKey]} now.` }));
    else if (when.used > now) impact.append(el('p', { className: 'hr-free hr-short', textContent: `Not enough ${CREDIT_LABEL[creditKey]}: this request needs ${daysText(when.used)}, you have ${daysText(now)}.` }));
    else {
      const after = now - when.used;
      const [n, ...rest] = daysText(after).split(' ');
      const pct = (x) => `${now > 0 ? Math.max(0, Math.min(100, (x / now) * 100)) : 0}%`;
      impact.append(
        el('p', { className: 'hr-left' }, el('span', { className: 'hr-left-n', textContent: n }), ' ', el('span', { className: 'hr-left-t', textContent: `${rest.join(' ')} of ${CREDIT_LABEL[creditKey]} left after this` })),
        el('div', { className: 'hr-bar', ariaHidden: 'true' }, el('div', { className: 'hr-keep', style: `width: ${pct(after)}` }), el('div', { className: 'hr-use', style: `width: ${pct(when.used)}` })),
        el('div', { className: 'hr-bar-labels' }, el('span', { textContent: `You have ${daysText(now)} now` }), el('span', { textContent: `this request: ${daysText(when.used)}` })));
    }
    drawLead(v);
    hr.slip.replaceChildren(el('div', {}, whatRow, subtitle ? el('p', { className: 'hr-why', textContent: subtitle }) : null), whenEl, impact);
    // HR's own findings hold while the card still says what HR read: the name the words chose, and the
    // problem HR found with exactly these values.
    hr.because.hidden = !(card.why && v.type === hr.orig.type);
    const unchanged = v.type === hr.orig.type && v.reason === hr.orig.reason && v.beginDate === hr.orig.beginDate && v.endDate === hr.orig.endDate && v.hoursRaw === hr.orig.hoursRaw;
    hr.problem.hidden = !(card.problem && unchanged);
  }
  // The two pickers are the renderer's filterable chips ChoicePicker, styled as closed dropdowns: closed
  // shows the picked chip (or our own placeholder button), a click opens the filter box and the list,
  // picking / Esc / a click outside closes it.
  const pickerId = (p) => p.context?.componentModel?.id ?? (p.querySelector('label')?.textContent?.trim() === 'Reason' ? 'absenceReason' : 'absenceType');
  function closePicker(p) {
    if (!p.classList.contains('open')) return;
    p.classList.remove('open');
    if ('filter' in p) p.filter = ''; // the renderer's own filter state: the whole list next time
  }
  function openPicker(p) {
    if (p.classList.contains('disabled')) return;
    for (const other of hr.li.querySelectorAll('a2ui-choicepicker.open')) if (other !== p) closePicker(other);
    p.classList.add('open');
    p.querySelector('.a2ui-filter-input')?.focus();
  }
  // Page chrome for the pickers (placeholder button, missing/disabled state) and the note's ⓘ. The renderer
  // may redraw a field: this runs again after every change inside the surface and only adds what is gone.
  function decorateSurface() {
    if (!hr) return;
    const v = hrNow();
    for (const p of hr.li.querySelectorAll('a2ui-choicepicker')) {
      const reason = pickerId(p) === 'absenceReason';
      const value = reason ? v.reason : v.type;
      const label = reason ? 'Reason' : 'Absence name';
      const empty = reason ? (v.type ? 'Choose a reason…' : 'Reason (pick a name first)') : 'Choose…';
      let blank = p.querySelector(':scope > .dd-empty');
      if (!blank) {
        blank = el('button', { type: 'button', className: 'dd-empty' }, el('span', { className: 'sel-text' }));
        blank.addEventListener('click', () => openPicker(p));
        p.prepend(blank); // before the renderer's own nodes: never inside a part it redraws
      }
      if (blank.firstChild.textContent !== empty) blank.firstChild.textContent = empty;
      blank.setAttribute('aria-label', `${label}: ${empty}`);
      blank.hidden = Boolean(value);
      p.classList.toggle('dd-missing', !value && (!reason || Boolean(v.type)));
      p.classList.toggle('disabled', reason && !v.type);
      p.classList.toggle('no-match', !p.querySelector('.a2ui-chip'));
      const input = p.querySelector('.a2ui-filter-input');
      if (input && input.placeholder !== 'Type to search…') { input.placeholder = 'Type to search…'; input.setAttribute('aria-label', `Search ${label.toLowerCase()}`); }
    }
    const note = hr.li.querySelector('a2ui-basic-textfield:has(textarea)');
    // Prepended (outside the renderer's own nodes) and shown after the label by CSS; its name says what it is about,
    // so a screen reader meeting it first still knows which field it explains.
    if (note && !note.querySelector(':scope > .hr-info')) note.prepend(infoTip(NOTE_PRIVACY, 'Who can read the note'));
  }
  // A new absence name: the reason list becomes that name's reasons (an A2UI updateComponents through the
  // card's own renderer), with its default reason picked or none.
  function nameChanged() {
    if (!hr) return;
    const type = first(hr.surface.dataModel.get('/absenceType'));
    if (type === hr.type) return;
    hr.type = type;
    hr.processor.processMessages(structuredClone([{ version: A2UI_VERSION, updateComponents: { surfaceId: hr.surfaceId, components: [reasonPicker(type || null)] } }]));
    // Same rule as HR's merge: keep the reason if it belongs to the new name, else the name's default reason or none.
    const current = first(hr.surface.dataModel.get('/absenceReason'));
    const code = !type ? null : (current && isPair(type, current) ? current : defaultReason(type));
    hr.surface.dataModel.set('/absenceReason', code ? [code] : []);
  }
  // HR's chat entry for the open card → the card itself (built once per formRef, then updated in place).
  function hrCardItem(m, open) {
    if (hr?.formRef !== open.formRef) {
      hrDispose();
      const card = open.card ?? {};
      const surfaceId = open.a2ui.find((x) => x.createSurface)?.createSurface.surfaceId;
      const processor = new MessageProcessor([basicCatalog], (action) => hrAction(action));
      // The renderer adopts values by reference and mutates them: always hand it copies.
      processor.processMessages(structuredClone(open.a2ui));
      const surface = processor.model.getSurface(surfaceId);
      const surfaceEl = el('a2ui-surface', { className: 'form-surface hr-surface' });
      surfaceEl.surface = surface;
      const lead = el('p', { className: 'hr-lead', textContent: m.text });
      // HR's choices when it couldn't pick one name: a tap fills Absence name, like picking it in the dropdown.
      const choices = el('div', { className: 'hr-choices', role: 'group', ariaLabel: 'Kinds of leave HR suggests', hidden: true },
        ...[].concat(card.choices ?? []).filter((c) => absenceName(c?.type)).map((c) => {
          const pill = el('button', { type: 'button', className: 'hr-pill', textContent: absenceName(c.type) });
          pill.addEventListener('click', () => { if (hr?.li === li) hr.surface.dataModel.set('/absenceType', [c.type]); });
          return pill;
        }));
      const hint = el('p', { className: 'hr-hint', hidden: true });
      const notice = el('div', { className: 'notice', role: 'status' });
      const slip = el('section', { className: 'hr-slip', ariaLabel: 'Summary' });
      const because = el('p', { className: 'hr-because', textContent: card.why ?? '', hidden: true });
      const problem = el('p', { className: 'hr-problem', textContent: card.problem ?? '', hidden: true });
      const li = el('li', { className: 'msg hr-card', dataset: { dir: 'received', speaker: 'hr', formRef: open.formRef, missing: (card.missing ?? []).join(' ') } },
        el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: HR_LABEL }), el('time', { dateTime: m.at ?? '', textContent: m.at ? new Date(m.at).toLocaleTimeString([], { hour12: false }) : '' })),
        lead, choices, hint, problem, slip, because, surfaceEl, notice);
      hr = { formRef: open.formRef, surfaceId, li, processor, surface, slip, because, problem, applied: open.a2ui.length, busy: false, attempt: null, notice, lead, choices, hint, leadText: m.text, subs: [], card, type: null, orig: null };
      const v = hrNow();
      hr.type = v.type;
      hr.orig = v;
      drawSlip();
      const redraw = () => { if (hr?.li === li) { drawSlip(); decorateSurface(); } };
      for (const path of SUMMARY_PATHS) hr.subs.push(surface.dataModel.subscribe(path, () => queueMicrotask(redraw)));
      hr.subs.push(surface.dataModel.subscribe('/absenceType', () => queueMicrotask(nameChanged)));
      // Dropdown behaviour, delegated on the card (the renderer may replace a picker's insides).
      li.addEventListener('click', (e) => {
        const p = e.target.closest('a2ui-choicepicker');
        if (!p || !li.contains(p)) return;
        const chip = e.target.closest('.a2ui-chip');
        if (!chip) return;
        if (p.classList.contains('open')) { closePicker(p); queueMicrotask(() => p.querySelector('.a2ui-chip-selected, .dd-empty:not([hidden])')?.focus()); } // picked (the renderer has set the value)
        else openPicker(p);
      });
      li.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const p = e.target.closest?.('a2ui-choicepicker.open');
        if (!p) return;
        e.preventDefault();
        closePicker(p);
        (p.querySelector('.a2ui-chip-selected') ?? p.querySelector('.dd-empty'))?.focus();
      });
      const outside = (e) => { for (const p of li.querySelectorAll('a2ui-choicepicker.open')) if (!p.contains(e.target)) closePicker(p); };
      document.addEventListener('mousedown', outside);
      document.addEventListener('focusin', outside);
      hr.subs.push({ unsubscribe: () => { document.removeEventListener('mousedown', outside); document.removeEventListener('focusin', outside); } });
      const watcher = new MutationObserver(() => decorateSurface());
      watcher.observe(surfaceEl, { childList: true, subtree: true });
      hr.subs.push({ unsubscribe: () => watcher.disconnect() });
      queueMicrotask(decorateSurface);
    } else if (open.a2ui.length > hr.applied) {
      // HR refused a Submit: its A2UI updates (field errors) arrive appended to the card's messages.
      hr.processor.processMessages(structuredClone(open.a2ui.slice(hr.applied).filter((x) => !x.deleteSurface)));
      hr.applied = open.a2ui.length;
    }
    hr.leadText = m.text;
    drawLead(hrNow());
    return hr.li;
  }
  // A closed card: HR's question stays, answered with what was filed (or that nothing was), so the chat
  // never points at a dropdown that is gone.
  function hrRecord(m, closing) {
    const r = closing?.record;
    const question = NO_NAME_LEAD.test(m.text) ? m.text.match(NO_NAME_LEAD)[0] : m.text;
    const body = [];
    if (r && absenceName(r.absenceType)) {
      const { title, subtitle } = titleOf(r.absenceType, r.absenceReason);
      const range = r.beginDate === r.endDate ? shortDate(r.beginDate) : `${shortDate(r.beginDate)} to ${shortDate(r.endDate)}`;
      body.push(el('div', { className: 'hr-record' },
        el('p', { className: 'hr-record-label', textContent: 'You submitted' }),
        el('p', { className: 'hr-record-what', textContent: title }),
        subtitle ? el('p', { className: 'hr-record-why', textContent: subtitle }) : null,
        el('p', { className: 'hr-record-when', textContent: `${range} · ${Number(r.hours)} ${Number(r.hours) === 1 ? 'hour' : 'hours'}` })));
    } else {
      // A receipt saved before records existed: it was filed, HR's receipt says what.
      const filed = /^Your time off is recorded/.test(closing?.text ?? '');
      body.push(el('p', { className: 'hr-record-none', textContent: filed ? 'You submitted this card. HR’s receipt is below.' : closing ? 'You cancelled this card. Nothing was filed.' : 'This card closed before it was submitted. Nothing was filed.' }));
    }
    return el('li', { className: 'msg hr-closed', dataset: { dir: 'received', speaker: 'hr', formRef: m.formRef } },
      el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: HR_LABEL }), el('time', { dateTime: m.at ?? '', textContent: m.at ? new Date(m.at).toLocaleTimeString([], { hour12: false }) : '' })),
      el('p', { className: 'msg-text', textContent: question }), ...body);
  }
  // The open card's current values (what the professor sees and may have edited), or null.
  function hrValues() {
    if (!hr?.surface) return null;
    const dm = hr.surface.dataModel;
    const values = Object.fromEntries(['absenceType', 'absenceReason', 'beginDate', 'endDate', 'hours', 'note'].map((f) => [f, structuredClone(dm.get(`/${f}`) ?? '')]));
    return { formRef: hr.formRef, values };
  }
  // The renderer's button events (typing never reaches here). Submit is checked with the same rules HR
  // applies; invalid values are never sent. A retry of the same values reuses the operation id, so an
  // unknown outcome can be asked again without filing twice.
  async function hrAction(action) {
    const view = hr;
    if (!view || view.busy || action.surfaceId !== view.surfaceId) return;
    const final = action.name === 'submitTimeOff';
    if (final) {
      view.surface.dataModel.set('/ui/submitAttempted', true); // reveals the renderer's inline errors
      const check = validateFinal('staff-time-off', action.context);
      if (!check.ok) return hrNotice('bad', ['Please fix these before submitting. Nothing was sent.', ...Object.values(check.errors)]);
    } else if (action.name !== 'cancelForm') return;
    const { name, surfaceId, sourceComponentId, timestamp, context } = action;
    const key = JSON.stringify([view.formRef, name, context]);
    if (view.attempt?.key !== key) view.attempt = { key, operationId: `op-${crypto.randomUUID()}` };
    view.busy = true;
    view.surface.dataModel.set('/ui/submitLocked', true);
    hrNotice('info', final ? 'Sending your request to HR…' : 'Cancelling…');
    follow.pin(); // the professor's own action: keep the newest item in view
    const r = await api('/api/professor/hr/actions', { method: 'POST', body: { operationId: view.attempt.operationId, formRef: view.formRef, action: { name, surfaceId, sourceComponentId, timestamp, context } } }).catch(() => null);
    if (hr !== view) return; // the card closed or was replaced meanwhile (its outcome is in the chat)
    view.busy = false;
    view.surface.dataModel.set('/ui/submitLocked', false);
    const body = r?.json ?? {};
    if (!r) return hrNotice('bad', 'Couldn’t reach the server. Press the button again — it won’t file twice.');
    if (r.ok && ['accepted', 'cancelled'].includes(body.status)) return hrNotice('ok', final ? 'Sent.' : 'Cancelled.'); // the card closes with the next state
    if (r.ok && body.status === 'rejected') view.attempt = null; // HR answered: a new try is a new operation
    const errors = body.errors ? Object.values(body.errors) : [];
    hrNotice(body.status === 'outcome_unknown' || body.status === 'not_delivered' ? 'warn' : 'bad', [body.reply ?? body.error ?? (errors.length ? 'Not sent:' : `Not sent (HTTP ${r.status}).`), ...errors]);
  }

  function renderProfessor() {
    const items = [];
    let qz;
    quiz.begin();
    // Only the newest topic list can start a quiz: nothing from him after it, the Faculty agent still waiting for a topic
    // (a restart or the 15-minute limit ends that), no quiz card open, and nothing being sent right now.
    const lastList = chat.map((m, i) => (m.quizTopics?.topics ? i : -1)).filter((i) => i >= 0).pop();
    const openCard = Boolean(quizCard && !['closed', 'published'].includes(quizCard.state));
    const topicsLive = (i) => i === lastList && quizAsking && !openCard && !pending && !chat.slice(i + 1).some((x) => x.role === 'professor');
    const handedOver = new Map(chat.filter((m) => m.role === 'assistant' && m.needsProfessor).map((m) => [m.id, m]));
    for (const [mi, m] of chat.entries()) {
      const r = m.role === 'student' && handedOver.get(m.id.replace(/:s$/, ':r'));
      if (r) items.push(handover(m, r));
      else if (m.role === 'student') items.push(studentReply(m));
      else if (m.role === 'assistant' && m.needsProfessor && chat.some((s) => s.id === m.id.replace(/:r$/, ':s'))) continue; // shown on its card
      else if (m.role === 'assistant' && m.action === 'answer_student') items.push(assistantAnswer(m));
      else if (m.role === 'assistant' && m.action === 'roster' && m.roster?.rosterId) items.push(rosterUi.entry(m)); // Part 17: the CHRS class roster card
      else if (m.role === 'assistant' && m.quiz?.draftId && Array.isArray(qz = quiz.entry(m, quizCard, chat))) items.push(...qz); // Part 16: the quiz card, the Canvas cards
      else if (m.role === 'hr') {
        // HR (staff only): the open card where HR sent it; every other HR reply (a receipt, a question,
        // a refusal) as HR's own bubble.
        // The closed card already says it (once). Older saved entries lack the flag: hidden by their exact words, but
        // only while the card itself is still shown, so the screen never loses its only cancel line.
        if (m.closed && (m.cancelled || m.text === 'Cancelled. Nothing was recorded.') && chat.some((x) => x.role === 'hr' && x.formRef === m.formRef && !x.closed && !x.failed)) continue;
        if (m.formRef && hrCard?.formRef === m.formRef && !m.closed && !m.failed) items.push(hrCardItem(m, hrCard));
        else if (m.formRef && !m.closed && !m.failed) items.push(hrRecord(m, chat.find((x) => x.role === 'hr' && x.formRef === m.formRef && x.closed)));
        else {
          const li = bubble({ dir: m.failed ? 'error' : 'received', speaker: 'hr', label: HR_LABEL, at: m.at, text: m.text });
          if (m.closed && /^Your time off is recorded/.test(m.text)) li.classList.add('hr-receipt');
          items.push(li);
        }
      }
      else if (m.role === 'professor') {
        const p = m.postKey && posts.get(m.postKey);
        if (p) items.push(sentPost(m, p));
        else {
          items.push(bubble({ dir: 'sent', speaker: 'student', label: m.toAssistant ? 'You → course assistant' : m.replyTo ? `You → ${nameOf(m.replyTo)}` : 'You', at: m.at, text: m.text }));
          if (m.problem) items.push(bubble({ dir: 'error', speaker: 'professor', label: 'Not sent', at: m.at, text: m.problem }));
        }
      } else {
        const li = bubble({ dir: m.action === 'error' || m.action === 'clarify' ? 'info' : 'received', speaker: 'professor', label: 'Course assistant', at: m.at, text: m.text });
        if (m.quizTopics?.topics) { li.classList.add('has-topics'); li.append(quiz.topicsBlock(m.quizTopics, topicsLive(mi))); } // Part 16: the topic chips
        items.push(li);
        if (m.postKey && posts.get(m.postKey)) items.push(postCard(posts.get(m.postKey)));
      }
    }
    if (pending) {
      // The Professor saves his message (`<operationId>:p`) as soon as it starts; once the 3-second refresh brings
      // that entry, it is drawn above — the local copy would show the same message twice until the reply.
      if (!chat.some((m) => m.id === `${pending.operationId}:p`)) items.push(bubble({ dir: 'sent', speaker: 'student', label: pending.replyTo ? `You → ${nameOf(pending.replyTo)}` : 'You', at: new Date().toISOString(), text: pending.text }));
      items.push(el('li', { className: 'chat-pending' }, el('span', { className: 'spinner', ariaHidden: 'true' }), /@assistant\b/i.test(pending.text) ? 'The course assistant is working on it…' : 'Sending…'));
    }
    const waiting = [...handedOver.values()].filter((m) => !m.answeredAt).length;
    pv.waiting.hidden = !waiting;
    pv.waiting.textContent = String(waiting);
    pv.waiting.title = `${waiting} question${waiting === 1 ? '' : 's'} waiting for your answer`;
    if (hr && !items.includes(hr.li)) hrDispose(); // the card closed (submitted, cancelled, expired, reset)
    quiz.sync();
    rosterUi.sync(chat);
    const signature = JSON.stringify([pv.view.hidden, quizCard, quizAsking, chat.length, pending?.text, [...handedOver.values()].map((m) => m.answeredAt ?? null), [...posts.values()].map((p) => [p.key, p.hubStatus, p.deliveries]), hrCard?.formRef ?? null, hrCard?.a2ui.length ?? 0, chat.at(-1)?.text, rosterCount, names.size]);
    if (signature === lastRendered) return;
    lastRendered = signature;
    // The open HR card and the quiz cards stay where they are in the page (never detached), so a field being
    // edited keeps focus and a half-typed question survives.
    const keepSet = new Set([hr?.li, ...quiz.kept(), ...rosterUi.kept()].filter((x) => x && items.includes(x) && x.parentNode === pv.log));
    if (!keepSet.size) return pv.log.replaceChildren(...items);
    for (const c of [...pv.log.children]) if (!keepSet.has(c)) c.remove();
    let head = null; // last item placed before the first kept one
    let tail = null; // last item placed after a kept one
    for (const it of items) {
      if (keepSet.has(it)) { tail = it; continue; }
      if (tail) { tail.after(it); tail = it; } else if (head) { head.after(it); head = it; } else { pv.log.prepend(it); head = it; }
    }
  }
  // Part 10: the Faculty view's state arrives over its own AG-UI stream (STATE_SNAPSHOT), pushed by the
  // UI server — no polling here. refreshProfessor() re-renders the latest state.
  let professorState = null;
  function refreshProfessor() {
    if (!professorState) return;
    if (professorState.error) pv.error.textContent = professorState.error;
    else if (!pv.error.textContent.startsWith('Not sent:')) pv.error.textContent = '';
    const s = professorState.professor;
    if (!s) return;
    pv.course.textContent = `${s.course.title} — ${s.course.note}`;
    roster = (s.roster?.enrolled ?? []).map((x) => ({ ...x, name: x.name ?? x.studentId }));
    rosterCount = Number.isInteger(s.roster?.count) ? s.roster.count : null;
    if (rosterCount !== null) {
      const online = Number.isInteger(s.roster.online) ? s.roster.online : null;
      pv.roster.replaceChildren(el('span', { className: 'roster-count', textContent: `${rosterCount} ${rosterCount === 1 ? 'student' : 'students'}${online === null ? '' : ` · ${online} online`}` }));
    } else pv.roster.replaceChildren(); // the real class size isn't known yet: show nothing rather than the two-person session list
    posts = new Map(s.lessons.map((p) => [p.key, p]));
    chat = s.chat ?? [];
    hrCard = s.hrCard ?? null;
    quizCard = s.quizCard ?? null;
    quizAsking = Boolean(s.quizAsking);
    const first = !lastRendered;
    renderProfessor();
    if (first) follow.pin(); // open on the newest message, like the student's chat
    loadNames();
  }
  // Names for delivery rows the page can't label yet: one fetch at a time, only while the tab shows.
  async function loadNames() {
    if (pv.view.hidden || namesLoading) return;
    const ids = [...[...posts.values()].flatMap((p) => p.deliveries ?? []), ...(quizCard?.deliveries ?? [])].map((d) => d?.studentId).filter((id) => id && !knownName(id));
    if (!ids.length || (ids.every((id) => namesTried.has(id)) && Date.now() - namesAsked < 15000)) return;
    namesLoading = true;
    namesAsked = Date.now();
    for (const id of ids) namesTried.add(id);
    const token = namesToken;
    const r = await api('/api/professor/roster/names').catch(() => null);
    namesLoading = false;
    if (token !== namesToken || pv.view.hidden) return; // the tab was left while the names were on their way
    let changed = false;
    for (const [id, name] of Object.entries(r?.json?.names ?? {})) if (typeof name === 'string' && names.get(id) !== name) { names.set(id, name); changed = true; }
    if (changed) renderProfessor();
  }

  // @-tagging: suggestions from the class roster (round 2, R2). The names and tags come from the Faculty view's own fetch
  // (GET /api/professor/roster/people: names only, no email or ID), asked for the first time he types "@" while this tab
  // shows, and dropped when another tab shows — never the two Student-agent sessions, never in the state or the streams.
  let people = null; // [{ name, tag }]
  let peopleLoading = false;
  let peopleAsked = 0;
  let peopleToken = 0;
  async function loadPeople() {
    if (pv.view.hidden || peopleLoading || people || Date.now() - peopleAsked < 5000) return;
    peopleLoading = true;
    peopleAsked = Date.now();
    const token = peopleToken;
    const r = await api('/api/professor/roster/people').catch(() => null);
    peopleLoading = false;
    if (token !== peopleToken || pv.view.hidden) return; // the tab was left while the names were on their way
    const list = Array.isArray(r?.json?.people) ? r.json.people.filter((p) => typeof p?.name === 'string' && typeof p?.tag === 'string' && /^[a-z][\w-]*$/.test(p.tag)) : [];
    if (!list.length) return;
    people = list;
    if (document.activeElement === pv.input) showMentions();
  }
  const tagOf = (x) => x.tag ?? firstName(x).toLowerCase();
  let mentionAt = -1;
  let mentionIndex = 0;
  function mentionMatches() {
    const before = pv.input.value.slice(0, pv.input.selectionStart);
    const m = before.match(/(?:^|\s)@([\w-]*)$/);
    if (!m) return null;
    mentionAt = before.length - m[0].length + m[0].indexOf('@');
    if (!people) loadPeople();
    const q = m[1].toLowerCase();
    // By the tag, the first name or the last name (“@agu” finds Mariana Aguilar).
    const hits = (people ?? []).filter((p) => p.tag.startsWith(q) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
    return [...(firstName(ASSISTANT).startsWith(q) ? [ASSISTANT] : []), ...hits].slice(0, 8);
  }
  function showMentions() {
    const list = mentionMatches();
    if (!list?.length) { pv.mentions.hidden = true; return; }
    mentionIndex = Math.min(mentionIndex, list.length - 1);
    pv.mentions.replaceChildren(...list.map((x, i) => el('li', { role: 'option', ariaSelected: String(i === mentionIndex), textContent: `@${tagOf(x)} — ${x.label ?? x.name}`, onmousedown: (e) => { e.preventDefault(); pickMention(x); } })));
    pv.mentions.hidden = false;
  }
  function pickMention(x) {
    const caret = pv.input.selectionStart;
    const tag = `@${tagOf(x)} `;
    pv.input.value = pv.input.value.slice(0, mentionAt) + tag + pv.input.value.slice(caret);
    pv.input.selectionStart = pv.input.selectionEnd = mentionAt + tag.length;
    pv.mentions.hidden = true;
    store.set(DRAFT_KEY, pv.input.value);
  }
  pv.input.addEventListener('input', () => { mentionIndex = 0; showMentions(); store.set(DRAFT_KEY, pv.input.value); });
  pv.input.addEventListener('blur', () => { pv.mentions.hidden = true; });
  pv.input.addEventListener('keydown', (e) => {
    const list = pv.mentions.hidden ? null : mentionMatches();
    if (list?.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; showMentions(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(list[mentionIndex]); return; }
      if (e.key === 'Escape') { pv.mentions.hidden = true; return; }
    }
    // Enter sends; Shift+Enter is a new line (and an input-method composition is left alone).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); pv.form.requestSubmit(); }
  });

  pv.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = pv.input.value.trim();
    if (!text || pending) return; // one message at a time
    if (attempt?.text !== text || (attempt.replyTo ?? null) !== replyingTo || (attempt.answers ?? null) !== answering) attempt = { operationId: `op-${crypto.randomUUID()}`, text, replyTo: replyingTo, answers: answering };
    store.set(`${DRAFT_KEY}:attempt`, attempt);
    pending = { text, operationId: attempt.operationId, replyTo: replyingTo, answers: answering };
    pv.input.value = '';
    pv.send.disabled = true;
    pv.error.textContent = '';
    follow.pin();
    renderProfessor();
    // An open HR card: its current values travel with the message, so a chat follow-up fills the card on
    // top of what the professor already changed on it (HR merges these first, then the words).
    const card = hrValues();
    const r = await professorRun(text, { operationId: attempt.operationId, ...(pending.replyTo ? { replyTo: pending.replyTo } : {}), ...(pending.answers ? { answers: pending.answers } : {}), ...(card ? { formRef: card.formRef, formValues: card.values } : {}) });
    pending = null;
    pv.send.disabled = false;
    if (r?.ok) {
      if (r.json?.action !== 'error') setReplyingTo(null);
      attempt = null;
      store.set(`${DRAFT_KEY}:attempt`, null);
      store.set(DRAFT_KEY, '');
    } else {
      // Not processed (or unknown): give the text back; sending it again reuses the same operation id.
      if (!pv.input.value) pv.input.value = text;
      pv.error.textContent = `Not sent: ${r?.json?.error ?? 'no answer from the Faculty agent'}. Your text is back in the box; send it again to retry.`;
    }
    lastRendered = '';
    refreshProfessor();
    follow.pin();
  });

  // A topic chip tap (Part 16): a structured pick only the quiz desk handles. It never uses the composer, the Reply chip
  // or the saved draft text, so what he was typing (or replying to one student) stays exactly as it was.
  async function sendTopicPick(n, text) {
    if (pending) return;
    pending = { text, operationId: `op-${crypto.randomUUID()}`, replyTo: null, answers: null };
    pv.send.disabled = true;
    pv.error.textContent = '';
    follow.pin();
    renderProfessor();
    const r = await professorRun(text, { operationId: pending.operationId, quizTopic: n });
    pending = null;
    pv.send.disabled = false;
    if (!r?.ok) pv.error.textContent = `Not sent: ${r?.json?.error ?? 'no answer from the Faculty agent'}. Tap the topic again to retry.`;
    lastRendered = '';
    refreshProfessor();
    follow.pin();
  }

  // One professor message = one AG-UI run (POST /api/ag-ui/professor/runs). The server owns the run; its
  // result (CUSTOM professor_result) arrives on the Professor stream — possibly before the 202 answer.
  const runResults = new Map(); // runId → result | resolver
  async function professorRun(text, forwardedProps) {
    const input = { threadId: 'professor', runId: crypto.randomUUID(), messages: [{ id: crypto.randomUUID(), role: 'user', content: text }], state: {}, tools: [], context: [], forwardedProps };
    const started = await api('/api/ag-ui/professor/runs', { method: 'POST', body: input }).catch(() => null);
    if (!started?.ok) return started;
    const { runId } = started.json;
    const known = runResults.get(runId);
    if (known && !(typeof known === 'function')) { runResults.delete(runId); return known; }
    return new Promise((resolve) => runResults.set(runId, resolve));
  }
  function professorResult(result) {
    const waiting = runResults.get(result.runId);
    runResults.delete(result.runId);
    if (typeof waiting === 'function') waiting(result);
    else runResults.set(result.runId, result);
  }
  // The Professor channel of the page's single connection (app.js): a fresh StreamAgent per (re)connect.
  function attachProfessor(agent) {
    agent.connectAgent({}, {
      onEvent: ({ event }) => {
        if (event.type === 'STATE_SNAPSHOT') {
          const first = !professorState;
          professorState = event.snapshot;
          refreshProfessor();
          if (first) follow.pin();
        } else if (event.type === 'CUSTOM' && event.name === 'professor_result') professorResult(event.value);
      },
    }).catch(() => {});
  }

  // ---- events ------------------------------------------------------------------------------------------
  refreshInbox();
  return {
    event({ source, type, data }, { live }) {
      if (source === 'student' && ['lesson_received', 'lesson_opened', 'course_available'].includes(type)) refreshInbox();
      // A toast is for the student; while this browser shows the Faculty view, the inbox and the
      // Conversation tab's unread dot carry it instead.
      if (source === 'student' && type === 'lesson_received' && live && pv.view.hidden && (!isMessage(data) || data.quiz)) toast(data); // a message is in the chat itself; a quiz notice also gets a toast
      if (source === 'system' && (type === 'conversation_reset' || type === 'classroom_reset')) {
        // The classroom was reset too: nothing to open, announce or ask about any more.
        setAbout(null);
        if (els.dialog.open) els.dialog.close();
        for (const t of els.toasts.querySelectorAll('.toast')) t.remove();
        refreshInbox();
        refreshProfessor();
      }
      if (source === 'student' && type === 'inbox_reset') refreshInbox();
      if ((/^lesson_|^course_available/.test(type) || (source === 'professor' && type === 'student_reply')) && !pv.view.hidden) refreshProfessor();
    },
    hasInboxItems: () => inbox.lessons.length > 0 || inbox.notices.length > 0,
    composerContext: () => (about?.deliveryId ? { lessonDeliveryId: about.deliveryId } : about?.capability ? { capability: about.capability } : {}),
    // After a message is sent: a reply chip has done its job (a lesson's "About" chip stays for follow-ups).
    sent: () => { if (about?.reply) setAbout(null); },
    replyTo,
    messageShown,
    // A time picked from a meeting offer: sent as a reply to that offer, naming the time; the Professor books it.
    pickSlot: ({ deliveryId, slot }) => { setAbout(null); return sendChat(`I’ll take ${slot.label}.`, { lessonDeliveryId: deliveryId, meetingSlot: slot.slotId }); },
    professorShown: () => refreshProfessor(),
    // Another tab is showing: the quiz cards (and the answer key in them) leave the page.
    // Classmates' names leave too (they come back from the roster fetch when the tab shows again).
    professorHidden: () => { names.clear(); namesTried.clear(); namesToken += 1; namesAsked = 0; namesLoading = false; people = null; peopleToken += 1; peopleLoading = false; peopleAsked = 0; pv.mentions.hidden = true; if (lastRendered) { lastRendered = ''; renderProfessor(); } },
    attachProfessor,
  };
}
