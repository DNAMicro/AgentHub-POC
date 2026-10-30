// Part 6: forms in the Student's chat. A form appears only because an agent sent one in reply to a
// chat message; it's drawn by the official A2UI v0.9 renderer from the received description, as a
// chat item at the point it arrived. Once submitted, that item becomes a read-only summary of what the
// student sent, and the agent's reply follows it as the next message (rendered by app.js).
//
// Lifecycle (owned by the UI server, mirrored here from its events):
//   editing → submitting → accepted | rejected | confirmation_pending;  editing → cancelled | superseded
// On a valid Submit/Confirm the editable surface is removed at once (A2UI deleteSurface, renderer
// disposes it) and replaced by a status line; it is never shown again unless the student explicitly
// chooses "Edit and retry" after a known rejection. History replay reconstructs the CURRENT state.
import { MessageProcessor, basicCatalog } from './vendor/a2ui.js';
import { A2UI_VERSION, ROOMS, WORKFLOWS, prettyDate, validateBookingCriteria, validateFinal } from '/shared/forms.js';

const LOOKUP_FIELDS = ['date', 'room', 'duration', 'groupSize'];
const FIELD_LABELS = { preferredDate: 'preferred date', period: 'time of day', specificTime: 'specific time', date: 'date', groupSize: 'group size', duration: 'duration' };
const STATE_TEXT = {
  editing: 'Waiting for you', submitting: 'Sending…', accepted: 'Sent ✓', rejected: 'Not accepted',
  confirmation_pending: 'Confirmation pending', cancelled: 'Cancelled', superseded: 'Superseded', refused: 'Refused',
};

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
const dl = (entries) => el('dl', { className: 'ids' }, ...entries.filter(([, v]) => v !== undefined && v !== null && v !== '').flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: String(v) })]));
const errorList = (errors) => Object.values(errors ?? {}); // each message names its own field
const button = (text, onClick, className = 'inline-action') => {
  const b = el('button', { type: 'button', className, textContent: text });
  b.addEventListener('click', () => {
    b.disabled = true;
    onClick(b);
  });
  return b;
};

const shortTime = (iso) => new Date(iso ?? Date.now()).toLocaleTimeString([], { hour12: false });
const one = (v) => (Array.isArray(v) ? v[0] : v);

