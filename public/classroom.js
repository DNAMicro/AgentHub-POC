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
const $ = (id) => document.getElementById(id);
const el = (tag, { dataset = {}, ...props } = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset); // dataset itself is read-only; its entries aren't
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const isMessage = (x) => x?.kind === 'message';
const untitled = (x) => x?.title || (isMessage(x) ? 'Untitled message' : 'Untitled lesson');
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
      api(`/api/inbox/${encodeURIComponent(id)}/open`, { method: 'POST' }).then(() => refreshInbox()).catch(() => seen.delete(id));
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
  };
  const follow = followLog(pv.log);
  const DRAFT_KEY = 'a2a-spike:professor-draft';
  let roster = [];
  let posts = new Map(); // key → post with deliveries
  let chat = [];
  let pending = null; // { text, operationId } while a message is being worked on
  let lastRendered = '';
  let replyingTo = null; // a student id: the professor's next message goes to that student only
  function setReplyingTo(studentId) {
    replyingTo = studentId;
    pv.replyChip.hidden = !studentId;
    pv.replyName.textContent = studentId ? nameOf(studentId) : '';
    if (studentId) pv.input.focus();
  }
  pv.replyClear.addEventListener('click', () => setReplyingTo(null));
  const replyButton = (studentId) => el('button', { type: 'button', className: 'reply-action', textContent: '↩ Reply', title: `Reply to ${nameOf(studentId)} only`, ariaLabel: `Reply to ${nameOf(studentId)}`, onclick: () => setReplyingTo(studentId) });
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
  // The assistant answering a student for the professor — shown so the professor sees every exchange.
  function assistantAnswer(m) {
    const li = bubble({ dir: m.failed ? 'error' : 'info', speaker: 'professor', label: `Course assistant → ${nameOf(m.to)}${m.onBehalf ? ' (for you)' : ''}${m.model && m.model !== 'mock extraction' ? ` · ${m.model}` : ''}`, at: m.at, text: m.text });
    if (m.needsProfessor) li.append(el('p', { className: 'needs-you', textContent: 'Needs your answer — the assistant didn’t decide this.' }), replyButton(m.to));
    return li;
  }
  function renderProfessor() {
    const items = [];
    for (const m of chat) {
      if (m.role === 'student') items.push(studentReply(m));
      else if (m.role === 'assistant' && m.action === 'answer_student') items.push(assistantAnswer(m));
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
    const signature = JSON.stringify([chat.length, pending?.text, [...posts.values()].map((p) => [p.key, p.hubStatus, p.deliveries])]);
    if (signature === lastRendered) return;
    lastRendered = signature;
    pv.log.replaceChildren(...items);
  }
  async function refreshProfessor() {
    const r = await api('/api/professor/state').catch(() => null);
    if (!r?.ok) { pv.error.textContent = r?.json?.error ?? 'The Professor agent isn’t reachable right now.'; return; }
    pv.error.textContent = '';
    const s = r.json;
    pv.course.textContent = `${s.course.title} — ${s.course.note}`;
    roster = (s.roster?.enrolled ?? []).map((x) => ({ ...x, name: x.name ?? x.studentId }));
    pv.roster.replaceChildren(...roster.map((x) => el('span', { className: 'presence', dataset: { online: String(Boolean(x.online)) }, textContent: x.name, title: x.online ? 'Student agent online' : 'Student agent not connected — posts queue at the Hub' })));
    posts = new Map(s.lessons.map((p) => [p.key, p]));
    chat = s.chat ?? [];
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
    if (attempt?.text !== text || (attempt.replyTo ?? null) !== replyingTo) attempt = { operationId: `op-${crypto.randomUUID()}`, text, replyTo: replyingTo };
    store.set(`${DRAFT_KEY}:attempt`, attempt);
    pending = { text, operationId: attempt.operationId, replyTo: replyingTo };
    pv.input.value = '';
    pv.send.disabled = true;
    pv.error.textContent = '';
    follow.pin();
    renderProfessor();
    const r = await api('/api/professor/chat', { method: 'POST', body: { operationId: attempt.operationId, text, ...(pending.replyTo ? { replyTo: pending.replyTo } : {}) } }).catch(() => null);
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
    await refreshProfessor();
    follow.pin();
  });
  setInterval(() => { if (!pv.view.hidden) refreshProfessor(); }, 3000);

  // ---- events ------------------------------------------------------------------------------------------
  refreshInbox();
  refreshProfessor();
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
  };
}
