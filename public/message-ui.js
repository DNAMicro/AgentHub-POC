// Review E (second video review, owner 2026-11-06: “yes so its confirmed before its sent”): the MESSAGE PREVIEW CARD in the
// Faculty view. Every message to students waits here until he presses Send: the exact text (editable), who gets it
// (“To: your 10 seniors”, “To: all 25 students in Marketing 351” — a description and a count from the state; names only
// through “Show names”, fetched from the Faculty-view-only route), and two buttons, Send and Don't send.
//   * A draft written from his instruction is labelled “Written by your assistant from your instruction” until he edits it.
//   * Nothing to say yet: the box is empty with the question (“What should your 10 seniors get?”); Send stays off.
//   * Nobody matches: the card says so and has no Send.
//   * Send is one operation: the operation ID is reused only when the answer was “try again”, so a retry or a double click
//     never sends twice (the agent also answers a second press of the same card with the first one's outcome).
//   * The card's element is kept in place across redraws (like the HR, quiz and cancellation cards), so a half-typed edit
//     survives; its text travels with a typed “yes” in the chat (draftText).
// The look follows the cancellation preview card (public/cancel-ui.js). Everything is set with textContent.
const TITLES = { open: 'Message — preview', sending: 'Message — preview', sent: 'Message — sent', not_sent: 'Message — not sent' };
const MAX = 1000;

