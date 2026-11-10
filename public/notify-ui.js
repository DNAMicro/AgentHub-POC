// The student lets their instructor know (owner, 2026-11-09; mockup docs/superpowers/specs/2026-11-09-student-notify-mockup.html):
// the Student agent's “Who would you like me to let know?” with tap buttons, and the message card that sends the student's
// words to the instructor. Native elements, textContent only. The server owns the card's state (notify_card events, replayed
// after a reload); the card's element is updated in place, and the box keeps what the student typed while it is open.
export function createNotifyUi({ log, append, item, ask, send, decline }) {
  const node = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    n.append(...kids.filter((k) => k !== null && k !== undefined));
    return n;
  };
  // Only the newest question's buttons work; an answer (typed or tapped) closes the older ones.
  function closeChoices() {
    for (const b of log.querySelectorAll('.notify-choices button')) b.disabled = true;
  }

  // notify_step: the student's own words (held by the Student agent, not sent) and, when there is one, its question or answer.
  function step({ at, data, run }) {
    closeChoices();
    append(item({ at, dir: 'sent', speaker: 'student', label: 'You', text: data.question, ids: { note: 'Kept by your Student agent — nothing was sent to the university.', run } }));
    if (!data.text) return;
    const li = item({ at, dir: 'received', speaker: 'student', label: 'Your Student agent', text: data.text, ids: { note: 'Asked by your Student agent — nothing was sent to the university.', run } });
    if (data.choices?.length) {
      const row = node('div', { className: 'notify-choices', role: 'group', 'aria-label': 'Who should know' });
      for (const c of data.choices) {
        const b = node('button', { type: 'button', className: c.id === 'cancel' ? 'notify-choice ghost' : 'notify-choice', textContent: c.label });
        b.dataset.choice = c.id;
        b.addEventListener('click', async () => {
          closeChoices();
          if (!(await ask(c.label))) for (const x of row.querySelectorAll('button')) x.disabled = false;
        });
        row.append(b);
      }
      li.insertBefore(row, li.querySelector('details'));
    }
    append(li);
  }

  // notify_card: create the card once, then redraw it in place for every state.
  function card({ data }) {
    let li = log.querySelector(`li.notify-card[data-card="${CSS.escape(data.cardId)}"]`);
    if (!li) {
      li = node('li', { className: 'notify-card' });
      li.dataset.card = data.cardId;
      const box = node('textarea', { className: 'nc-text', id: `nc-${data.cardId}`, maxLength: data.max, rows: 3 });
      box.value = data.text ?? '';
      const count = node('span', { className: 'nc-count' });
      const countNow = () => { count.textContent = `${box.value.length} / ${data.max}`; };
      box.addEventListener('input', countNow);
      countNow();
      const sendBtn = node('button', { type: 'button', className: 'nc-send', textContent: 'Send' });
      const noBtn = node('button', { type: 'button', className: 'nc-decline link', textContent: 'Don’t send' });
      const problem = node('p', { className: 'nc-problem', role: 'status' });
      sendBtn.addEventListener('click', async () => {
        const text = box.value.trim();
        if (!text) { problem.textContent = 'Write a message first.'; problem.hidden = false; box.focus(); return; }
        sendBtn.disabled = true; noBtn.disabled = true;
        const err = await send(data.cardId, text);
        if (err) { problem.textContent = err; problem.hidden = false; sendBtn.disabled = false; noBtn.disabled = false; }
      });
      noBtn.addEventListener('click', async () => {
        sendBtn.disabled = true; noBtn.disabled = true;
        const err = await decline(data.cardId);
        if (err) { problem.textContent = err; problem.hidden = false; sendBtn.disabled = false; noBtn.disabled = false; }
      });
      li.append(
        node('div', { className: 'nc-title', textContent: 'Message to your instructor' }),
        node('div', { className: 'nc-to' }, 'To: ', node('b', { textContent: data.to }), ` · ${data.course}`),
        node('label', { className: 'nc-label', htmlFor: box.id, textContent: 'Your message — edit it or add more' }),
        box,
        node('div', { className: 'nc-meta' }, node('span', { textContent: `Only ${data.to} will see this — not your classmates.` }), count),
        node('div', { className: 'nc-sent' }),
        problem,
        node('div', { className: 'nc-actions' }, sendBtn, noBtn),
        node('span', { className: 'nc-result' }),
      );
      append(li);
      if (data.status === 'open') box.focus({ preventScroll: true });
    }
    li.dataset.status = data.status;
    const box = li.querySelector('.nc-text');
    const sendBtn = li.querySelector('.nc-send');
    const noBtn = li.querySelector('.nc-decline');
    const problem = li.querySelector('.nc-problem');
    const sent = li.querySelector('.nc-sent');
    const result = li.querySelector('.nc-result');
    const editing = data.status === 'open';
    // While it is open the box keeps the student's own edits; once sent (or stopped) it shows exactly what went.
    if (!editing) sent.textContent = data.text ?? '';
    box.hidden = !editing; li.querySelector('.nc-label').hidden = !editing; li.querySelector('.nc-meta').hidden = !editing;
    sent.hidden = editing;
    li.querySelector('.nc-actions').hidden = !['open', 'sending', 'unsure'].includes(data.status);
    sendBtn.textContent = data.status === 'sending' ? 'Sending…' : data.status === 'unsure' ? 'Send again' : 'Send';
    sendBtn.disabled = data.status === 'sending';
    noBtn.hidden = data.status !== 'open';
    noBtn.disabled = false;
    problem.textContent = data.problem ?? '';
    problem.hidden = !data.problem;
    result.textContent = data.status === 'sent' ? '✓ Sent' : data.status === 'not_sent' ? 'Not sent' : '';
    result.hidden = !result.textContent;
  }
  return { step, card, closeChoices };
}