// pinToBottom(): bring the chat to its newest item (used when the student's own action moves a form to
// the bottom). Ordinary growth is followed by the chat's own bottom-follower in app.js.
export function createFormsUi({ log, agentName = (id) => id, onChange = () => {}, pinToBottom = () => {} }) {
  const views = new Map(); // formId → view
  let replaying = false;
  const scroll = () => pinToBottom();

  // ---- the chat item ---------------------------------------------------------------------------

  function card(view) {
    const wf = WORKFLOWS[view.workflowId];
    view.label = el('span', { className: 'msg-dir' });
    view.time = el('time', { dateTime: view.at ?? '', textContent: shortTime(view.at) });
    view.badge = el('span', { className: 'form-state' });
    view.intro = el('p', { className: 'msg-text', textContent: view.text || wf?.title || 'Form' });
    view.body = el('div', { className: 'form-body' });
    view.notice = el('div', { className: 'notice', role: 'status' });
    view.details = el('details', {}, el('summary', { textContent: 'IDs' }));
    view.card = el('li', { className: 'msg form-card', ariaLabel: wf?.title ?? 'Form' },
      el('div', { className: 'msg-head' }, view.label, el('span', { className: 'form-head-right' }, view.badge, view.time)),
      view.intro, view.body, view.notice, view.details);
    role(view, 'received');
    log.append(view.card);
  }
  // received: the agent's form; sent: what the student submitted (the agent's reply follows it).
  function role(view, dir) {
    view.card.dataset.dir = dir;
    view.card.dataset.speaker = dir === 'sent' ? 'student' : view.agentId;
    view.label.textContent = dir === 'sent' ? `You sent: ${WORKFLOWS[view.workflowId]?.title ?? 'form'}` : agentName(view.agentId);
    view.intro.hidden = dir === 'sent';
  }
  // A read-only summary of what was submitted.
  function summary(view, values) {
    if (!values) return el('p', { className: 'form-status', textContent: 'Submitted.' });
    const list = summaryList(view, values);
    list.className = 'values';
    return list;
  }
  function summaryList(view, values) {
    // Part 8: a generated loan surface — the loan's title as the surface showed it, and the chosen date.
    if (view.workflowId === 'loan-renewal') {
      const texts = view.a2uiMessages.flatMap((m) => m.updateComponents?.components ?? []).filter((c) => c.component === 'Text' && typeof c.text === 'string').map((c) => c.text);
      const title = texts.find((t) => t.includes(values.loanId)) ?? null;
      return dl([['Loan', title ? `${values.loanId} — ${title}` : values.loanId], ['New return date', values.returnDate && prettyDate(String(values.returnDate).slice(0, 10))]]);
    }
    const name = `${values.firstName ?? ''} ${values.lastName ?? ''}`.trim();
    if (view.workflowId === 'tutoring-request') {
      return dl([['Name', name], ['Email', values.email], ['Preferred date', values.preferredDate && prettyDate(String(values.preferredDate).slice(0, 10))],
        ['Time of day', one(values.period)], ['Specific time', values.specificTime || 'none'], ['Help with', values.notes]]);
    }
    const slotId = one(values.slot);
    const options = view.updates.flatMap((m) => m.updateComponents?.components ?? []).filter((c) => c.id === 'slot').flatMap((c) => c.options);
    return dl([['Name', name], ['Email', values.email], ['Group size', values.groupSize], ['Room', ROOMS.find((r) => r.id === one(values.room))?.name ?? one(values.room)],
      ['Date', values.date && prettyDate(String(values.date).slice(0, 10))], ['Time', options.findLast((o) => o.value === slotId)?.label ?? slotId]]);
  }
  // Edit and retry keeps the chat in order: a record of the failed attempt stays where it was, and
  // the reopened form moves to the bottom, after the agent's reply. Driven by the server's
  // "editing (restored)" event, so a replay after a reload rebuilds the same order.
  function reopenAtBottom(view, at, badge = 'Not accepted') {
    const record = el('li', { className: 'msg form-card', dataset: { dir: 'sent', state: 'rejected', speaker: 'student' } },
      el('div', { className: 'msg-head' }, el('span', { className: 'msg-dir', textContent: `You sent: ${WORKFLOWS[view.workflowId]?.title ?? 'form'}` }), el('span', { className: 'form-state', textContent: badge })),
      el('div', { className: 'form-body' }, summary(view, view.submitted ?? view.snapshot)));
    view.card.before(record);
    view.time.textContent = shortTime(at);
    log.append(view.card);
    scroll();
  }
  // Flags from the agent's review, with the choice to send the same values anyway.
  function showFlags(view) {
    const wf = WORKFLOWS[view.workflowId];
    const final = wf.actions[wf.finalAction];
    notice(view, 'warn', ['The agent asks you to check before it records this. Nothing was recorded yet:', ...(view.reviewFlags ?? []).map((f) => f.message), 'Edit the form and send again, or send it as it is.'],
      button('Send anyway', async (b) => {
        if (view.state !== 'editing' || !view.processor) return;
        const context = structuredClone(view.submitted ?? view.snapshot ?? {});
        view.snapshot = context;
        unmount(view);
        showSent(view, wf.pendingText);
        notice(view, 'info', []);
        const sent = await post(view, { name: wf.finalAction, surfaceId: view.formId, sourceComponentId: final.button, timestamp: new Date().toISOString(), context }, { acknowledgeReview: true });
        if (!sent.ok) {
          b.disabled = false;
          restore(view, sent.errors ? ['Not sent:', ...errorList(sent.errors)] : [`Not sent: ${sent.error}`]);
        }
      }));
  }
  function showSent(view, statusText) {
    role(view, 'sent');
    view.body.replaceChildren(summary(view, view.submitted ?? view.snapshot), ...(statusText ? [el('p', { className: 'form-status', textContent: statusText })] : []));
  }
  function renderIds(view) {
    view.details.replaceChildren(el('summary', { textContent: 'IDs' }), dl([
      ['form / surface', view.formId], ['workflow', view.workflowId], ['issued by', view.agentId], ['form version', view.formVersion],
      ['A2A task', view.taskId], ['A2A context', view.contextId], ['last operation', view.operationId], ['receipt', view.receipt ? (view.receipt.requestId ?? view.receipt.bookingId ?? view.receipt.renewalId) : null],
    ]));
  }
  function setState(view, state) {
    view.state = state;
    view.card.dataset.state = state;
    // A generated surface with no buttons is an overview: nothing waits for the student.
    const readOnly = state === 'editing' && !view.a2uiMessages?.some((m) => m.updateComponents?.components?.some((c) => c.component === 'Button'));
    view.card.dataset.readOnly = String(readOnly);
    view.badge.textContent = readOnly ? 'Read-only' : STATE_TEXT[state] ?? state;
    renderIds(view);
    onChange();
  }
  function notice(view, kind, lines, ...extra) {
    view.notice.dataset.kind = kind;
    view.notice.replaceChildren(...[].concat(lines).filter(Boolean).map((t) => el('p', { textContent: t })), ...extra);
  }
  const status = (view, text, ...extra) => view.body.replaceChildren(el('p', { className: 'form-status', textContent: text }), ...extra);

  // ---- mount / unmount the A2UI surface ------------------------------------------------------

  function mount(view, values = null) {
    if (view.processor) return;
    const processor = new MessageProcessor([basicCatalog], (action) => onAction(action));
    // The renderer adopts values by reference and mutates them: always hand it copies.
    processor.processMessages(structuredClone(view.a2uiMessages));
    if (view.updates.length) processor.processMessages(structuredClone(view.updates));
    const surface = processor.model.getSurface(view.formId);
    if (values) for (const [k, v] of Object.entries(values)) surface.dataModel.set(`/form/${k}`, structuredClone(v));
    const surfaceEl = el('a2ui-surface', { className: 'form-surface' });
    surfaceEl.surface = surface;
    view.processor = processor;
    view.surface = surface;
    view.subs = [];
    view.body.replaceChildren(surfaceEl);
    // Study rooms: changing date, room, duration or group size invalidates the chosen slot at once
    // and refreshes availability from the Library (scheduling fields only).
    if (view.workflowId === 'study-room-booking') {
      for (const f of LOOKUP_FIELDS) view.subs.push(surface.dataModel.subscribe(`/form/${f}`, () => criteriaChanged(view)));
    }
  }
  function unmount(view) {
    if (!view.processor) return;
    clearTimeout(view.lookupTimer);
    for (const s of view.subs) s.unsubscribe();
    // The standard A2UI v0.9 removal: the renderer deletes and disposes the surface and its handlers.
    view.processor.processMessages([{ version: A2UI_VERSION, deleteSurface: { surfaceId: view.formId } }]);
    view.processor = null;
    view.surface = null;
    view.subs = [];
    view.body.replaceChildren();
  }
  const lock = (view, locked) => view.surface?.dataModel.set('/ui/submitLocked', locked);

  // ---- actions from the renderer -------------------------------------------------------------

  async function post(view, action, { acknowledgeReview = false } = {}) {
    const operationId = crypto.randomUUID();
    const { name, surfaceId, sourceComponentId, timestamp, context } = action;
    const res = await fetch(`/api/forms/${encodeURIComponent(view.formId)}/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, action: { name, surfaceId, sourceComponentId, timestamp, context }, ...(acknowledgeReview ? { acknowledgeReview: true } : {}) }),
    }).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
    if (res.ok) return { ok: true, operationId };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, errors: body.errors, error: body.error ?? `HTTP ${res.status}` };
  }

  // The renderer's button events. Typing never reaches here — only Button actions (and the
  // availability refresh below) send anything.
  async function onAction(action) {
    const view = views.get(action.surfaceId);
    // A delayed event from a closed or replaced form can't reactivate it.
    if (!view || view.state !== 'editing' || !view.processor) return;
    const wf = WORKFLOWS[view.workflowId];
    const spec = wf.actions[action.name];
    if (!spec || view.busy) return;

    if (spec.final || action.name === 'reviewBooking') {
      view.surface.dataModel.set('/ui/submitAttempted', true); // reveals the renderer's inline errors
      const check = validateFinal(view.workflowId, action.context);
      if (!check.ok) return notice(view, 'bad', ['Please fix these before continuing. Nothing was sent.', ...errorList(check.errors)]);
    }
    if (spec.final) {
      // Keep a recoverable snapshot, remove the editable form at once, show only a status line.
      view.snapshot = structuredClone(action.context);
      unmount(view);
      showSent(view, wf.pendingText);
      notice(view, 'info', []);
      const sent = await post(view, action);
      if (!sent.ok) restore(view, sent.errors ? ['Not sent:', ...errorList(sent.errors)] : [`Not sent: ${sent.error}`]);
      return;
    }
    if (spec.cancel) {
      unmount(view);
      status(view, 'Cancelled — nothing was submitted.');
      const sent = await post(view, action);
      if (!sent.ok) notice(view, 'bad', `Couldn’t record the cancellation: ${sent.error}`);
      return;
    }
    // Lookup / review / back to edit: the form stays; buttons are locked until the agent answers.
    view.busy = true;
    lock(view, true);
    notice(view, 'info', action.name === 'reviewBooking' ? 'Checking your booking…' : action.name === 'checkAvailability' ? 'Checking demo availability…' : '');
    const sent = await post(view, action);
    if (!sent.ok) {
      view.busy = false;
      lock(view, false);
      notice(view, 'bad', sent.errors ? errorList(sent.errors) : `Not sent: ${sent.error}`);
    }
  }

  // Reopen with the snapshot after a known failure the browser itself saw (e.g. HTTP 400/409).
  function restore(view, lines) {
    if (view.state === 'submitting') return; // the server took it; its lifecycle events decide
    role(view, 'received');
    mount(view, view.snapshot);
    notice(view, 'bad', lines);
  }

  function criteriaChanged(view) {
    if (!view.surface || view.state !== 'editing') return;
    const slot = view.surface.dataModel.get('/form/slot');
    if (Array.isArray(slot) && slot.length) view.surface.dataModel.set('/form/slot', []);
    clearTimeout(view.lookupTimer);
    view.lookupTimer = setTimeout(() => {
      if (!view.surface || view.busy) return;
      const context = Object.fromEntries(LOOKUP_FIELDS.map((f) => [f, structuredClone(view.surface.dataModel.get(`/form/${f}`))]));
      const check = validateBookingCriteria(context);
      if (!check.ok) {
        // Say why no times are shown once all four are filled in (e.g. group too big for the room).
        const filled = LOOKUP_FIELDS.every((f) => (Array.isArray(context[f]) ? context[f].length : String(context[f] ?? '').trim()));
        notice(view, filled ? 'bad' : 'info', filled ? ['No times shown yet:', ...errorList(check.errors)] : []);
        return;
      }
      onAction({ name: 'checkAvailability', surfaceId: view.formId, sourceComponentId: 'check_button', timestamp: new Date().toISOString(), context });
    }, 500);
  }

  // ---- events from the UI server ---------------------------------------------------------------

  return {
    // Part 11: the open forms' current values, for the next chat run's AG-UI state (the Student agent
    // checks a fill against them). Only forms the student can still edit.
    openValues() {
      const out = {};
      for (const view of views.values()) {
        if (view.state !== 'editing' || !view.surface) continue;
        out[view.formId] = { workflowId: view.workflowId, values: structuredClone(view.surface.dataModel.get('/form') ?? {}) };
      }
      return out;
    },
    // Part 11: the Student agent filled fields from the chat — standard A2UI updateDataModel messages.
    fill(formId, updates, note) {
      const view = views.get(formId);
      if (!view?.processor || view.state !== 'editing') return false;
      if (updates?.length) view.processor.processMessages(structuredClone(updates));
      if (note) notice(view, 'info', note);
      return true;
    },
    get busy() {
      return [...views.values()].some((v) => v.state === 'submitting');
    },
    setReplaying(value) {
      replaying = value;
    },
    // Called once history has been replayed: show each form as it is NOW.
    replayDone() {
      replaying = false;
      for (const view of views.values()) {
        if (view.state !== 'editing' || view.processor) continue;
        // A form reopened for correction comes back with the values that were sent.
        mount(view, view.restoreValues ?? null);
        view.restoreValues = null;
        if (view.reviewFlags?.length) showFlags(view);
      }
    },

    received(data) {
      if (views.has(data.formId)) return; // the same form again (retry/replay): never a second copy
      const view = { ...data, updates: [], state: null, processor: null, surface: null, subs: [], busy: false };
      views.set(data.formId, view);
      card(view);
      setState(view, data.lifecycle ?? 'editing');
      if (view.state === 'editing') {
        if (data.prefilled?.length) notice(view, 'info', `Filled in from your message: ${data.prefilled.map((f) => FIELD_LABELS[f] ?? f).join(', ')}. You can change ${data.prefilled.length > 1 ? 'them' : 'it'}.`);
        if (!replaying) mount(view);
      } else if (view.state === 'superseded') {
        status(view, 'Not shown: you already have an open form for this. Continue with that one, or ask to replace it.');
      } else {
        status(view, data.refusedReason ?? 'Not shown.');
      }
    },

    lifecycle(data) {
      const view = views.get(data.formId);
      if (!view) return;
      if (data.operationId) view.operationId = data.operationId;
      setState(view, data.state);
      const wf = WORKFLOWS[view.workflowId];
      switch (data.state) {
        case 'editing':
          if (data.restored) reopenAtBottom(view, data.at, data.review ? 'Needs a check' : 'Not accepted');
          // Reopened for correction: the values that were sent come back with it.
          if (data.values) view.restoreValues = data.values;
          if (data.review) {
            // The agent's review flagged something. Nothing was recorded; the student edits or sends anyway.
            view.submitted = data.values ?? view.submitted;
            view.reviewFlags = data.flags ?? [];
          } else {
            view.reviewFlags = [];
          }
          role(view, 'received');
          // During a replay the form is drawn at the end (replayDone) — keep the values until then.
          if (!replaying && !view.processor) {
            mount(view, view.restoreValues ?? null);
            view.restoreValues = null;
          }
          if (data.review) showFlags(view);
          break;
        case 'submitting':
          unmount(view);
          if (data.submitted) view.submitted = data.submitted;
          showSent(view, data.reconcile ? 'Checking the outcome…' : wf.pendingText);
          break;
        case 'accepted':
          unmount(view);
          view.receipt = data.receipt ?? null;
          showSent(view, null); // the agent's confirmation follows as the next chat message
          notice(view, 'info', []);
          renderIds(view);
          break;
        case 'rejected':
          unmount(view);
          showSent(view, data.conflict ? 'That time was just taken, so nothing was booked.' : data.notDelivered ? 'Not delivered.' : 'Not accepted.');
          notice(view, 'bad', errorList(data.errors), button(data.conflict ? 'Choose another time' : 'Edit and retry', () => editAndRetry(view, Boolean(data.conflict))));
          break;
        case 'confirmation_pending':
          unmount(view);
          showSent(view, 'Confirmation pending.');
          notice(view, 'warn', 'No reply in time — the agent may or may not have recorded it. “Check status” asks again with the same operation ID, so it is recorded at most once.',
            button('Check status', async (b) => {
              const res = await fetch(`/api/forms/${encodeURIComponent(view.formId)}/reconcile`, { method: 'POST' });
              if (!res.ok) {
                b.disabled = false;
                notice(view, 'bad', (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
              }
            }));
          break;
        case 'cancelled':
          unmount(view);
          role(view, 'sent');
          view.label.textContent = `You cancelled: ${WORKFLOWS[view.workflowId]?.title ?? 'form'}`;
          status(view, data.reason === 'new_conversation' ? 'Closed — a new conversation was started. Nothing was submitted.' : 'Cancelled — nothing was submitted.');
          notice(view, 'info', []);
          break;
        case 'superseded':
          unmount(view);
          status(view, 'Superseded — replaced by a newer form.');
          notice(view, 'info', []);
          break;
      }
    },

    // Results of non-final actions (availability, review, back to edit) update the live surface.
    actionResult(data) {
      const view = views.get(data.formId);
      if (!view) return;
      const update = (data.a2uiUpdate ?? []).filter((m) => !m.deleteSurface);
      view.updates.push(...update);
      if (WORKFLOWS[view.workflowId]?.actions[data.actionName]?.final || data.actionName === 'cancelForm') return;
      view.busy = false;
      if (view.processor && view.state === 'editing') {
        // A lookup answer can arrive after the student already picked a time from the list on screen.
        // Keep that pick if the new availability still offers it (same time → same slot ID); otherwise it's cleared.
        const picked = view.surface.dataModel.get('/form/slot');
        if (update.length) view.processor.processMessages(structuredClone(update));
        if (data.actionName === 'checkAvailability' && Array.isArray(picked) && picked.length) {
          const offered = update.flatMap((m) => m.updateComponents?.components ?? []).filter((c) => c.id === 'slot').flatMap((c) => c.options.map((o) => o.value));
          if (offered.includes(picked[0])) view.surface.dataModel.set('/form/slot', [picked[0]]);
        }
        lock(view, false);
        const status = data.body?.status;
        if (status === 'rejected') notice(view, 'bad', errorList(data.body.errors));
        else notice(view, 'info', data.body?.message && data.actionName !== 'editBooking' ? data.body.message : []);
      }
    },
    actionFailed(data) {
      const view = views.get(data.formId);
      if (!view || WORKFLOWS[view.workflowId]?.actions[data.actionName]?.final) return;
      view.busy = false;
      lock(view, false);
      if (view.state === 'editing') notice(view, 'bad', `Couldn’t reach the agent: ${data.error}`);
    },

    // The log itself is emptied by app.js (New conversation); this releases the renderers.
    clear() {
      for (const view of views.values()) unmount(view);
      views.clear();
    },
  };

  // "Edit and retry": the server reopens the form and returns the saved values (and any updates,
  // e.g. refreshed slots after a conflict). A conflict requires choosing a new time.
  async function editAndRetry(view, conflict) {
    const res = await fetch(`/api/forms/${encodeURIComponent(view.formId)}/edit`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return notice(view, 'bad', body.error ?? `HTTP ${res.status}`);
    view.updates = body.updates ?? view.updates;
    const values = { ...(body.values ?? view.snapshot ?? {}) };

    if (conflict) values.slot = [];
    // The lifecycle event ('editing') may arrive before or after this response; mount once with values.
    if (view.processor) {
      for (const [k, v] of Object.entries(values)) view.surface.dataModel.set(`/form/${k}`, structuredClone(v));
    } else if (view.state === 'editing') {
      mount(view, values);
    } else {
      view.restoreValues = values;
    }
    notice(view, 'info', conflict ? 'Choose another available time, review, then confirm.' : 'Your values are restored. Fix them and send again.');
  }
}
