// Live walkthrough v2 — frame (windows, overlay, presenter keys, human-like input, scene loop).
// Do not run this directly. `node scripts/demo/build-walkthrough.js` replaces the scene marker line below with
// every scene-N.js and writes scripts/demo/live-walkthrough.js, which is
//   playwright-cli -s=demo2 open --headed "http://127.0.0.1:4444/conversation"
//   playwright-cli -s=demo2 run-code "$(cat scripts/demo/live-walkthrough.js)"
// Query options of the opened address: from, to (steps 1-11; default: the last scene), fresh=0 (keep the conversation),
// type=<ms per character, default 55>, auto=<secs> (rehearsal only: advance by itself), shots=<dir>
// (rehearsal: NNN-L.png / NNN-R.png per moment). Keys (either window): -> / PageDown / Space = next,
// N = skip the rest of this step, H = hold on/off. The overlay (step label + cursor dot) lives in its own
// shadow root and never touches the app's DOM. Fresh start presses New conversation, which also resets the
// classroom — never run it on a demo you want to keep.
async (page) => {
  page.setDefaultTimeout(30000);
  const context = page.context();
  const here = await page.evaluate(() => ({ origin: location.origin, query: Object.fromEntries(new URLSearchParams(location.search)) }));
  const q = here.query;
  const BASE = here.origin.startsWith('http') ? here.origin : 'http://127.0.0.1:4444';
  const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const opts = {
    from: num(q.from, 1),
    to: num(q.to, 99), // every scene by default (the last one ends the show)
    fresh: q.fresh !== '0',
    TYPE: num(q.type, 55),
    auto: q.auto ? num(q.auto, 0) : 0,
    shots: q.shots || null,
  };
  const problems = [];
  const finished = [];
  const scenes = [];
  const STOP = { stopScene: true }; // thrown by moment() to end the current scene (skip, or a failed moment)
  const left = page;
  const sleep = (ms) => left.waitForTimeout(ms); // run-code has no setTimeout / setInterval

  // ---- overlay (runs inside each page, own shadow root; survives navigation via addInitScript) -------------
  const overlayInit = (bindingName) => {
    window.__demoKeyBinding = bindingName; // each run exposes its own binding (an older run's would reach a dead handler)
    if (window.__demoOverlay) return;
    window.__demoOverlay = true;
    window.__demoWaiting = false;
    const mount = () => {
      const host = document.createElement('div');
      host.id = 'demo-v2';
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
        .label { position: fixed; right: 10px; bottom: 8px; font-size: 12px; font-weight: 600; color: #eef2ff;
          background: rgba(14,22,48,.78); padding: 3px 9px; border-radius: 999px; opacity: 0; transition: opacity .25s; }
        .label.on { opacity: 1; }
        .dot { position: fixed; left: 0; top: 0; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
          background: rgba(255,207,63,.55); border: 2px solid #ff9f1c; box-shadow: 0 0 0 1px rgba(0,0,0,.25);
          display: none; transition: width .08s, height .08s, margin .08s; }
        .dot.down { width: 12px; height: 12px; margin: -6px 0 0 -6px; background: rgba(255,159,28,.9); }
      `;
      const label = document.createElement('div');
      label.className = 'label';
      const dot = document.createElement('div');
      dot.className = 'dot';
      root.append(style, label, dot);
      document.documentElement.append(host);
      const setLabel = (t) => {
        label.textContent = t ?? '';
        label.classList.toggle('on', Boolean(t));
        try { sessionStorage.setItem('__demoLabel', t ?? ''); } catch { /* storage blocked */ }
      };
      window.__demoSetLabel = setLabel;
      try { const saved = sessionStorage.getItem('__demoLabel'); if (saved) setLabel(saved); } catch { /* storage blocked */ }
      window.addEventListener('mousemove', (e) => { dot.style.display = 'block'; dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
      window.addEventListener('mousedown', () => dot.classList.add('down'), true);
      window.addEventListener('mouseup', () => dot.classList.remove('down'), true);
      const KEYS = { ArrowRight: 'next', PageDown: 'next', ' ': 'next', n: 'skip', N: 'skip', h: 'hold', H: 'hold' };
      window.addEventListener('keydown', (e) => {
        const k = KEYS[e.key];
        if (!k || e.ctrlKey || e.metaKey || e.altKey) return;
        if (window.__demoTyping) return; // the script's own keystrokes reach the app
        // A presenter key never reaches the app: not while the script waits, and not while it works
        // (a Space would re-press a focused button, an N would land in a text box).
        e.preventDefault();
        e.stopPropagation();
        if (window.__demoWaiting && !e.repeat) window[window.__demoKeyBinding]?.(k);
      }, true);
    };
    if (document.documentElement) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  };

  // ---- presenter keys -------------------------------------------------------------------------------------
  let waiting = false;
  let held = false;
  let pressed = null; // set by a key that arrived while waiting
  let labelText = '';
  const onKey = (k) => {
    if (!waiting) return; // presses that arrive while the script is working are discarded, never banked
    if (k === 'hold') { held = !held; showLabel().catch(() => {}); return; }
    if (held) return; // while held, only H is accepted
    pressed = k;
  };
  const bindingName = `__demoKey_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  await context.exposeBinding(bindingName, (_src, k) => onKey(k));
  await context.addInitScript(overlayInit, bindingName);
  await left.evaluate(overlayInit, bindingName);

  const everyPage = () => context.pages().filter((p) => !p.isClosed());
  const showLabel = async () => {
    const text = labelText ? labelText + (held ? ' ⏸' : '') : '';
    await Promise.all(everyPage().map((p) => p.evaluate((t) => window.__demoSetLabel?.(t), text).catch(() => {})));
  };
  const setLabel = async (text) => { labelText = text; await showLabel(); };
  const setWaiting = (on) => Promise.all(everyPage().map((p) => p.evaluate((v) => { window.__demoWaiting = v; }, on).catch(() => {})));
  // The script's own keyboard input is marked, so the key guard lets it through.
  const typing = (on) => left.evaluate((v) => { window.__demoTyping = v; }, on).catch(() => {});
  const keyboard = async (fn) => { await typing(true); try { return await fn(); } finally { await typing(false); } };
  // A run stopped while waiting leaves the flags set in the open page (the overlay isn't re-created): reset them.
  await setWaiting(false);
  await typing(false);

  // ---- the two windows ------------------------------------------------------------------------------------
  for (const p of context.pages()) if (p !== left) await p.close().catch(() => {}); // leftovers from an earlier run in this session
  // The topology opens as a popup window of the app (window.open from the page), because a second page of this
  // browser would only be another tab of the same window, and tabs can't sit side by side. Fallback: a new page.
  let right;
  try {
    const [popup] = await Promise.all([
      left.waitForEvent('popup', { timeout: 10000 }),
      left.evaluate((url) => { window.open(url, '_blank', 'popup=1,left=1120,top=0,width=800,height=1000'); }, `${BASE}/topology`),
    ]);
    right = popup;
    await right.waitForLoadState('domcontentloaded');
  } catch (e) {
    problems.push(`topology popup failed (${String(e?.message ?? e).split('\n')[0]}); using a tab instead`);
    right = await context.newPage();
    await right.goto(`${BASE}/topology`);
  }
  right.setDefaultTimeout(30000);
  async function placeWindows() {
    const place = async (p, bounds) => {
      try {
        const cdp = await context.newCDPSession(p);
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...bounds, windowState: 'normal' } });
        await cdp.detach();
      } catch { /* headless or no window manager: the pages keep their size */ }
    };
    await place(left, { left: 0, top: 0, width: 1120, height: 1050 });
    await place(right, { left: 1120, top: 0, width: 800, height: 1050 });
  }
  await placeWindows();
  // The topology must be settled (its event stream replayed) before the first moment, or it would miss a flow's start.
  await right.locator('#topo').waitFor({ state: 'visible', timeout: 30000 }).catch(() => problems.push('topology window: #topo never appeared'));
  await sleep(1500);
  await left.bringToFront().catch(() => {});

  async function waitKey() {
    await setWaiting(true);
    pressed = null;
    waiting = true;
    let elapsed = 0;
    while (pressed === null) {
      await sleep(100);
      elapsed += 100;
      if (elapsed % 700 === 0) await setWaiting(true); // a page that navigated has lost the flag
      if (opts.auto && !held && elapsed >= opts.auto * 1000) pressed = 'next';
    }
    waiting = false;
    await setWaiting(false);
    const key = pressed;
    pressed = null;
    return key; // 'next' | 'skip'
  }

  // ---- scenes need these ----------------------------------------------------------------------------------
  let current = null; // the scene being run
  let shot = 0;
  const log = left.locator('#student-log');
  const items = log.locator(':scope > li');
  const pause = (ms) => left.waitForTimeout(ms);

  async function saveShots(name) {
    if (!opts.shots) return;
    await sleep(700); // let the hop animation and the reply settle
    const n = String(++shot).padStart(3, '0');
    await left.screenshot({ path: `${opts.shots}/${n}-L.png` }).catch((e) => problems.push(`screenshot ${n}-L (${name}): ${e.message}`));
    await right.screenshot({ path: `${opts.shots}/${n}-R.png` }).catch((e) => problems.push(`screenshot ${n}-R (${name}): ${e.message}`));
  }

  async function moment(name, fn) {
    let failed = false;
    try {
      await fn();
    } catch (e) {
      failed = true;
      problems.push(`Step ${current?.n} · ${name}: ${String(e?.message ?? e).split('\n')[0]}`);
    }
    await saveShots(name);
    const key = await waitKey();
    if (failed || key === 'skip') throw STOP;
  }

  // Scrolls the element into view, then returns the centre of the part of it that is actually visible
  // (clipped to its scrolling containers and the window), so a tall item still gets a sensible target.
  async function targetPoint(loc) {
    await loc.evaluate((el) => {
      const scroller = (() => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowY; if (/(auto|scroll)/.test(o) && a.scrollHeight > a.clientHeight) return a; } return null; })();
      const tall = scroller && el.getBoundingClientRect().height > scroller.getBoundingClientRect().height;
      el.scrollIntoView({ block: tall ? 'start' : 'nearest', behavior: 'smooth' });
    }, null, { timeout: 5000 });
    await sleep(650);
    // The app may still be scrolling (smooth scroll, the chat following a new reply): wait until the
    // element stops moving, or a point measured now is stale by the time the mouse gets there.
    let last = null;
    for (let i = 0; i < 20; i++) {
      const r = await loc.evaluate((el) => { const b = el.getBoundingClientRect(); return `${Math.round(b.left)},${Math.round(b.top)}`; }, null, { timeout: 5000 });
      if (r === last) break;
      last = r;
      await sleep(150);
    }
    const p = await loc.evaluate((el) => {
      let { left, top, right, bottom } = el.getBoundingClientRect();
      for (let a = el.parentElement; a; a = a.parentElement) {
        if (!/(auto|scroll|hidden)/.test(getComputedStyle(a).overflowY)) continue;
        const r = a.getBoundingClientRect();
        left = Math.max(left, r.left); top = Math.max(top, r.top); right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
      }
      left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
      return right > left + 2 && bottom > top + 2 ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
    }, null, { timeout: 5000 });
    if (p) return p;
    const b = await loc.boundingBox();
    if (!b) throw new Error('element has no visible box');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  async function moveTo(loc) {
    const { x, y } = await targetPoint(loc);
    await left.mouse.move(x, y, { steps: 20 + Math.floor(Math.random() * 11) });
    await sleep(140);
    return { x, y };
  }
  // True when the element (or something inside it) is what a click at (x, y) would hit.
  const under = (loc, x, y) => loc.evaluate((el, [px, py]) => { const hit = document.elementFromPoint(px, py); return !!hit && (el === hit || el.contains(hit) || hit.contains(el)); }, [x, y], { timeout: 5000 }).catch(() => false);
  async function click(loc) {
    let { x, y } = await moveTo(loc);
    // If the page moved under the mouse on the way, aim again (never click something else).
    for (let i = 0; i < 3 && !(await under(loc, x, y)); i++) ({ x, y } = await moveTo(loc));
    if (!(await under(loc, x, y))) throw new Error('click target moved away from the mouse');
    await left.mouse.down();
    await sleep(70);
    await left.mouse.up();
    await sleep(120);
    return { x, y };
  }
  async function typeInto(loc, text) {
    await click(loc);
    await keyboard(() => left.keyboard.type(text, { delay: opts.TYPE }));
  }
  const typeHere = (text) => keyboard(() => left.keyboard.type(text, { delay: opts.TYPE }));
  const press = async (key) => { await keyboard(() => left.keyboard.press(key)); await sleep(120); };

  // Waits until the run in progress is over (Send enabled, not sending/waiting) and there are more than `before` chat items.
  async function settle(before) {
    const t0 = Date.now();
    await sleep(600);
    while (Date.now() - t0 < 180000) {
      const state = await left.locator('#state').getAttribute('data-state');
      const n = await items.count();
      if (!(await left.locator('#send').isDisabled()) && !/sending|waiting/.test(state ?? '') && n > before) { await sleep(1000); return; }
      await sleep(300);
    }
    throw new Error('no answer within 3 minutes'); // recorded as a problem; never shown as a success
  }
  async function ask(text) {
    const box = left.locator('#message');
    await typeInto(box, text);
    await sleep(500);
    const before = await items.count();
    await keyboard(() => left.keyboard.press('Enter'));
    await settle(before);
    return items.last();
  }
  async function tab(name) {
    await click(left.locator(`#tab-${name}`));
    await sleep(700);
  }
  async function freshConversation() {
    const btn = left.locator('#new-conversation');
    if (!(await btn.isVisible())) return;
    await click(btn);
    await sleep(1500);
  }
  // A labelled field inside an A2UI surface (first match of the label text).
  const field = (scope, label) => scope.locator(`xpath=(.//*[normalize-space(text())="${label}"])[1]/ancestor::*[.//input or .//textarea][1]`).locator('input, textarea').first();
  // Clicks the form's button and waits until it is gone (the form became its summary) or "Send anyway" appears, then until the run is over.
  async function submit(form, buttonName) {
    const before = await items.count();
    const button = form.getByRole('button', { name: buttonName });
    await click(button);
    const reopened = buttonName === 'Send anyway' ? [] : [form.getByRole('button', { name: 'Send anyway' }).waitFor({ timeout: 180000 })];
    await Promise.race([button.waitFor({ state: 'detached', timeout: 180000 }), ...reopened]).catch(() => {});
    await settle(before - 1);
  }
  // The newest item is a question back to the student (header ends with " asks").
  async function isQuestion(item) {
    const head = (await item.locator('.msg-dir').first().textContent().catch(() => '')) ?? '';
    return / asks$/.test(head.trim());
  }
  const seen = async (loc, ms = 30000) => {
    try { await loc.first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; }
  };

  /*@SCENES*/

  // ---- main loop ------------------------------------------------------------------------------------------
  scenes.sort((a, b) => a.n - b.n);
  const todo = scenes.filter((s) => s.n >= opts.from && s.n <= opts.to);
  if (opts.from > 2 && opts.fresh) {
    try { await freshConversation(); } catch (e) { problems.push(`fresh start: ${String(e?.message ?? e).split('\n')[0]}`); }
  }
  for (const scene of todo) {
    current = scene;
    const before = problems.length;
    await setLabel(`Step ${scene.n} · ${scene.title}`);
    try {
      await scene.run();
    } catch (e) {
      if (e !== STOP) problems.push(`Step ${scene.n}: ${String(e?.message ?? e).split('\n')[0]}`);
    }
    if (problems.length === before) finished.push(scene.n);
  }
  await setLabel('');
  return { finished, problems };
}
