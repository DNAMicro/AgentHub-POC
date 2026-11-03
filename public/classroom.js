// Part 9: the classroom in the browser.
//   * Conversation view: the Student agent's course inbox (lessons the university delivered, persisted by
//     the Student agent), a one-time "course available" notice, a toast for a newly delivered lesson, the
//     lesson itself (Start lesson / Ask about this lesson / Save for later) and the "About: lesson" chip
//     that makes follow-up questions carry the lesson reference.
//     Messages (announcements, notes, replies) aren't in the inbox: they arrive in the chat itself, with a
//     Reply button that makes the next message a reply to that one (it goes to whoever sent it).
//   * Professor view: the professor's chat — post, watch delivery state, see students' replies and the
//     course assistant's answers, and reply to one student.
// Everything here comes from the UI server's APIs and real events. A toast or a delivery never marks a
// lesson opened: only opening it does. Lesson text is content — always set with textContent.
//
// HR (staff only): when the professor asks for time off, HR's card comes back in the Professor state
// (`hrCard`: formRef, the A2UI messages HR sent, and a summary HR worked out by code). The card is drawn
// here as HR's chat bubble: a headline (absence name), one “when” line, one “why” line, the fields from
// HR's A2UI surface (official renderer, editable in place), the balance bar, Submit request / Cancel.
// Buttons post the renderer's action to /api/professor/hr/actions → Hub → Professor agent → Hub → HR.
import { MessageProcessor, basicCatalog } from './vendor/a2ui.js';
import { A2UI_VERSION, RELATIONSHIP_LABEL, RELATIONSHIP_REQUIRED, validateFinal } from '/shared/forms.js';
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
      els.noticeText.textContent = `Ask its professor anything about the course here; new lessons from ${notice.professorName ?? 'the professor'} will appear in this inbox.`;
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
    els.dCourse.textContent = `${isMessage(showing) ? 'Message' : 'Lesson'} · ${showing.courseTitle} · from ${showing.professorName ?? 'the professor'}${showing.toAll ? ' to the whole class' : ''} · ${when(showing.postedAt)}`;
    els.dTitle.textContent = untitled(showing);
    // A message has nothing to "start"; both can be asked about and saved.
    els.start.hidden = isMessage(showing);
    els.ask.textContent = isMessage(showing) ? 'Ask about this message' : 'Ask about this lesson';
    els.dText.textContent = showing.text;
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
  function toast(data) {
    const item = el('div', { className: 'toast', dataset: { delivery: data.deliveryId } },
      el('p', { className: 'toast-title', textContent: isMessage(data) ? `New message from ${data.professorName ?? 'your professor'}` : `New ${data.courseTitle ?? 'course'} lesson` }),
      el('p', { className: 'toast-text', textContent: untitled(data) }),
      el('div', { className: 'toast-actions' },
        el('button', { type: 'button', textContent: isMessage(data) ? 'View message' : 'View lesson', onclick: () => openLesson(data.deliveryId) }),
        el('button', { type: 'button', className: 'quiet', textContent: 'Dismiss', onclick: () => item.remove() })));
    els.toasts.append(item);
    // Leaves on its own after a while unless the pointer or keyboard is on it.
    const timer = setInterval(() => { if (!item.matches(':hover, :focus-within')) { item.remove(); clearInterval(timer); } }, 15000);
  }
  function dismissToasts(deliveryId) {
    for (const t of els.toasts.querySelectorAll('.toast')) if (t.dataset.delivery === deliveryId) t.remove();
  }

  // ---- Professor view: a chat ---------------------------------------------------------------------------
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
    queued: ['Queued at Hub', 'busy'], delivered: ['Delivered', 'ok'], opened: ['Opened', 'ok'],
    uncertain: ['Being confirmed', 'warn'], failed: ['Failed', 'bad'], sending: ['Sending…', 'busy'],
  };
  function studentState(d) {
    if (d.opened) return ['opened', when(d.openedAt)];
    if (d.state === 'queued') return ['queued', d.lastError === 'student_offline' || /refused/.test(d.lastError ?? '') ? 'their student agent isn’t connected; delivered when it is' : d.lastError];
    if (d.state === 'delivered') return ['delivered', when(d.deliveredAt)];
    return [d.state, d.lastError];
  }
  const nameOf = (id) => String(id).split(',').map((x) => roster.find((r) => r.studentId === x)?.name ?? x).join(', ');

  function bubble({ dir, speaker, label, at, text }) {
    return el('li', { className: 'msg', dataset: { dir, speaker } },
      el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: label }), el('time', { dateTime: at ?? '', textContent: at ? new Date(at).toLocaleTimeString([], { hour12: false }) : '' })),
      el('p', { className: 'msg-text', textContent: text }));
  }
  // What was sent, to whom, whose words, and each student's state.
  function postCard(p) {
    const isMsg = p.kind === 'message';
    const origin = p.seedId ? 'Course lesson, as written in the course pack' : p.source !== 'chat' ? 'Sent from the course API' : p.verbatim ? 'Your words' : 'Written from your instruction — read it before students do';
    return el('li', { className: 'msg post-card', dataset: { dir: 'received', speaker: 'professor', kind: p.kind } },
      el('div', { className: 'msg-head' },
        el('span', { className: 'msg-dir' }, el('span', { className: 'kind-tag', textContent: isMsg ? 'Message' : 'Lesson' }), ` ${p.title || (isMsg ? 'Message' : 'Lesson')}`),
        el('time', { textContent: `to ${p.audience === 'all' ? `the whole class (${p.deliveries.length || '…'})` : p.audience.split(',').map(nameOf).join(', ')}` })),
      el('p', { className: 'msg-text post-text', textContent: p.text }),
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
  function deliveryLines(p) {
    if (p.hubStatus === 'rejected') return el('p', { className: 'post-origin', dataset: { verbatim: 'false' }, textContent: `Refused by the Hub: ${p.hubReason}` });
    if (!p.deliveries.length) return el('p', { className: 'post-origin', textContent: p.hubAccepted ? 'Sent to the Hub…' : 'Not confirmed by the Hub yet — it will be retried.' });
    return el('ul', { className: 'per-student' }, ...p.deliveries.map((d) => {
      const [k, detail] = studentState(d);
      const [label, tone] = DELIVERY[k] ?? [k, 'warn'];
      return el('li', { dataset: { tone } }, el('span', { className: 'who', textContent: nameOf(d.studentId) }), el('span', { className: 'what', textContent: `${label}${detail ? ` — ${detail}` : ''}` }));
    }));
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
    const li = bubble({ dir: m.failed ? 'error' : 'info', speaker: 'professor', label: `Course assistant → ${nameOf(m.to)}${m.onBehalf ? ' (for you)' : ''}${m.model && m.model !== 'mock extraction' ? ` · ${m.model}` : ''}`, at: m.at, text: m.text });
    if (m.needsProfessor) li.append(el('p', { className: 'needs-you', textContent: 'Needs your answer — the assistant didn’t decide this.' }), replyButton(m.to));
    return li;
  }
  // ---- HR (staff only): the open time-off card ------------------------------------------------------
  // One card at a time (HR re-issues it with a new formRef after a follow-up message). The rendered card
  // is kept across re-renders (same element, same renderer) so what the professor typed is never lost.
  const HR_LABEL = 'HR · Time off';
  const BALANCE_NAMES = { vacation: 'Vacation hours', sick: 'Sick hours', personalHoliday: 'Personal holiday hours' };
  const MISSING_TEXT = { absenceName: 'absence name', dates: 'dates', relationship: 'relationship' };
  let hrCard = null; // professorState.professor.hrCard
  let hr = null; // { formRef, li, processor, surface, applied, busy, attempt, notice, lead }
  const hours = (n) => (Number.isFinite(n) ? n.toFixed(1) : String(n));
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
  function balanceView(card) {
    if (card.balance) {
      const { type, now, after } = card.balance;
      const keep = now > 0 ? Math.max(0, Math.min(100, (after / now) * 100)) : 0;
      return el('div', { className: 'hr-balance' },
        el('div', { className: 'hr-bal-row' }, el('span', { textContent: BALANCE_NAMES[type] ?? `${type} hours` }),
          el('span', {}, el('b', { textContent: hours(now) }), ' now, ', el('b', { textContent: hours(after) }), ' after')),
        el('div', { className: 'hr-meter', role: 'img', ariaLabel: `${BALANCE_NAMES[type] ?? type}: ${hours(now)} now, ${hours(after)} after this request` },
          el('div', { className: 'keep', style: `width: ${keep}%` }), el('div', { className: 'use', style: `width: ${100 - keep}%` })));
    }
    return card.note ? el('div', { className: 'hr-balance' }, el('p', { className: 'hr-note', textContent: card.note })) : null;
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
      const notice = el('div', { className: 'notice', role: 'status' });
      const missing = (card.missing ?? []).filter((f) => MISSING_TEXT[f]);
      const li = el('li', { className: 'msg hr-card', dataset: { dir: 'received', speaker: 'hr', formRef: open.formRef, missing: missing.join(' ') } },
        el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: HR_LABEL }), el('time', { dateTime: m.at ?? '', textContent: m.at ? new Date(m.at).toLocaleTimeString([], { hour12: false }) : '' })),
        lead,
        el('p', { className: 'hr-title', textContent: card.title ?? 'Time off request' }),
        el('p', { className: 'hr-when', dataset: { missing: String(!card.when) }, textContent: card.when ?? 'Dates still needed' }),
        card.why ? el('p', { className: 'hr-why', textContent: card.why }) : null,
        card.problem ? el('p', { className: 'hr-problem', textContent: card.problem }) : null,
        missing.length ? el('p', { className: 'hr-missing', textContent: `Still needed: ${missing.map((f) => MISSING_TEXT[f]).join(', ')} — fill in the highlighted field${missing.length > 1 ? 's' : ''} or answer HR in the chat.` }) : null,
        surfaceEl, balanceView(card), notice);
      hr = { formRef: open.formRef, surfaceId, li, processor, surface, applied: open.a2ui.length, busy: false, attempt: null, notice, lead, subs: [] };
      // The relationship row is always there; it is required (star, check) only while the name picked on the
      // card needs one — kept in step here as the professor changes the name.
      const relationshipNeeded = () => {
        const name = [].concat(surface.dataModel.get('/absenceName') ?? [])[0] ?? '';
        const needed = RELATIONSHIP_REQUIRED.has(name);
        surface.dataModel.set('/ui/relationshipNeeded', needed ? 'yes' : '');
        surface.dataModel.set('/ui/relationshipLabel', needed ? RELATIONSHIP_LABEL.required : RELATIONSHIP_LABEL.optional);
        li.dataset.relationshipNeeded = String(needed);
      };
      relationshipNeeded();
      hr.subs.push(surface.dataModel.subscribe('/absenceName', relationshipNeeded));
    } else if (open.a2ui.length > hr.applied) {
      // HR refused a Submit: its A2UI updates (field errors) arrive appended to the card's messages.
      hr.processor.processMessages(structuredClone(open.a2ui.slice(hr.applied).filter((x) => !x.deleteSurface)));
      hr.applied = open.a2ui.length;
    }
    hr.lead.textContent = m.text;
    return hr.li;
  }
  // The open card's current values (what the professor sees and may have edited), or null.
  function hrValues() {
    if (!hr?.surface) return null;
    const dm = hr.surface.dataModel;
    const values = Object.fromEntries(['absenceName', 'beginDate', 'endDate', 'hours', 'relationship', 'note'].map((f) => [f, structuredClone(dm.get(`/${f}`) ?? '')]));
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
    const handedOver = new Map(chat.filter((m) => m.role === 'assistant' && m.needsProfessor).map((m) => [m.id, m]));
    for (const m of chat) {
      const r = m.role === 'student' && handedOver.get(m.id.replace(/:s$/, ':r'));
      if (r) items.push(handover(m, r));
      else if (m.role === 'student') items.push(studentReply(m));
      else if (m.role === 'assistant' && m.needsProfessor && chat.some((s) => s.id === m.id.replace(/:r$/, ':s'))) continue; // shown on its card
      else if (m.role === 'assistant' && m.action === 'answer_student') items.push(assistantAnswer(m));
      else if (m.role === 'hr') {
        // HR (staff only): the open card where HR sent it; every other HR reply (a receipt, a question,
        // a refusal) as HR's own bubble.
        if (m.formRef && hrCard?.formRef === m.formRef && !m.closed && !m.failed) items.push(hrCardItem(m, hrCard));
        else {
          const li = bubble({ dir: m.failed ? 'error' : 'received', speaker: 'hr', label: HR_LABEL, at: m.at, text: m.text });
          if (m.closed && /^Sent to your manager/.test(m.text)) li.classList.add('hr-receipt');
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
        items.push(bubble({ dir: m.action === 'error' || m.action === 'clarify' ? 'info' : 'received', speaker: 'professor', label: m.model && m.model !== 'mock heuristic' ? `Course assistant · ${m.model}` : 'Course assistant', at: m.at, text: m.text }));
        if (m.postKey && posts.get(m.postKey)) items.push(postCard(posts.get(m.postKey)));
      }
    }
    if (pending) {
      items.push(bubble({ dir: 'sent', speaker: 'student', label: pending.replyTo ? `You → ${nameOf(pending.replyTo)}` : 'You', at: new Date().toISOString(), text: pending.text }));
      items.push(el('li', { className: 'chat-pending' }, el('span', { className: 'spinner', ariaHidden: 'true' }), /@assistant\b/i.test(pending.text) ? 'The course assistant is working on it…' : 'Sending…'));
    }
    const waiting = [...handedOver.values()].filter((m) => !m.answeredAt).length;
    pv.waiting.hidden = !waiting;
    pv.waiting.textContent = String(waiting);
    pv.waiting.title = `${waiting} question${waiting === 1 ? '' : 's'} waiting for your answer`;
    if (hr && !items.includes(hr.li)) hrDispose(); // the card closed (submitted, cancelled, expired, reset)
    const signature = JSON.stringify([chat.length, pending?.text, [...handedOver.values()].map((m) => m.answeredAt ?? null), [...posts.values()].map((p) => [p.key, p.hubStatus, p.deliveries]), hrCard?.formRef ?? null, hrCard?.a2ui.length ?? 0, chat.at(-1)?.text]);
    if (signature === lastRendered) return;
    lastRendered = signature;
    // The open HR card stays where it is in the page (never detached), so a field being edited keeps focus.
    const keep = hr && items.includes(hr.li) && hr.li.parentNode === pv.log ? hr.li : null;
    if (!keep) return pv.log.replaceChildren(...items);
    for (const c of [...pv.log.children]) if (c !== keep) c.remove();
    const at = items.indexOf(keep);
    keep.before(...items.slice(0, at));
    keep.after(...items.slice(at + 1));
  }
  // Part 10: the Professor view's state arrives over its own AG-UI stream (STATE_SNAPSHOT), pushed by the
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
    pv.roster.replaceChildren(...roster.map((x) => el('span', { className: 'presence', dataset: { online: String(Boolean(x.online)) }, textContent: x.name, title: x.online ? 'Student agent online' : 'Student agent not connected — posts queue at the Hub' })));
    posts = new Map(s.lessons.map((p) => [p.key, p]));
    chat = s.chat ?? [];
    hrCard = s.hrCard ?? null;
    const first = !lastRendered;
    renderProfessor();
    if (first) follow.pin(); // open on the newest message, like the student's chat
  }

  // @-tagging: suggestions from the class roster.
  let mentionAt = -1;
  let mentionIndex = 0;
  function mentionMatches() {
    const before = pv.input.value.slice(0, pv.input.selectionStart);
    const m = before.match(/@([\w-]*)$/);
    if (!m) return null;
    mentionAt = before.length - m[0].length;
    // By first name (the tag itself): ids all start with "student-" and the demo surnames are all "Student".
    return [ASSISTANT, ...roster].filter((x) => firstName(x).toLowerCase().startsWith(m[1].toLowerCase()));
  }
  function showMentions() {
    const list = mentionMatches();
    if (!list?.length) { pv.mentions.hidden = true; return; }
    mentionIndex = Math.min(mentionIndex, list.length - 1);
    pv.mentions.replaceChildren(...list.map((x, i) => el('li', { role: 'option', ariaSelected: String(i === mentionIndex), textContent: `@${firstName(x).toLowerCase()} — ${x.label ?? x.name}`, onmousedown: (e) => { e.preventDefault(); pickMention(x); } })));
    pv.mentions.hidden = false;
  }
  function pickMention(x) {
    const caret = pv.input.selectionStart;
    const tag = `@${firstName(x).toLowerCase()} `;
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
      pv.error.textContent = `Not sent: ${r?.json?.error ?? 'no answer from the Professor agent'}. Your text is back in the box; send it again to retry.`;
    }
    lastRendered = '';
    refreshProfessor();
    follow.pin();
  });

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
      // A toast is for the student; while this browser shows the Professor view, the inbox and the
      // Conversation tab's unread dot carry it instead.
      if (source === 'student' && type === 'lesson_received' && live && pv.view.hidden && !isMessage(data)) toast(data); // a message is in the chat itself
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
    attachProfessor,
  };
}
