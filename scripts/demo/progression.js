// Audience demo: walks through the project's build steps (Steps/01–09) on the running app, one part at
// a time, with a title slide per part, captions, highlights and timed pauses. Everything it shows is the
// real app doing real work — live A2A messages and live model calls (each run costs a few cents).
//
// Run it with playwright-cli against the running demo (`npm run demo:live`):
//   playwright-cli -s=demo open --headed "http://127.0.0.1:4444/conversation"
//   playwright-cli -s=demo resize 1600 960
//   playwright-cli -s=demo run-code "$(cat scripts/demo/progression.js)"
//
// Options go in the query string of the address you open (read once at the start):
//   pace=1.5    stretch every pause (0.5 = twice as fast)      auto=0   wait for the presenter at every pause
//   from=5      start at Part 5   to=7   stop after Part 7     fresh=0  keep the current conversation
//   renew=1     actually renew the loan in Part 8 (changes data/library-loans.json; renewals run out)
//   tutor=http://127.0.0.1:41241   the Tutor's address for Part 1's Agent Card (another stack's port)
//   size=1600x960  set the page size        shots=/some/dir  save a screenshot at every highlight (rehearsal)
//
// Presenter keys (in the browser window): → or PageDown = next, P = hold/resume the countdown.
// The overlay lives in its own shadow root on top of the page; it never changes the app's DOM or data.
//
// ⚠ Fresh start (the default) presses New conversation, which also resets the classroom: every student's
// lessons and professor messages are cleared (Part 9). Use fresh=0 to keep them.
//
// To extend it when a new part ships: add an entry to PARTS (slide text + run function) — see Steps/README.md.
async (page) => {
  page.setDefaultTimeout(30000);
  // (run-code has no URL global: read the address through the page)
  const here = await page.evaluate(() => ({ origin: location.origin, path: location.pathname, query: Object.fromEntries(new URLSearchParams(location.search)) }));
  const opts = { get: (k) => here.query[k] ?? null };
  const BASE = here.origin.startsWith('http') ? here.origin : 'http://127.0.0.1:4444';
  const PACE = Number(opts.get('pace') ?? 1) || 1;
  const AUTO = opts.get('auto') !== '0';
  const FROM = Number(opts.get('from') ?? 0);
  const TO = Number(opts.get('to') ?? 99);
  const FRESH = opts.get('fresh') !== '0';
  const RENEW = opts.get('renew') === '1';
  const TUTOR = opts.get('tutor') ?? 'http://127.0.0.1:41241';
  const SHOTS = opts.get('shots'); // a directory: save a screenshot at every highlight (for rehearsing)
  const TYPE_MS = 32; // per character, so the audience can read along
  const problems = [];
  let shot = 0;

  // ---- presenter overlay (runs in the page) -------------------------------------------------------
  function install() {
    if (document.getElementById('demo-presenter')) return;
    const host = document.createElement('div');
    host.id = 'demo-presenter';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      .slide { position: fixed; inset: 0; display: grid; place-items: center; padding: 40px;
        background: radial-gradient(1200px 700px at 30% 20%, rgba(37,64,140,.97), rgba(9,14,32,.98)); color: #eef2ff;
        opacity: 0; transition: opacity .45s ease; }
      .slide.on { opacity: 1; pointer-events: auto; }
      .slide .inner { max-width: 1000px; width: 100%; }
      .kicker { font-size: 15px; letter-spacing: .14em; text-transform: uppercase; color: #9fb4ff; font-weight: 700; }
      .slide h1 { font-size: clamp(34px, 4.4vw, 56px); line-height: 1.08; margin: 12px 0 18px; font-weight: 800; }
      .slide .lead { font-size: clamp(18px, 1.7vw, 23px); line-height: 1.5; color: #dbe3ff; margin: 0 0 22px; max-width: 900px; }
      .slide ul { margin: 0 0 26px; padding-left: 22px; font-size: clamp(16px, 1.4vw, 20px); line-height: 1.55; color: #c9d4ff; }
      .slide li { margin: 6px 0; }
      .arch { display: inline-block; font: 600 17px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #ffe08a;
        background: rgba(255,224,138,.08); border: 1px solid rgba(255,224,138,.35); border-radius: 10px; padding: 10px 14px; margin-bottom: 26px; white-space: pre-wrap; }
      .steps { display: flex; flex-wrap: wrap; gap: 8px; }
      .step { font-size: 13px; padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(159,180,255,.35); color: #9fb4ff; }
      .step.done { background: rgba(159,180,255,.16); color: #dbe3ff; }
      .step.now { background: #ffe08a; color: #1b2340; border-color: #ffe08a; font-weight: 700; }
      .cap { position: fixed; top: 168px; right: 14px; width: min(clamp(270px, calc((100vw - 1060px) / 2 - 28px), 400px), calc(100vw - 28px)); background: rgba(14,22,48,.95); color: #eef2ff;
        border-radius: 14px; padding: 16px 18px 18px; box-shadow: 0 18px 50px rgba(0,0,0,.35); border: 1px solid rgba(159,180,255,.3);
        transform: translateY(-8px); opacity: 0; transition: opacity .3s ease, transform .3s ease; }
      .cap.left { right: auto; left: 18px; }
      .cap.bottom { top: auto; bottom: 86px; }
      .cap.on { opacity: 1; transform: none; }
      .cap .kicker { font-size: 11px; }
      .cap h3 { margin: 6px 0 8px; font-size: 19px; line-height: 1.25; }
      .cap p { margin: 0; font-size: 15px; line-height: 1.5; color: #d3dbff; white-space: pre-line; }
      .cap .status { margin-top: 12px; font-size: 13.5px; color: #ffe08a; display: none; }
      .cap .status.on { display: block; }
      .cap .status::before { content: ""; display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #ffe08a; margin-right: 8px; animation: blink 1s infinite; }
      @keyframes blink { 50% { opacity: .25; } }
      .bar { position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 10px; pointer-events: auto;
        background: rgba(14,22,48,.92); color: #dbe3ff; border-radius: 999px; padding: 7px 8px 7px 16px; font-size: 13px;
        box-shadow: 0 10px 30px rgba(0,0,0,.3); }
      .bar button { all: unset; cursor: pointer; background: rgba(159,180,255,.18); color: #eef2ff; border-radius: 999px; padding: 6px 12px; font-size: 13px; font-weight: 600; }
      .bar button:hover { background: rgba(159,180,255,.32); }
      .bar .next { background: #ffe08a; color: #1b2340; }
      .bar .count { min-width: 84px; font-variant-numeric: tabular-nums; }
      .spot { position: fixed; border: 3px solid #ffcf3f; border-radius: 12px; box-shadow: 0 0 0 4px rgba(255,207,63,.25); animation: pulse 1.6s ease-in-out infinite; }
      .spot.dim { box-shadow: 0 0 0 4px rgba(255,207,63,.25), 0 0 0 100vmax rgba(8,12,28,.38); }
      .spot span { position: absolute; left: -3px; top: -34px; background: #ffcf3f; color: #1b2340; font-size: 13.5px; font-weight: 700; padding: 5px 10px; border-radius: 8px; white-space: nowrap; }
      .spot.below span { top: auto; bottom: -34px; }
      @keyframes pulse { 50% { border-color: #fff1b8; } }
    `;
    const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const slide = h('section', 'slide');
    const cap = h('aside', 'cap');
    const bar = h('div', 'bar');
    const spots = h('div');
    root.append(style, slide, spots, cap, bar);
    const where = h('span', 'where', '');
    const count = h('span', 'count', '');
    const hold = h('button', 'hold', '⏸ Hold');
    const next = h('button', 'next', 'Next ▶');
    bar.append(where, count, hold, next);
    const ctl = { next: false, hold: false };
    next.onclick = () => { ctl.next = true; };
    hold.onclick = () => { ctl.hold = !ctl.hold; };
    const editable = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !editable(e.target))) { ctl.next = true; e.preventDefault(); }
      else if ((e.key === 'p' || e.key === 'P') && !editable(e.target)) { ctl.hold = !ctl.hold; e.preventDefault(); }
    }, true);
    document.body.append(host);
    window.__demo = {
      read() { const r = { ...ctl }; ctl.next = false; return r; },
      reset() { ctl.next = false; },
      slide(d) {
        slide.replaceChildren();
        if (!d) { slide.classList.remove('on'); return; }
        const inner = h('div', 'inner');
        inner.append(h('div', 'kicker', d.kicker), h('h1', null, d.title), h('p', 'lead', d.lead));
        if (d.bullets?.length) { const ul = h('ul'); for (const b of d.bullets) ul.append(h('li', null, b)); inner.append(ul); }
        if (d.arch) inner.append(h('div', 'arch', d.arch));
        if (d.steps) { const s = h('div', 'steps'); d.steps.forEach((t, i) => s.append(h('span', `step ${i + 1 < d.now ? 'done' : i + 1 === d.now ? 'now' : ''}`, `${i + 1} · ${t}`))); inner.append(s); }
        slide.append(inner);
        requestAnimationFrame(() => slide.classList.add('on'));
      },
      cap(d) {
        if (!d) { cap.classList.remove('on'); return; }
        cap.replaceChildren(h('div', 'kicker', d.kicker ?? ''), h('h3', null, d.title), h('p', null, d.body ?? ''), h('div', 'status'));
        cap.className = `cap ${d.at ?? ''}`;
        requestAnimationFrame(() => cap.classList.add('on'));
      },
      status(text) {
        const s = cap.querySelector('.status');
        if (!s) return;
        s.textContent = text ?? '';
        s.classList.toggle('on', Boolean(text));
      },
      bar(d) {
        where.textContent = d?.where ?? where.textContent;
        count.textContent = d?.count ?? '';
        hold.textContent = ctl.hold ? '▶ Resume' : '⏸ Hold';
      },
      spot(list) {
        spots.replaceChildren();
        for (const s of list ?? []) {
          const box = h('div', `spot ${s.dim ? 'dim' : ''} ${s.y < 60 ? 'below' : ''}`);
          Object.assign(box.style, { left: `${s.x - 6}px`, top: `${s.y - 6}px`, width: `${s.w + 12}px`, height: `${s.h + 12}px` });
          if (s.label) box.append(h('span', null, s.label));
          spots.append(box);
        }
      },
    };
  }

  // ---- presenter helpers (run in Node) -------------------------------------------------------------
  let where = '';
  async function call(fn, arg) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.evaluate(install);
        return await page.evaluate(({ fn, arg }) => window.__demo[fn](arg), { fn, arg });
      } catch { await page.waitForTimeout(300); } // the page was navigating; try again
    }
    return undefined;
  }
  async function pause(secs = 8) {
    await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {}); // so → reaches the presenter keys
    await call('reset');
    const total = secs * PACE * 1000;
    let left = total;
    await call('bar', { where, count: '' });
    if (SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/${String(++shot).padStart(3, '0')}-${where.replace(/\W+/g, '-')}.png` }).catch(() => {}); }
    for (;;) {
      const s = (await call('read')) ?? {};
      if (s.next) break;
      if (AUTO && !s.hold) left -= 250;
      if (AUTO && left <= 0) break;
      await call('bar', { where, count: s.hold ? 'on hold' : AUTO ? `next in ${Math.ceil(left / 1000)}s` : 'press →' });
      await page.waitForTimeout(250);
    }
    await call('bar', { where, count: '' });
  }
  const cap = (kicker, title, body, at) => call('cap', { kicker, title, body, at });
  const status = (text) => call('status', text);
  // Scrolls the element into view (its top, if it is taller than its scrolling container), then returns
  // its box clipped to what is actually visible — a highlight never spills over other parts of the page.
  async function visibleBox(locator) {
    await locator.evaluate((el) => {
      const scroller = (() => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowY; if (/(auto|scroll)/.test(o) && a.scrollHeight > a.clientHeight) return a; } return null; })();
      const tall = scroller && el.getBoundingClientRect().height > scroller.getBoundingClientRect().height;
      el.scrollIntoView({ block: tall ? 'start' : 'nearest', behavior: 'smooth' });
    }, null, { timeout: 5000 });
    await page.waitForTimeout(650);
    return locator.evaluate((el) => {
      let { left, top, right, bottom } = el.getBoundingClientRect();
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (!/(auto|scroll|hidden)/.test(getComputedStyle(a).overflowY)) continue;
        const p = a.getBoundingClientRect();
        left = Math.max(left, p.left); top = Math.max(top, p.top); right = Math.min(right, p.right); bottom = Math.min(bottom, p.bottom);
      }
      left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
      return right > left + 4 && bottom > top + 4 ? { x: left, y: top, w: right - left, h: bottom - top } : null;
    }, null, { timeout: 5000 });
  }
  async function spot(items, { dim = items.length === 1 } = {}) {
    const boxes = [];
    for (const [locator, label] of items) {
      const b = await visibleBox(locator).catch(() => null); // not on screen: no highlight rather than a wrong one
      if (b) boxes.push({ ...b, label, dim });
    }
    await call('spot', boxes);
  }
  const unspot = () => call('spot', []);
  async function show(locator, label, secs, body) {
    if (body) await cap(...body);
    await spot([[locator, label]]);
    await pause(secs);
    await unspot();
  }

  // ---- app helpers -----------------------------------------------------------------------------------
  const log = page.locator('#student-log');
  const items = log.locator(':scope > li');
  async function tab(name) {
    await page.locator(`#tab-${name}`).click();
    await page.waitForTimeout(700);
  }
  async function typeInto(locator, text) {
    await locator.click();
    await locator.pressSequentially(text, { delay: TYPE_MS });
  }
  // Waits until the run in progress is over (Send enabled again, not sending/waiting, a new chat item).
  async function settle(before, label = 'Live: the agents are working…') {
    await status(label);
    const t0 = Date.now();
    await page.waitForTimeout(600);
    while (Date.now() - t0 < 180000) {
      const state = await page.locator('#state').getAttribute('data-state');
      const n = await items.count();
      if (!(await page.locator('#send').isDisabled()) && !/sending|waiting/.test(state ?? '') && n > before) break;
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(1200);
    await status(null);
  }
  async function ask(text, { then } = {}) {
    const box = page.locator('#message');
    await typeInto(box, text);
    await page.waitForTimeout(500);
    const before = await items.count();
    await box.press('Enter');
    if (then) await then();
    await settle(before);
    return items.last();
  }
  // The newest item when it is a question back to the student (the Student agent's or the university's).
  async function isQuestion(item) {
    const head = (await item.locator('.msg-dir').first().textContent().catch(() => '')) ?? '';
    return / asks$/.test(head.trim());
  }
  async function freshConversation() {
    const btn = page.locator('#new-conversation');
    if (!(await btn.isVisible())) return;
    await btn.click();
    await page.waitForTimeout(1500);
  }
  // A labelled field inside an A2UI surface (the renderer puts the label text next to the input).
  const field = (scope, label) => scope.locator(`xpath=(.//*[normalize-space(text())="${label}"])[1]/ancestor::*[.//input or .//textarea][1]`).locator('input, textarea').first();
  // Presses a form's submit button and waits until the agent's answer is in: the form is replaced by its
  // "You sent" summary (or reopened by the advisory review), and the run is over.
  async function submit(form, name, label) {
    const before = await items.count();
    const button = form.getByRole('button', { name });
    await button.click();
    await status(label);
    const reopened = name === 'Send anyway' ? [] : [form.getByRole('button', { name: 'Send anyway' }).waitFor({ timeout: 180000 })];
    await Promise.race([button.waitFor({ state: 'detached', timeout: 180000 }), ...reopened]).catch(() => {});
    await settle(before - 1, label);
  }
  // Part 6's advisory review can reopen a form with flags; the student decides. Show it, then send anyway.
  async function reviewIfAsked(kicker) {
    const anyway = page.getByRole('button', { name: 'Send anyway' }).last();
    if (!(await anyway.isVisible().catch(() => false))) return;
    await cap(kicker, 'The agent’s model flagged something', 'Before anything is recorded, the agent’s model reviews every field. It can only flag — it can’t change your values or block you. You decide: edit, or send anyway.');
    await show(anyway.locator('xpath=ancestor::li[1]'), 'Advisory review', 9);
    await submit(anyway.locator('xpath=ancestor::li[1]'), 'Send anyway', 'Live: sending the reviewed values…');
  }

  const STEPS = ['A2A', 'Browser monitor', 'A2UI form', 'Haiku tutor', 'Routing & skills', 'Forms on request', 'University Hub', 'Generated UI', 'Professor'];
  const PARTS = [
    {
      n: 1, title: 'Two agents talking over A2A',
      lead: 'Two separate Node.js processes. The Student Agent discovers the Tutor Agent through its Agent Card and sends it a message using the real Agent-to-Agent protocol — A2A v1.0 over JSON-RPC. No custom REST call, no fake transcript.',
      bullets: ['The Agent Card is a public JSON document: who the agent is, what it can do, where to reach it', 'message/send carries messageId, contextId and taskId — both sides log them so the exchange can be traced', 'The reply is fixed text: this step proves connectivity, not intelligence'],
      arch: 'Student Agent  ⇄  Tutor Agent',
      async run(k) {
        await page.goto(`${TUTOR}/.well-known/agent-card.json`).catch(() => {});
        await page.waitForTimeout(800);
        // Show exactly the JSON the Tutor served, indented and large enough to read from the back of the room.
        await page.evaluate(() => {
          const card = JSON.parse(document.body.innerText);
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(card, null, 2);
          pre.style.cssText = 'margin:0;padding:20px 400px 60px 28px;font:16px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#1b2340;';
          document.body.replaceChildren(pre);
          document.body.style.cssText = 'margin:0;background:#f7f8fc;';
        }).catch(() => {});
        await cap(k, 'This is the Tutor Agent’s Agent Card', 'Served by the Tutor itself at /.well-known/agent-card.json (shown indented).\n\nLook for: name and description, supportedInterfaces — the JSON-RPC endpoint and protocol version 1.0 — and, further down, skills: what it offers.');
        await pause(16);
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })).catch(() => {});
        await cap(k, 'Discovery comes first', 'Here are its skills. A client reads this card, then sends A2A messages to the endpoint it names. In Part 1 the Student read it directly. From Part 7 on, only the university Hub reads it — the Student never learns the Tutor’s address.');
        await pause(11);
        await page.goto(`${BASE}/conversation`);
        await page.waitForTimeout(1500);
      },
    },
    {
      n: 2, title: 'A browser window onto the exchange',
      lead: 'A small local UI backend hosts the Student Agent; the browser only watches. A separate event stream reports what the agents really did — it never carries agent messages itself.',
      bullets: ['Every message shows its time and its A2A ids', 'A hop-by-hop strip follows each request: sent → received → replied', 'Agent activity: one console per agent, fed only by real events'],
      arch: 'Browser ⇢ UI backend (Student Agent)  ⇄  Tutor Agent\n          ⇠ event stream (watch only)',
      async run(k) {
        if (FRESH) {
          await cap(k, 'A clean slate for the audience', 'New conversation starts a new A2A context. (In this demo it also resets the classroom — more on that in Part 9.)');
          await spot([[page.locator('#new-conversation'), 'New conversation']]);
          await pause(5);
          await unspot();
          await freshConversation();
        }
        await cap(k, 'The very first message, again', 'The same words the Student Agent sent in Part 1 — now typed in the browser and sent over A2A.');
        const reply = await ask('Hello Tutor Agent. Can you help me with calculus?');
        await show(reply, 'Reply, relayed over A2A', 8, [k, 'The answer came back over A2A', 'The header says who answered. Today the request passes the university first — that is Part 7 — but the A2A message itself is the same kind of thing as in Part 1.']);
        const ids = reply.locator('details, .ids').first();
        await ids.locator('summary').first().click().catch(() => {});
        await page.waitForTimeout(400);
        await show(ids, 'The A2A ids', 10, [k, 'Traceable, end to end', 'messageId, inReplyTo and contextId are the real protocol ids. You can find the same ids in each agent’s own log.']);
        await ids.locator('summary').first().click().catch(() => {});
        await show(page.locator('.timeline-panel'), 'Hop by hop', 12, [k, 'Every hop is a real event', 'Each box turns green only when an agent reports that step. Nothing is animated “for show”: a step that didn’t happen is marked skipped, with the reason.']);
        await tab('activity');
        await show(page.locator('section.console[data-agent="tutor"]'), 'Tutor Agent’s own console', 10, [k, 'Agent activity', 'One console per agent. Each one shows what that agent itself reported — received, replied, with timing.']);
        await tab('conversation');
      },
    },
    {
      n: 3, title: 'Agents can send UI: A2UI forms',
      lead: 'An agent can answer with an interface instead of text: an A2UI v0.9 description travels inside the A2A message, and the browser draws it with the official A2UI renderer. What you submit goes back to the agent over A2A.',
      bullets: ['Fields, data bindings and the submit action come from the agent — no hard-coded HTML form', 'Validation runs three times from one module: browser, UI backend, and the agent (which decides)', 'Originally a “Request form” button; since Part 6 you simply ask in chat'],
      arch: 'Tutor Agent ──A2A──▶ { A2UI JSON } ──▶ renderer in the browser\nbrowser ──values──▶ Student Agent ──A2A──▶ Tutor Agent',
      async run(k) {
        await cap(k, 'Asking in plain words', 'The Tutor decides that a form is the right answer to this.');
        const reply = await ask('I want to arrange in-person help with calculus on Friday morning');
        const form = log.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Send tutoring request' }) }).last();
        if (!(await form.count())) { await cap(k, 'The Tutor answered in words this time', 'Live models make judgment calls. The form appears when the Tutor decides the request needs one.'); await show(reply, 'Tutor’s answer', 8); return; }
        await show(form, 'Rendered from the A2UI the Tutor sent', 11, [k, 'A form, described by the agent', 'Labels, inputs, choices and buttons all come from the JSON description. Date and time of day were filled in from your own words — never by the model.']);
        await cap(k, 'Validation before anything is sent', 'Submitting an empty form shows inline errors. Nothing leaves the browser.');
        await form.getByRole('button', { name: 'Send tutoring request' }).click();
        await page.waitForTimeout(800);
        await show(form, 'Checks from the A2UI description', 8);
        await cap(k, 'Fill it in (fictional details)', 'Alex Student, alex@example.com — sample data only.');
        await typeInto(field(form, 'First name'), 'Alex');
        await typeInto(field(form, 'Last name'), 'Student');
        await typeInto(field(form, 'Email'), 'alex@example.com');
        await typeInto(field(form, 'Describe what you’d like help with.'), 'Practice with the chain rule before my quiz.');
        await pause(3);
        await submit(form, 'Send tutoring request', 'Live: the Tutor’s model reviews the request…');
        await reviewIfAsked(k);
        await show(items.last(), 'The Tutor’s answer', 10, [k, 'Round trip complete', 'The form became a “You sent” summary, the values went to the Tutor over A2A, and the Tutor’s record came back.']);
      },
    },
    {
      n: 4, title: 'The Tutor gets a brain: Claude Haiku 5.5',
      lead: 'The Tutor now answers with Claude Haiku 5.5, called from its own server process. The API key never leaves that process — not in A2A messages, logs, events or the browser.',
      bullets: ['Three modes — fixed, mock (tests) and live; the badge says which one is running', 'History is kept per A2A conversation (contextId), so follow-ups make sense', 'No hidden retries or canned answers: a failure is reported as a failure'],
      arch: 'Student Agent  ⇄  Tutor Agent ──HTTPS──▶ Claude Haiku 5.5',
      async run(k) {
        await show(page.locator('#tutor-mode'), 'Live model', 7, [k, 'Live, not scripted', 'Every answer from here on is generated live.']);
        const r1 = await ask('Can you explain the chain rule with one quick example?');
        await show(r1, 'Generated by Haiku 5.5, relayed over A2A', 12, [k, 'A real tutoring answer', 'The question went over A2A; the Tutor asked the model; the answer came back over A2A.']);
        await cap(k, 'A follow-up that needs memory', '“One like that” only makes sense with the conversation’s history.');
        const r2 = await ask('Give me one practice problem like that, without the answer.');
        await show(r2, 'Uses the conversation’s history', 10);
      },
    },
    {
      n: 5, title: 'A second agent, routing, and skills that set the rules',
      lead: 'A Library Agent joins. Each question goes to the service whose advertised skills fit — and each service refuses work outside the skills it has enabled.',
      bullets: ['The Library answers only from its saved content — no guessing', 'Skills are editable (⚙). Saving updates the Agent Card and notifies over A2A', 'Scope enforcement: out-of-scope requests are declined, not improvised'],
      arch: 'Student Agent ──(route by skills)──▶ Tutor Agent\n                                  └──▶ Library Agent',
      async run(k) {
        const r1 = await ask('What time does the library close on Sunday?');
        await show(r1.locator('.msg-dir').first(), 'Answered by the Library Agent', 10, [k, 'Routed by skill', 'Nobody named a service. Library hours match the Library’s skills, so the Library answered — from its saved hours.']);
        await cap(k, 'Something nobody offers', 'Physics isn’t in any service’s enabled skills. Watch who says no — the Student’s own model, the university, or the Tutor’s scope check.');
        const r2 = await ask('Can you explain Newton’s second law of motion?');
        await show(r2, 'Declined — outside every enabled skill', 11);
        await tab('activity');
        await page.locator('section.console[data-agent="library"] .gear').click();
        const dialog = page.locator('#skills-dialog');
        await dialog.waitFor({ state: 'visible' });
        await page.waitForTimeout(600);
        await show(dialog.locator('#skills-editor'), 'The Library’s skills', 13, [k, 'Skills are the contract', 'Each skill has a name, description, tags and examples (public, on the Agent Card) and answer content (private — what the Library may say). Saving would update the card and notify the Hub. We only look here.']);
        await dialog.locator('#card-preview-box summary').click();
        await page.waitForTimeout(800);
        await show(dialog.locator('#card-preview'), 'The Agent Card these skills produce', 9);
        await dialog.locator('#skills-cancel').click();
        await tab('conversation');
      },
    },
    {
      n: 6, title: 'Forms on request, with an advisory review',
      lead: 'There are no form buttons anywhere. The agent that receives the request decides from the conversation that a form is the right answer — the Tutor for in-person tutoring, the Library for group study rooms.',
      bullets: ['Only details from your own words are prefilled — never by the model, never names or emails', 'Demo availability comes from the Library; the time is re-checked when you confirm', 'A model reviews every field before anything is recorded — it can flag, you decide'],
      arch: 'You ── “book a room for 4 tomorrow afternoon” ──▶ Library Agent ──▶ A2UI booking form',
      async run(k) {
        await ask('Can I book a group study room for 4 people tomorrow afternoon?');
        const form = log.getByRole('listitem', { name: 'Book a group study room' }).last();
        if (!(await form.count())) { await cap(k, 'The Library answered in words this time', 'Live judgment: it offers the form when the request needs one.'); await pause(8); return; }
        await show(form, 'Library’s booking form', 10, [k, 'The Library sent its own form', 'Group size and date came from your sentence — look at the note under the form.']);
        await cap(k, 'Filling it in', 'Fictional details. Choosing room and duration asks the Library for demo availability — another A2A round trip.');
        await typeInto(field(form, 'First name'), 'Alex');
        await typeInto(field(form, 'Last name'), 'Student');
        await typeInto(field(form, 'Email'), 'alex@example.com');
        await form.getByRole('button', { name: /^Room B/ }).click();
        await form.getByRole('button', { name: '1 hour' }).click();
        await form.getByRole('button', { name: 'Show available times' }).click();
        const slots = form.getByRole('button', { name: /^\d\d:\d\d–\d\d:\d\d$/ });
        await slots.first().waitFor({ timeout: 60000 });
        await page.waitForTimeout(600);
        await show(form.getByRole('button', { name: /^\d\d:\d\d–\d\d:\d\d$/ }).first().locator('xpath=..'), 'Demo availability from the Library', 8);
        const afternoon = form.getByRole('button', { name: /^1[3-6]:00–/ });
        await ((await afternoon.count()) ? afternoon.first() : slots.first()).click();
        await form.getByRole('button', { name: 'Review booking' }).click();
        const confirm = form.getByRole('button', { name: 'Confirm demo booking' });
        await confirm.waitFor({ timeout: 60000 });
        await page.waitForTimeout(600);
        await show(form, 'Review before confirming', 9, [k, 'Nothing is reserved yet', 'Review first; the slot is re-checked at the moment you confirm.']);
        await submit(form, 'Confirm demo booking', 'Live: the Library’s model reviews the booking…');
        await reviewIfAsked(k);
        await show(items.last(), 'Booked (demo)', 10, [k, 'Booked — a demo record', 'The Library checked the fields, re-checked the slot and recorded the booking. No real reservation, no email.']);
      },
    },
    {
      n: 7, title: 'One front door: the University Hub',
      lead: 'The Student now talks only to the university — “California State University Fullerton”. The Hub keeps a private registry of specialists, decides where each request goes, forwards it over a second A2A leg, and relays the answer back.',
      bullets: ['Specialists register, send heartbeats, and only “ready” ones get work', 'The Student’s own model asks you to clarify when a request is unclear', 'The Topology tab shows each real message moving — including every model call'],
      arch: 'Student ──A2A──▶ University Hub ──A2A──▶ Tutor | Library | Professor\n   (model)          (model)                  (model)  (model)   (model)',
      async run(k) {
        await tab('topology');
        await show(page.locator('#topo'), 'Live topology', 10, [k, 'The switchboard', 'The Student, the Hub and each specialist — and each one’s own model box. The Student never connects to a specialist directly.']);
        await tab('conversation');
        await cap(k, 'Watch a question travel', 'We’ll send it, then switch straight to the topology.');
        await ask('What is the integral of 2x from 0 to 3?', { then: () => tab('topology') });
        await show(page.locator('#topo-events'), 'Every event, in order', 10, [k, 'Hop by hop, for real', 'Student → Hub → model (where should it go?) → Tutor → model → back. Only events the agents reported appear.', 'left bottom']);
        await tab('conversation');
        await show(page.locator('.timeline-panel'), '“Agent identified” = the Hub chose and checked the destination', 11, [k, 'Same journey, as steps', 'The Hub decided, validated the choice against its registry, and forwarded.']);
        await cap(k, 'An unclear request', 'Homework for which class? Instead of guessing, someone asks.');
        let r = await ask('Can you help me with my homework?');
        if (await isQuestion(r)) {
          await show(r, 'A clarifying question', 9);
          r = await ask('It’s for my calculus class — derivatives.');
        }
        await show(r, 'Answered after clarifying', 9);
        await tab('activity');
        await show(page.locator('section.console[data-agent="hub"]'), 'The Hub’s decisions', 10, [k, 'The Hub’s console', 'Registrations, heartbeats, routing decisions and forwards — the university’s side of every exchange.']);
        await tab('conversation');
      },
    },
    {
      n: 8, title: 'The model builds the interface',
      lead: 'For your (fictional) book loans, the Library’s model chooses whether to answer, ask, or compose an interface itself from the A2UI component catalog. Code validates every generated screen before you see it; the loan service owns every fact.',
      bullets: ['No templates picked by id — the layout and controls come from the model', 'Validator: allowed components only, real loan ids, date limits equal to what the policy permits', 'The borrower is who the Hub verified — never the model or the browser'],
      arch: 'Library model ──▶ A2UI from the catalog ──▶ validator ──▶ Hub ──▶ your screen\n                                         (≤2 repairs)',
      async run(k) {
        if (FRESH) { await cap(k, 'A new conversation for this request', 'Keeps earlier questions out of the model’s context.'); await freshConversation(); }
        const reply = await ask('I want to renew my borrowed library book Calculus: Early Transcendentals — let me pick the new return date');
        const date = reply.locator('input[type="date"]').first();
        if (!(await date.count())) { await show(reply, 'This time the model answered in words', 10, [k, 'The model chose not to build a screen', 'That is a legitimate choice too — it answers, asks, or builds an interface depending on what the request needs.']); return; }
        await show(reply, 'Composed by the model, checked by code', 13, [k, 'A screen nobody designed', 'The model picked these components from the catalog. Code checked them, including that the date picker can only offer the dates the loan policy permits.']);
        if (RENEW) {
          const min = await date.getAttribute('min');
          if (min) await date.fill(min);
          const before = await items.count();
          await reply.getByRole('button').filter({ hasText: /renew/i }).first().click();
          await settle(before - 1, 'Live: the loan service re-checks and renews…');
          await show(items.last(), 'Renewed by the loan service', 9);
        } else {
          await cap(k, 'We won’t press Renew today', 'Renewing changes the (synthetic) loan record. The loan service would re-check the borrower and the date, then renew once — a repeat click returns the same result.');
          await pause(9);
        }
        await tab('activity');
        await show(page.locator('section.inspector'), 'Generated UI inspector', 13, [k, 'What the model did, what code said', 'Model output, the app’s validation results, and the backend facts are kept apart — structure only by default, never the API key or prompts.']);
        await tab('conversation');
      },
    },
    {
      n: 9, title: 'The professor can start the conversation',
      lead: 'A Marketing 101 Professor joins behind the Hub. Now conversations can start on either side: the professor posts, and the post travels Professor → Hub → Student as a new, signed A2A message into the student agent’s inbox.',
      bullets: ['Without @assistant, the professor’s words go as written to tagged students or the whole class', '@assistant asks the course assistant (Haiku) to write and post a lesson', 'Honest delivery states — queued, delivered, opened; follow-ups are routed by the Hub’s own delivery record'],
      arch: 'Professor ──A2A──▶ University Hub ──signed A2A──▶ Student agent inbox\nStudent ──A2A──▶ Hub ──(lesson record)──▶ Professor',
      async run(k) {
        await tab('professor');
        const box = page.locator('#prof-message');
        await cap(k, 'The professor’s chat', 'A message straight to one student. Typing @ opens the class list.');
        await typeInto(box, '@al');
        await page.waitForTimeout(1200 * PACE);
        await box.press('Tab');
        await box.pressSequentially('Reminder: you can hand in this week’s homework late, no penalty.', { delay: TYPE_MS });
        await page.waitForTimeout(500);
        await box.press('Enter');
        const sent = page.locator('#prof-log > li').filter({ hasText: 'no penalty' }).last();
        await sent.getByText(/Delivered/).first().waitFor({ timeout: 60000 }).catch(() => {});
        await show(sent, 'Delivered to Alex’s Student agent', 10, [k, 'Delivered means delivered', '“Delivered” appears only after the Student agent has saved it. A student whose agent isn’t connected shows “Queued at Hub”.']);
        await cap(k, 'Now the course assistant', '@assistant writes a lesson for the whole class. We’ll switch to the student’s screen and wait for it to arrive.');
        await typeInto(box, '@assistant write a short lesson for the whole class on the 4 Ps of marketing, with one coffee-shop example');
        await page.waitForTimeout(600);
        await box.press('Enter');
        await page.waitForTimeout(800);
        await tab('conversation');
        await status('Live: the course assistant is writing the lesson…');
        const toast = page.locator('#toasts .toast').last();
        await toast.waitFor({ timeout: 120000 }).catch(() => {});
        await status(null);
        if (await toast.isVisible().catch(() => false)) {
          await show(toast, 'A lesson arrives — unprompted', 9, [k, 'Communication started by the professor', 'Alex never asked. The lesson came Professor → Hub → Student agent as a new A2A message, signed by the Hub.']);
          await toast.getByRole('button', { name: /View/ }).click();
        } else {
          await page.locator('#inbox-toggle').click().catch(() => {});
          await page.locator('#lesson-list li button', { hasText: 'View lesson' }).first().click();
        }
        const dialog = page.locator('#lesson-dialog');
        await dialog.waitFor({ state: 'visible' });
        await show(dialog, 'Opened — and the professor can see that', 11, [k, 'Opening is recorded', 'Shown as text only — nothing in a lesson can act. The professor’s view now shows “Opened” for Alex.']);
        await page.locator('#lesson-ask').click();
        await page.waitForTimeout(500);
        const r1 = await ask('Could you give me the same idea for a small bookstore?');
        await show(page.locator('.timeline-panel'), 'Routed by the lesson record, not by keywords', 9, [k, 'A follow-up about this lesson', 'The question carries the lesson’s delivery id. The Hub routes it with its own record of who sent that lesson.']);
        await show(r1, 'The professor’s answer', 10);
        await page.locator('#about-clear').click().catch(() => {});
        await cap(k, 'The professor remembers what it posted', 'A plain question about the course — answered from the professor’s own recent posts to this student.');
        const r2 = await ask('Can I hand in my marketing homework late this week?');
        await show(r2, 'Answered from the professor’s own post', 11);
        await tab('professor');
        await show(page.locator('#prof-log > li').filter({ hasText: '4 Ps' }).last(), 'Delivery state per student', 11, [k, 'Back on the professor’s side', 'Alex: delivered, then opened. Sam has no student agent connected, so the lesson waits at the Hub — and says so.']);
        await tab('conversation');
      },
    },
  ];

  // ---- the show ----------------------------------------------------------------------------------
  if (opts.get('size')) { const [w, h] = opts.get('size').split('x').map(Number); if (w && h) await page.setViewportSize({ width: w, height: h }); }
  if (!/^\/(conversation|activity|topology|professor)?$/.test(here.path)) await page.goto(`${BASE}/conversation`);
  await page.waitForTimeout(1000);
  const chosen = PARTS.filter((p) => p.n >= FROM && p.n <= TO);
  where = 'A2A spike';
  if (FROM <= 1) {
    await call('slide', {
      kicker: 'A2A spike · live demo', title: 'From two agents to a university',
      lead: `Nine steps, each built on the last. Everything you will see is the real app: ${PARTS.length > 8 ? 'five' : 'several'} local processes talking over the Agent-to-Agent protocol, with live Claude Haiku 5.5 calls. All people, books and courses are fictional.`,
      bullets: ['Each part starts with what it added, then shows it working', 'Highlights mark what to look at; pauses give you time to read'],
      steps: STEPS, now: 0,
    });
    await pause(14);
  }
  if (FRESH && chosen[0]?.n > 2) await freshConversation(); // Part 2 normally does this
  for (const part of chosen) {
    where = `Part ${part.n} of ${PARTS.length}`;
    await call('cap', null);
    await call('slide', { kicker: `Part ${part.n} of ${PARTS.length}`, title: part.title, lead: part.lead, bullets: part.bullets, arch: part.arch, steps: STEPS, now: part.n });
    await pause(16);
    await call('slide', null);
    await page.waitForTimeout(500);
    try {
      await part.run(`Part ${part.n} · ${part.title}`);
    } catch (err) {
      problems.push(`Part ${part.n}: ${String(err.message ?? err).split('\n')[0]}`);
      // Live demos meet live surprises: say so on screen, then carry on with the next part.
      await unspot();
      await cap(`Part ${part.n}`, 'This step didn’t go as scripted', `The app did something the script didn’t expect (${String(err.message ?? err).split('\n')[0].slice(0, 140)}). Moving on.`);
      await pause(6);
      await page.goto(`${BASE}/conversation`).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await call('cap', null);
    await unspot();
  }
  if (TO >= PARTS.length) {
    where = 'The end';
    await call('slide', {
      kicker: 'Recap', title: 'Built one layer at a time',
      lead: 'Two processes exchanging a fixed message became a university: a front door that routes and relays, specialists with enforceable skills, forms and model-built interfaces checked by code, and a professor who can start the conversation.',
      bullets: ['Every message is real A2A; every highlight was a real event', 'Models judge; code validates and owns the facts', 'This demo grows with the project — the next part gets the next slide'],
      steps: STEPS, now: STEPS.length + 1,
    });
    await pause(20);
    await call('slide', null);
  }
  await call('bar', { where: 'Demo finished', count: '' });
  return { finished: chosen.map((p) => p.n), problems };
}
