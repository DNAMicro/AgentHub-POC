// Review #3 (second review): the class cancellation preview card in the Faculty view. After a time-off filing that covers
// class days, the assistant shows this card instead of a yes/no question: the EXACT text students will get (code-built by
// the Faculty agent: course, time, room, dates — never a reason), who gets it (“your 25 students”, the class size from the
// fresh class record; no names), an optional note box, and two buttons: Send to students, Don't send.
//   * The note is previewed live with the same wording the agent sends (/shared/cancel-text.js); the agent checks it
//     again and refuses a note about himself, an illness, his leave or a relative (shown here, inline; nothing is sent).
//   * Send is one operation: the operation ID is reused only when the answer was “try again”, so a retry or a double
//     click never sends twice (the agent also answers a second press of the same card with the first one's outcome).
//   * The card's element is kept in place across redraws (like the HR and quiz cards), so a half-typed note survives.
// Everything is set with textContent.
import { NOTE_MAX, cancelNoteText, withCancelNote } from '/shared/cancel-text.js';

export const CARD_TITLE = 'Class cancellation — preview';
const TITLES = { open: CARD_TITLE, sending: CARD_TITLE, sent: 'Class cancellation — sent', not_sent: 'Class cancellation — not sent' };

export function createCancelUi({ el, api, deliveryList, post, redraw }) {
  let view = null; // { id, li, ui, note, pending, busy, notice }

  function build(id) {
    const ui = {
      title: el('span', { className: 'cc-title' }),
      to: el('p', { className: 'cc-to' }),
      label: el('p', { className: 'cc-label' }),
      preview: el('div', { className: 'cc-preview' }),
      noteLabel: el('label', { className: 'cc-note-label', htmlFor: `cc-note-${id}`, textContent: 'Add a note for your students (optional)' }),
      note: el('textarea', { className: 'cc-note', id: `cc-note-${id}`, rows: 2, placeholder: 'For example, a makeup plan or what to read' }),
      count: el('span', { className: 'cc-count' }),
      notice: el('p', { className: 'cc-notice', role: 'status', hidden: true }),
      send: el('button', { type: 'button', className: 'cc-send btn-primary', textContent: 'Send to students' }),
      decline: el('button', { type: 'button', className: 'cc-decline btn-link', textContent: 'Don’t send' }),
      result: el('p', { className: 'cc-result', hidden: true }),
      deliveries: el('div', { className: 'cc-deliveries' }),
    };
    ui.noteBox = el('div', { className: 'cc-note-box' }, ui.noteLabel, ui.note, ui.count);
    ui.actions = el('div', { className: 'cc-actions' }, ui.send, ui.decline);
    const li = el('li', { className: 'msg cancel-card', dataset: { dir: 'received', speaker: 'professor', card: id } },
      el('div', { className: 'msg-head' }, ui.title),
      ui.to,
      ui.label,
      ui.preview, ui.noteBox, ui.notice, ui.actions, ui.result, ui.deliveries);
    const v = { id, li, ui, note: '', pending: null, busy: null, notice: null, card: null };
    ui.note.addEventListener('input', () => { v.note = ui.note.value; v.notice = null; fill(v); });
    ui.send.addEventListener('click', () => act(v, 'send'));
    ui.decline.addEventListener('click', () => act(v, 'decline'));
    return v;
  }

  const recipients = (count) => (Number.isInteger(count) && count > 0 ? `your ${count} ${count === 1 ? 'student' : 'students'} (class roster)` : 'your class roster');

  function fill(v) {
    const c = v.card;
    if (!c) return;
    const { ui } = v;
    const status = v.busy === 'send' ? 'sending' : c.status;
    v.li.dataset.status = status;
    ui.title.textContent = TITLES[status] ?? CARD_TITLE;
    ui.to.replaceChildren('To: ', el('b', { textContent: recipients(c.count) }));
    const open = status === 'open' || status === 'sending';
    const sentPost = c.postKey ? post(c.postKey) : null;
    // Open: the code-built text plus his note as students would read it. Sent: what really went out.
    ui.label.textContent = c.status === 'sent' ? 'What your students got' : c.status === 'not_sent' ? 'What was not sent' : 'What your students will get';
    ui.preview.textContent = !open && sentPost ? sentPost.text : withCancelNote(c.text, c.professorName, open ? cancelNoteText(v.note) : null);
    ui.noteBox.hidden = !open;
    ui.actions.hidden = !open;
    ui.note.disabled = Boolean(v.busy);
    const max = c.noteMax ?? NOTE_MAX;
    const len = cancelNoteText(v.note)?.length ?? 0;
    ui.count.textContent = `${len} / ${max}`;
    ui.count.dataset.over = String(len > max);
    ui.send.disabled = Boolean(v.busy);
    ui.decline.disabled = Boolean(v.busy);
    ui.send.textContent = v.busy === 'send' ? 'Sending…' : 'Send to students';
    // Inline problems: his note refused, the class list unavailable, the class details changed (the agent's words).
    const notice = v.notice ?? (open && c.problem ? { kind: 'warn', text: c.problem } : null);
    ui.notice.hidden = !notice;
    ui.notice.dataset.kind = notice?.kind ?? '';
    ui.notice.textContent = notice?.text ?? '';
    ui.result.hidden = open;
    ui.result.textContent = c.status === 'sent' ? (c.result ?? 'Sent.') : c.status === 'not_sent' ? 'Not sent.' : '';
    ui.deliveries.replaceChildren(...(c.status === 'sent' && sentPost?.deliveries?.length ? [deliveryList(sentPost.deliveries, sentPost.key)] : []));
  }

  async function act(v, action) {
    if (v.busy || v.card?.status !== 'open') return;
    const note = action === 'send' ? v.note : undefined;
    const key = JSON.stringify([action, note ?? null]);
    if (v.pending?.key !== key) v.pending = { key, operationId: `op-${crypto.randomUUID()}` };
    v.busy = action;
    v.notice = null;
    fill(v);
    const body = { cardId: v.id, operationId: v.pending.operationId, action, ...(note !== undefined && note.trim() ? { note } : {}) };
    const r = await api('/api/professor/cancel/actions', { method: 'POST', body }).catch(() => null);
    v.busy = null;
    const json = r?.json ?? {};
    if (!r) v.notice = { kind: 'warn', text: 'Couldn’t reach the server. Press the button again — it won’t send twice.' };
    else if (json.ok) { v.pending = null; v.local = true; v.card = { ...v.card, status: json.status, ...(json.status === 'sent' ? { result: json.text } : {}) }; }
    else {
      const retry = r.status === 503 || r.status === 502 || json.retryable || json.busy;
      if (!retry) v.pending = null;
      if (json.closed && json.status) { v.local = true; v.card = { ...v.card, status: json.status, ...(json.status === 'sent' ? { result: json.text } : {}) }; }
      else v.notice = { kind: json.code === 'note_private' || json.code === 'note_too_long' ? 'bad' : 'warn', text: json.text ?? json.errors?._form ?? json.error ?? `Not sent (HTTP ${r.status}).` };
    }
    fill(v);
    redraw();
  }

  return {
    // The card for this chat entry, or null (the page then draws nothing for it: the card is gone after a restart).
    entry(card) {
      if (!card) return null;
      if (view?.id !== card.id) view = build(card.id);
      // The server's state wins, except while this page is waiting for its own answer (and until the state catches up
      // with an outcome this page already has).
      if (card.status !== 'open') view.local = false;
      if (!view.busy && !view.local) view.card = card;
      fill(view);
      return view.li;
    },
    kept: () => (view ? [view.li] : []),
    // The state has no card (a reset) or another one: forget this one, its note too.
    sync(card) { if (!card || card.id !== view?.id) view = null; },
  };
}