export function createMessageUi({ el, api, deliveryList, post, redraw, isShowing }) {
  let view = null; // { id, li, ui, text, base, pending, busy, notice, card, names, showNames, local }

  function build(id) {
    const ui = {
      title: el('span', { className: 'cc-title' }),
      to: el('p', { className: 'cc-to mc-to' }),
      names: el('p', { className: 'mc-names', hidden: true }),
      label: el('p', { className: 'cc-label' }),
      origin: el('p', { className: 'mc-origin', hidden: true }),
      prompt: el('p', { className: 'mc-prompt', hidden: true }),
      box: el('textarea', { className: 'cc-note mc-text', id: `mc-text-${id}`, rows: 3, ariaLabel: 'The message your students will get' }),
      count: el('span', { className: 'cc-count' }),
      sent: el('div', { className: 'cc-preview mc-sent', hidden: true }),
      notice: el('p', { className: 'cc-notice', role: 'status', hidden: true }),
      send: el('button', { type: 'button', className: 'cc-send btn-primary mc-send', textContent: 'Send' }),
      decline: el('button', { type: 'button', className: 'cc-decline btn-link mc-decline', textContent: 'Don’t send' }),
      result: el('p', { className: 'cc-result', hidden: true }),
      deliveries: el('div', { className: 'cc-deliveries' }),
      toggle: el('button', { type: 'button', className: 'btn-link mc-show-names', textContent: 'Show names' }),
    };
    ui.boxWrap = el('div', { className: 'cc-note-box mc-box' }, ui.box, ui.count);
    ui.actions = el('div', { className: 'cc-actions' }, ui.send, ui.decline);
    const li = el('li', { className: 'msg cancel-card message-card', dataset: { dir: 'received', speaker: 'professor', card: id } },
      el('div', { className: 'msg-head' }, ui.title),
      el('div', { className: 'mc-to-row' }, ui.to, ui.toggle), ui.names,
      ui.label, ui.prompt, ui.boxWrap, ui.origin, ui.sent, ui.notice, ui.actions, ui.result, ui.deliveries);
    const v = { id, li, ui, text: '', base: null, pending: null, busy: null, notice: null, card: null, names: null, showNames: false, local: false };
    ui.box.addEventListener('input', () => { v.text = ui.box.value; v.notice = null; fill(v); });
    ui.send.addEventListener('click', () => act(v, 'send'));
    ui.decline.addEventListener('click', () => act(v, 'decline'));
    ui.toggle.addEventListener('click', () => { v.showNames = !v.showNames; if (v.showNames) loadNames(v); fill(v); });
    return v;
  }

  // Names only while the Faculty view shows, only for this card, never stored anywhere else.
  async function loadNames(v) {
    if (v.names || v.loadingNames || !isShowing()) return;
    v.loadingNames = true;
    const r = await api(`/api/professor/message/${v.id}/names`).catch(() => null);
    v.loadingNames = false;
    if (view !== v) return;
    v.names = r?.ok && Array.isArray(r.json?.names) ? r.json.names : null;
    fill(v);
  }
  const listOf = (xs) => (xs.length <= 1 ? xs.join('') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

  function fill(v) {
    const c = v.card;
    if (!c) return;
    const { ui } = v;
    const status = v.busy === 'send' ? 'sending' : c.status;
    const open = status === 'open' || status === 'sending';
    v.li.dataset.status = status;
    ui.title.textContent = TITLES[status] ?? TITLES.open;
    // A few students he tagged or named: their names right on the “To:” line (fetched for this tab only).
    const few = c.named && c.count > 0 && c.count <= 3;
    if (few) loadNames(v);
    ui.to.replaceChildren('To: ', el('b', { textContent: few && v.names ? listOf(v.names) : c.to }));
    ui.toggle.hidden = few || !c.count;
    ui.toggle.textContent = v.showNames ? 'Hide names' : 'Show names';
    ui.names.hidden = few || !v.showNames;
    ui.names.textContent = v.names ? v.names.join(', ') : 'Loading names…';
    const sentPost = c.postKey ? post(c.postKey) : null;
    ui.label.textContent = c.status === 'sent' ? 'What your students got' : c.status === 'not_sent' ? 'What was not sent' : c.count ? 'What your students will get' : '';
    ui.label.hidden = open && (!c.count || !v.text.trim()); // the question over an empty box says it instead
    // The box: the server's text until he edits it (a text filled from the chat replaces an unedited box).
    if (v.base !== c.text && (v.base === null || v.text === v.base)) { v.text = c.text ?? ''; ui.box.value = v.text; }
    v.base = c.text ?? '';
    const edited = v.text !== v.base;
    ui.origin.hidden = !open || !c.label || !v.text;
    ui.origin.textContent = edited ? 'Edited by you' : c.label ?? '';
    const ask = !c.count ? c.none : !v.text.trim() ? (c.prompt ?? 'What should they get?') : null;
    ui.prompt.hidden = !open || !ask;
    ui.prompt.textContent = ask ?? '';
    ui.boxWrap.hidden = !open || !c.count;
    ui.box.disabled = Boolean(v.busy);
    const len = v.text.trim().length;
    ui.count.textContent = `${len} / ${c.max ?? MAX}`;
    ui.count.dataset.over = String(len > (c.max ?? MAX));
    ui.sent.hidden = open;
    ui.sent.textContent = sentPost?.text ?? c.text ?? '';
    ui.actions.hidden = !open;
    ui.send.hidden = !c.count;
    ui.send.disabled = Boolean(v.busy) || !len || len > (c.max ?? MAX);
    ui.decline.disabled = Boolean(v.busy);
    ui.send.textContent = v.busy === 'send' ? 'Sending…' : 'Send';
    const notice = v.notice ?? (open && c.problem ? { kind: 'warn', text: c.problem } : null);
    ui.notice.hidden = !notice;
    ui.notice.dataset.kind = notice?.kind ?? '';
    ui.notice.textContent = notice?.text ?? '';
    ui.result.hidden = open;
    ui.result.textContent = c.status === 'sent' ? (c.result ?? 'Sent.') : c.status === 'not_sent' ? (c.reason ?? 'Not sent.') : '';
    ui.deliveries.replaceChildren(...(c.status === 'sent' && sentPost?.deliveries?.length ? [deliveryList(sentPost.deliveries, sentPost.key)] : []));
  }

  async function act(v, action) {
    if (v.busy || v.card?.status !== 'open') return;
    const text = action === 'send' ? v.text : undefined;
    const key = JSON.stringify([action, text ?? null]);
    if (v.pending?.key !== key) v.pending = { key, operationId: `op-${crypto.randomUUID()}` };
    v.busy = action;
    v.notice = null;
    fill(v);
    const body = { cardId: v.id, operationId: v.pending.operationId, action, ...(text !== undefined ? { text } : {}) };
    const r = await api('/api/professor/message/actions', { method: 'POST', body }).catch(() => null);
    v.busy = null;
    const json = r?.json ?? {};
    if (!r) v.notice = { kind: 'warn', text: 'Couldn’t reach the server. Press the button again — it won’t send twice.' };
    else if (json.ok) { v.pending = null; v.local = true; v.card = { ...v.card, status: json.status, ...(json.status === 'sent' ? { result: json.text, text: text ?? v.card.text } : {}) }; }
    else {
      const retry = r.status === 503 || r.status === 502 || json.retryable || json.busy;
      if (!retry) v.pending = null;
      if (json.closed && json.status) { v.local = true; v.card = { ...v.card, status: json.status, ...(json.status === 'sent' ? { result: json.text } : {}) }; }
      else v.notice = { kind: ['private', 'too_long', 'empty'].includes(json.code) ? 'bad' : 'warn', text: json.text ?? json.errors?._form ?? json.error ?? `Not sent (HTTP ${r.status}).` };
    }
    fill(v);
    redraw();
  }

  return {
    // The card for this chat entry, or null (the page then draws nothing for it: the card is gone after a restart).
    entry(card) {
      if (!card) return null;
      if (view?.id !== card.id) view = build(card.id);
      if (card.status !== 'open') view.local = false;
      if (!view.busy && !view.local) view.card = card;
      fill(view);
      return view.li;
    },
    kept: () => (view ? [view.li] : []),
    // What a typed “yes” in the chat should send: the open card's id and the text in its box right now.
    draft: () => (view?.card?.status === 'open' ? { id: view.id, text: view.text } : null),
    // The state has no card (a reset) or another one: forget this one (its edits and names too). Leaving the Faculty tab
    // drops the names (like the roster rows and the quiz key).
    sync(card) { if (!card || card.id !== view?.id) view = null; else if (!isShowing() && view) { view.names = null; view.showNames = false; } },
  };
}
