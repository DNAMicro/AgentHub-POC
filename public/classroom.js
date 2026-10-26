// Part 9: the classroom in the browser.
//   * Conversation view: the Student agent's course inbox (lessons the university delivered, persisted by
//     the Student agent), a one-time "course available" notice, a toast for a newly delivered lesson, the
//     lesson itself (Start lesson / Ask about this lesson / Save for later) and the "About: lesson" chip
//     that makes follow-up questions carry the lesson reference.
//   * Professor view: the professor's console — write a lesson, post it, watch its delivery state.
// Everything here comes from the UI server's APIs and real events. A toast or a delivery never marks a
// lesson opened: only opening it does. Lesson text is content — always set with textContent.
const $ = (id) => document.getElementById(id);
const el = (tag, { dataset = {}, ...props } = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset); // dataset itself is read-only; its entries aren't
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
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

export function createClassroom({ sendChat, showConversation, focusComposer }) {
  const els = {
    toggle: $('inbox-toggle'), unread: $('inbox-unread'), inbox: $('inbox'), list: $('lesson-list'),
    notice: $('course-notice'), noticeTitle: $('course-notice-title'), noticeText: $('course-notice-text'), noticeOk: $('course-notice-ok'), noticeAsk: $('course-notice-ask'),
    chip: $('about-chip'), chipTitle: $('about-title'), chipClear: $('about-clear'),
    dialog: $('lesson-dialog'), dCourse: $('lesson-dialog-course'), dTitle: $('lesson-dialog-title'), dText: $('lesson-dialog-text'),
    start: $('lesson-start'), ask: $('lesson-ask'), save: $('lesson-save'), close: $('lesson-close'),
    toasts: $('toasts'), tab: $('tab-conversation'),
  };
  let inbox = { lessons: [], notices: [], unread: 0 };
  let about = null; // { deliveryId, title } (a lesson) or { capability, title } (a course) — follow-ups carry it
  let showing = null; // the lesson open in the dialog

  // ---- inbox -------------------------------------------------------------------------------------------
  async function refreshInbox() {
    const r = await api('/api/inbox').catch(() => null);
    if (!r?.ok) return;
    inbox = r.json;
    renderInbox();
  }
  const stateOf = (l) => (l.openedAt ? 'opened' : 'new');
  function renderInbox() {
    const has = inbox.lessons.length > 0;
    els.toggle.hidden = !has;
    els.unread.hidden = inbox.unread === 0;
    els.unread.textContent = String(inbox.unread);
    els.unread.setAttribute('aria-label', `${inbox.unread} unread`);
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
    els.list.replaceChildren(...inbox.lessons.map((l) => el('li', { className: 'lesson-item', dataset: { state: stateOf(l), saved: String(Boolean(l.savedAt)) } },
      el('span', { className: 'lesson-flag', textContent: l.openedAt ? 'Opened' : 'New' }),
      el('span', { className: 'lesson-name', textContent: l.title || 'Untitled lesson' }),
      el('span', { className: 'lesson-meta', textContent: `${l.courseTitle} · ${when(l.receivedAt)}${l.savedAt ? ' · saved for later' : ''}` }),
      el('button', { type: 'button', className: 'inline-action', textContent: 'View lesson', onclick: () => openLesson(l.deliveryId) }))));
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
    els.dCourse.textContent = `${showing.courseTitle} · from ${showing.professorName ?? 'the professor'} · ${when(showing.postedAt)}`;
    els.dTitle.textContent = showing.title || 'Untitled lesson';
    els.dText.textContent = showing.text;
    els.save.disabled = Boolean(showing.savedAt);
    els.save.textContent = showing.savedAt ? 'Saved' : 'Save for later';
    showConversation();
    if (!els.dialog.open) els.dialog.showModal();
    refreshInbox();
  }
  function setAbout(target) {
    about = !target ? null : target.capability ? { capability: target.capability, title: target.title } : { deliveryId: target.deliveryId, title: target.title || 'Untitled lesson' };
    els.chip.hidden = !about;
    els.chipTitle.textContent = about?.title ?? '';
  }
  els.chipClear.addEventListener('click', () => setAbout(null));
  els.start.addEventListener('click', () => {
    const lesson = showing;
    els.dialog.close();
    setAbout(lesson);
    sendChat(`I’m starting the lesson “${lesson.title || 'Untitled lesson'}”.`, { lessonDeliveryId: lesson.deliveryId });
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
      el('p', { className: 'toast-title', textContent: `New ${data.courseTitle ?? 'course'} lesson` }),
      el('p', { className: 'toast-text', textContent: data.title || 'Untitled lesson' }),
      el('div', { className: 'toast-actions' },
        el('button', { type: 'button', textContent: 'View lesson', onclick: () => openLesson(data.deliveryId) }),
        el('button', { type: 'button', className: 'quiet', textContent: 'Dismiss', onclick: () => item.remove() })));
    els.toasts.append(item);
    // Leaves on its own after a while unless the pointer or keyboard is on it.
    const timer = setInterval(() => { if (!item.matches(':hover, :focus-within')) { item.remove(); clearInterval(timer); } }, 15000);
  }
  function dismissToasts(deliveryId) {
    for (const t of els.toasts.querySelectorAll('.toast')) if (t.dataset.delivery === deliveryId) t.remove();
  }

  // ---- Professor view ----------------------------------------------------------------------------------
  const pv = {
    view: $('view-professor'), form: $('author-form'), student: $('author-student'), presence: $('author-presence'), title: $('author-title-input'),
    text: $('author-text'), seeds: $('author-seeds'), post: $('author-post'), status: $('author-status'), list: $('posted-list'), course: $('author-course'), hub: $('posted-hub'),
  };
  const DRAFT_KEY = 'a2a-spike:lesson-draft';
  let roster = [];
  let posting = false;
  // A retry of the same content after a failure reuses its operation id, so the Hub never makes two.
  let attempt = store.get(`${DRAFT_KEY}:attempt`); // { operationId, key }
  const draft = store.get(DRAFT_KEY);
  if (draft) { pv.title.value = draft.title ?? ''; pv.text.value = draft.text ?? ''; }
  const saveDraft = () => store.set(DRAFT_KEY, { title: pv.title.value, text: pv.text.value });
  // "Draft": unposted text in the box (kept in this browser only). Typing never posts anything.
  const showDraft = () => {
    if (posting) return;
    const has = Boolean(pv.title.value.trim() || pv.text.value.trim());
    if (has) { pv.status.dataset.tone = 'draft'; pv.status.textContent = 'Draft — not posted yet.'; } else if (pv.status.dataset.tone === 'draft') { pv.status.textContent = ''; delete pv.status.dataset.tone; }
  };
  for (const input of [pv.title, pv.text]) input.addEventListener('input', () => { saveDraft(); showDraft(); });
  showDraft();
  let seedsShown = false;

  const DELIVERY = {
    sending: ['Sending to the Hub…', 'busy'],
    queued: ['Queued at Hub', 'busy'],
    delivered: ['Delivered', 'ok'],
    opened: ['Opened by the student', 'ok'],
    uncertain: ['Delivery uncertain — the Hub is checking with the student', 'warn'],
    failed: ['Failed', 'bad'],
    rejected: ['Refused by the Hub', 'bad'],
    unconfirmed: ['Not confirmed by the Hub — will retry', 'warn'],
  };
  function deliveryState(l) {
    if (l.hubStatus === 'rejected') return ['rejected', l.hubReason];
    const d = l.delivery;
    if (!d) return l.hubStatus === 'sending' ? ['sending'] : l.hubAccepted ? [l.hubStatus, l.hubReason] : ['unconfirmed', l.hubReason];
    if (d.opened) return ['opened', when(d.openedAt)];
    if (d.state === 'queued') return ['queued', d.lastError === 'student_offline' || /refused/.test(d.lastError ?? '') ? 'the student’s agent is offline; it will be delivered when it returns' : d.lastError];
    if (d.state === 'delivered') return ['delivered', when(d.deliveredAt)];
    return [d.state, d.lastError];
  }

  async function refreshProfessor() {
    const r = await api('/api/professor/state').catch(() => null);
    if (!r?.ok) {
      pv.hub.textContent = r?.json?.error ?? 'The Professor agent isn’t reachable right now.';
      return;
    }
    const s = r.json;
    pv.course.textContent = `${s.course.title} — ${s.course.note}`;
    pv.hub.textContent = s.hubReachable ? 'Delivery state from the university Hub' : 'The Hub isn’t answering — states below may be out of date.';
    roster = s.roster?.enrolled ?? [];
    const chosen = pv.student.value;
    pv.student.replaceChildren(...roster.map((st) => el('option', { value: st.studentId, textContent: st.studentId })));
    if (roster.some((st) => st.studentId === chosen)) pv.student.value = chosen;
    renderPresence();
    if (!seedsShown) {
      seedsShown = true;
      for (const seed of s.seeds ?? []) {
        pv.seeds.append(el('button', { type: 'button', className: 'seed', textContent: seed.title, onclick: () => {
          pv.title.value = seed.title;
          pv.text.value = [seed.objective, seed.explanation, seed.example, seed.check ? `Check your understanding: ${seed.check}` : null].filter(Boolean).join('\n\n');
          saveDraft();
          showDraft();
          pv.text.focus();
        } }));
      }
    }
    pv.list.replaceChildren(...s.lessons.map((l) => {
      const [key, detail] = deliveryState(l);
      const [label, tone] = DELIVERY[key] ?? [key, 'warn'];
      return el('li', { className: 'posted-item' },
        el('span', { className: 'posted-title', textContent: l.title || 'Untitled lesson' }),
        el('span', { className: 'posted-meta', textContent: `to ${l.recipient} · ${when(l.createdAt)} · revision ${l.revision}` }),
        el('span', { className: 'delivery-chip', dataset: { tone }, textContent: label }),
        detail ? el('span', { className: 'posted-detail', textContent: detail }) : null);
    }));
  }
  function renderPresence() {
    const st = roster.find((x) => x.studentId === pv.student.value);
    pv.presence.textContent = st ? (st.online ? 'Student agent online' : 'Student agent offline — lessons will queue at the Hub') : 'No enrolled students';
    pv.presence.dataset.online = String(Boolean(st?.online));
  }
  pv.student.addEventListener('change', renderPresence);

  pv.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (posting) return; // one press, one post
    const title = pv.title.value.trim();
    const text = pv.text.value.trim();
    if (!text) { pv.status.textContent = 'Write what you’d like your student to learn first.'; pv.text.focus(); return; }
    if (!pv.student.value) { pv.status.textContent = 'There is no enrolled student to post to.'; return; }
    const key = JSON.stringify([title, text, pv.student.value]);
    if (attempt?.key !== key) attempt = { operationId: `op-${crypto.randomUUID()}`, key };
    store.set(`${DRAFT_KEY}:attempt`, attempt);
    posting = true;
    pv.post.disabled = true;
    pv.status.dataset.tone = 'busy';
    pv.status.textContent = 'Posting…';
    const r = await api('/api/professor/lessons', { method: 'POST', body: { operationId: attempt.operationId, title, text, recipient: pv.student.value } }).catch(() => null);
    posting = false;
    pv.post.disabled = false;
    const status = r?.json?.ack?.status ?? (r?.json?.duplicate ? r.json.lesson?.hubStatus : null);
    const accepted = r?.ok && (r.json.ack?.accepted || (r.json.duplicate && r.json.lesson?.hubAccepted));
    if (accepted) {
      // Posted: the Hub accepted it (delivered, or queued for an offline student). Clear the draft.
      pv.status.dataset.tone = 'ok';
      pv.status.textContent = status === 'delivered' ? `Posted — delivered to ${pv.student.value}’s inbox.` : status === 'queued' ? 'Posted — queued at the Hub until the student’s agent is back.' : status === 'uncertain' ? 'Posted — the Hub is confirming delivery with the student’s agent.' : status === 'failed' ? `Posted, but the student’s agent refused it (${r.json.ack?.reason ?? 'no reason given'}).` : `Posted (${status}).`;
      pv.title.value = '';
      pv.text.value = '';
      saveDraft();
      attempt = null;
      store.set(`${DRAFT_KEY}:attempt`, null);
    } else {
      // Not posted, or not confirmed: keep the draft (and the operation id, so a retry can't duplicate).
      pv.status.dataset.tone = 'bad';
      const reason = r?.json?.ack?.reason ?? Object.values(r?.json?.errors ?? {})[0] ?? r?.json?.error ?? 'no answer';
      pv.status.textContent = status === 'uncertain' || status === 'not_delivered'
        ? `Not confirmed by the Hub (${reason}). Your draft is kept — press Post lesson again to retry the same post.`
        : `Not posted: ${reason}. Your draft is kept.`;
      if (r?.status === 422 || r?.status === 400) { attempt = null; store.set(`${DRAFT_KEY}:attempt`, null); }
    }
    refreshProfessor();
  });
  setInterval(() => { if (!pv.view.hidden) refreshProfessor(); }, 4000);

  // ---- events ------------------------------------------------------------------------------------------
  refreshInbox();
  refreshProfessor();
  return {
    event({ source, type, data }, { live }) {
      if (source === 'student' && ['lesson_received', 'lesson_opened', 'course_available'].includes(type)) refreshInbox();
      if (source === 'student' && type === 'lesson_received' && live) toast(data);
      if (source === 'system' && type === 'conversation_reset') setAbout(null);
      if (/^lesson_|^course_available/.test(type) && !pv.view.hidden) refreshProfessor();
    },
    composerContext: () => (about?.deliveryId ? { lessonDeliveryId: about.deliveryId } : about?.capability ? { capability: about.capability } : {}),
    professorShown: () => refreshProfessor(),
  };
}
