// Browser check: PeopleSoft on Topology (Part 15, the owner's approved design F — an AI tile with a database
// icon, a sparkle and a light sweep; mockup .superpowers/brainstorm/27262-1793762277/content/peoplesoft-5-designs.html).
// PeopleSoft is a demo stand-in reached only by the HR Agent over MCP. It must never look like an agent (no circle,
// no orbit ring, no model box) and the wrapper's step names never appear. Run it on a SEPARATE stack, never the
// user's demo (it presses New conversation, which resets the classroom):
//   node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock
//   playwright-cli -s=ps open http://127.0.0.1:5544/topology
//   playwright-cli -s=ps run-code "$(cat scripts/browser-checks/peoplesoft.js)"
// Screenshots go to SHOTS (relative to where playwright-cli runs). Mock HR = a labelled heuristic: this checks the
// drawing and the plumbing, not live judgment. Look at every screenshot.
async (page) => {
  const SHOTS = '.superpowers/sdd/2026-11-03-peoplesoft-mcp/shots';
  page.setDefaultTimeout(30000);
  const results = [];
  const errors = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  const origin = await page.evaluate(() => location.origin);
  const STEP_NAMES = ['check_balance', 'check_dates_and_holidays', 'check_overlap', 'apply_leave_policy', 'route_to_manager', 'notify_timekeeper', 'store_record'];
  const stepWords = new RegExp(STEP_NAMES.map((s) => `${s}|${s.replace(/_/g, ' ')}`).join('|'), 'i');

  // A fresh classroom (separate stack only): New conversation also resets HR and PeopleSoft's records.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${origin}/conversation`);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.waitForTimeout(1500);

  // The Topology tab, in its own page, light scheme.
  const topo = await page.context().newPage();
  topo.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  topo.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
  await topo.setViewportSize({ width: 1280, height: 1000 });
  await topo.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await topo.goto(`${origin}/topology`);
  await topo.waitForTimeout(1500);
  const ps = topo.locator('[data-node="peoplesoft"]');
  const pill = () => ps.locator('.status-text').textContent().then((t) => t?.trim() ?? '').catch(() => '');

  // 1. At rest: the tile, not an agent.
  check('node exists', await ps.count() === 1);
  check('node has class system', await ps.evaluate((g) => g.classList.contains('system')).catch(() => false));
  check('no orbit ring, no disc circle', await ps.locator('.orbit, circle.disc, circle').count() === 0, await ps.locator('.orbit, circle.disc, circle').count());
  check('no PeopleSoft model box', await topo.locator('[data-node="llm-peoplesoft"], [data-owner="peoplesoft"], [data-edge="peoplesoft-model"]').count() === 0);
  check('tile 176×80 rx 16', await ps.locator('rect.tile').evaluate((r) => [r.getAttribute('width'), r.getAttribute('height'), r.getAttribute('rx')].join(',')).catch(() => null) === '176,80,16');
  check('database icon, sparkle and sweep present', await ps.locator('.db').count() >= 2 && await ps.locator('.spark').count() === 1 && await ps.locator('.sweep').count() === 1);
  check('name and role', (await ps.locator('.node-name').textContent().catch(() => '')) === 'PeopleSoft' && /MCP server/i.test(await ps.locator('.node-sub').textContent().catch(() => '')));
  check('MCP edge HR ↔ PeopleSoft', await topo.locator('[data-edge="hr-peoplesoft"][data-kind="mcp"]').count() === 1 && (await topo.locator('[data-edge="hr-peoplesoft"] .edge-label').textContent().catch(() => '')) === 'MCP');
  check('viewBox 0 0 1100 1029', (await topo.locator('#topo').getAttribute('viewBox')) === '0 0 1100 1029');
  check('aria-label mentions PeopleSoft', /PeopleSoft/.test(await topo.locator('#topo').getAttribute('aria-label')));
  check('legend row for MCP tool calls', await topo.locator('.legend li', { hasText: 'MCP tool call (dash-dot line = MCP to Canvas LMS or PeopleSoft)' }).count() === 1);
  // Layout (SVG user units): the tile, its pill and the MCP lanes stay clear of the HR node and inside the drawing.
  const geo = await topo.evaluate(() => {
    const box = (id) => {
      const g = document.querySelector(`[data-node="${id}"]`);
      const b = g.getBBox();
      const [x, y] = (g.getAttribute('transform').match(/-?[\d.]+/g) ?? []).map(Number);
      return { x: b.x + x, y: b.y + y, w: b.width, h: b.height };
    };
    const L = [...document.querySelectorAll('[data-edge="hr-peoplesoft"] .lane')].map((l) => ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a))));
    const label = document.querySelector('[data-edge="hr-peoplesoft"] .edge-label');
    return { ps: box('peoplesoft'), hr: box('hr'), llmHr: box('llm-hr'), hrPill: (() => { const q = document.querySelector('[data-node="hr"] .node-status').getBBox(); return { x: 710 + q.x, y: 860 + 82 + q.y, w: q.width, h: q.height }; })(), lanes: L, label: { x: Number(label.getAttribute('x')), y: Number(label.getAttribute('y')) } };
  });
  const xs = geo.lanes.flatMap((l) => [l[0], l[2]]);
  const ys = geo.lanes.flatMap((l) => [l[1], l[3]]);
  check('PeopleSoft sits under HR’s model, no overlap', geo.ps.y >= geo.llmHr.y + geo.llmHr.h && Math.abs((geo.ps.x + geo.ps.w / 2) - (geo.llmHr.x + geo.llmHr.w / 2)) < 2, { ps: geo.ps, llmHr: geo.llmHr });
  check('PeopleSoft (tile and pill) inside the viewBox', geo.ps.y + geo.ps.h <= 1029 && geo.ps.x >= 0 && geo.ps.x + geo.ps.w <= 1100, geo.ps);
  const inPill = (x, y) => x >= geo.hrPill.x && x <= geo.hrPill.x + geo.hrPill.w && y >= geo.hrPill.y && y <= geo.hrPill.y + geo.hrPill.h;
  check('MCP lanes leave HR clear of its pill and end left of the tile (halo 7 outside it)', geo.lanes.every((l) => !inPill(l[0], l[1]) && !inPill(l[2], l[3])) && Math.max(...xs) < geo.ps.x + 7, { lanes: geo.lanes, hrPill: geo.hrPill, ps: geo.ps });
  check('MCP label just below the middle of the lanes, between HR and the tile', geo.label.x > Math.min(...xs) && geo.label.x < Math.max(...xs) && geo.label.y > Math.min(...ys) && geo.label.y < Math.max(...ys) + 40, { label: geo.label, xs, ys });
  await topo.locator('#topo').screenshot({ path: `${SHOTS}/ps-1-rest.png` });

  // 2. File a request from the Faculty view; Topology watches for the MCP hop, busy and “✓ Saved”.
  await page.goto(`${origin}/faculty`);
  await page.waitForTimeout(1200);
  const card = page.locator('#prof-log .hr-card');
  async function say(text) {
    const before = await page.locator('#prof-log > li').count();
    await page.locator('#prof-message').fill(text);
    await page.locator('#prof-message').press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('#prof-log > li').length > n && !document.querySelector('#prof-log .chat-pending'), before, { timeout: 30000 });
    await page.waitForTimeout(700);
  }
  const seen = { lit: false, busy: false, busyShot: false, saved: false, savedShot: false, pills: [] }; // pills: each change, in order
  let watchingOn = true;
  const watching = (async () => {
    for (let i = 0; watchingOn && i < 900; i++) {
      await topo.waitForTimeout(40);
      const s = await topo.evaluate(() => ({
        lit: Boolean(document.querySelector('[data-edge="hr-peoplesoft"] .lane.lit')),
        busy: Boolean(document.querySelector('[data-node="peoplesoft"].busy')),
        pill: document.querySelector('[data-node="peoplesoft"] .status-text')?.textContent ?? '',
      }));
      if (seen.pills[seen.pills.length - 1] !== s.pill) seen.pills.push(s.pill);
      if (s.lit) seen.lit = true;
      if (s.busy) {
        seen.busy = true;
        if (!seen.busyShot && s.pill === '● Working…') { seen.busyShot = true; await topo.locator('#topo').screenshot({ path: `${SHOTS}/ps-2-busy.png` }); }
      }
      if (s.pill === '✓ Saved') {
        seen.saved = true;
        if (!seen.savedShot) { seen.savedShot = true; await topo.locator('#topo').screenshot({ path: `${SHOTS}/ps-3-saved.png` }); }
      }
    }
  })();
  await say('I want to file for time off. My grandmother passed away, and I need this Thursday and Friday for the funeral.');
  check('card shown', await card.count() === 1);
  await card.getByRole('button', { name: 'Submit request', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#prof-log .hr-card'), null, { timeout: 30000 });
  const receipt = (await page.locator('#prof-log .msg.hr-receipt').last().locator('.msg-text').textContent().catch(() => ''))?.trim();
  check('submit filed (receipt)', /^Sent to your manager for a decision\./.test(receipt ?? ''), receipt);
  await topo.waitForFunction(() => document.querySelector('[data-node="peoplesoft"] .status-text')?.textContent === '✓ Saved', null, { timeout: 8000 }).catch(() => {});
  await topo.waitForTimeout(300);
  watchingOn = false;
  await watching;
  check('MCP lane lit', seen.lit);
  check('node got class busy (pill “● Working…”)', seen.busy && seen.pills.includes('● Working…'), seen.pills);
  // Order: the filing's “● Working…” comes right before “✓ Saved” (Saved only after the call it answers).
  const savedAt = seen.pills.indexOf('✓ Saved');
  check('pill reads “● Working…” then “✓ Saved”', seen.saved && savedAt > 0 && seen.pills[savedAt - 1] === '● Working…', seen.pills);
  // After 3 s the pill returns to the session status.
  await topo.waitForTimeout(3600);
  const after = await pill();
  check('after 3 s the pill shows the session status', after === '✓ Connected', after);
  check('busy cleared', !(await ps.evaluate((g) => g.classList.contains('busy'))));

  // 3. The event list: the tool call and the saved record.
  const events = (await topo.locator('#topo-events').textContent()) ?? '';
  check('event list has “tools/call create_absence_request”', /tools\/call create_absence_request/.test(events));
  check('event list has “Saved as ABS-”', /Saved as ABS-\d+/.test(events));
  check('event list has no step names', !stepWords.test(events));

  // 4. Details panel.
  await ps.click();
  await topo.waitForTimeout(300);
  const detail = ((await topo.locator('#topo-detail').textContent()) ?? '').replace(/\s+/g, ' ');
  check('details: title', /PeopleSoft — demo stand-in/.test(detail), detail.slice(0, 200));
  check('details: reached only by HR', detail.includes('Reached only by the HR Agent, over MCP. Fictional data.'));
  check('details: the three tools', ['get_leave_balances', 'list_absence_requests', 'create_absence_request'].every((t) => detail.includes(t)));
  check('details: last call', /Saved as ABS-\d+/.test(detail), detail.slice(-160));
  check('details: no step names', !stepWords.test(detail));
  check('whole page: no step names', !stepWords.test((await topo.locator('#view-topology').textContent()) ?? ''));

  // 5. Reduced motion. Changing the setting re-renders the node (which drops a hand-set `busy`), so `busy` is set
  //    AFTER each change, then the animations are read: running with motion allowed, 'none' with reduced motion.
  const animations = () => ps.evaluate((g) => [g.querySelector('.spark'), g.querySelector('.sweep')].map((e) => getComputedStyle(e).animationName));
  const busyAnimations = async () => {
    await topo.waitForTimeout(100);
    await ps.evaluate((g) => g.classList.add('busy'));
    await topo.waitForTimeout(50);
    const names = await animations();
    const stillBusy = await ps.evaluate((g) => g.classList.contains('busy'));
    await ps.evaluate((g) => g.classList.remove('busy'));
    return { names, stillBusy };
  };
  const moving = await busyAnimations();
  check('motion allowed: busy animates sparkle and sweep', moving.stillBusy && moving.names.every((n) => n !== 'none'), moving);
  await topo.locator('#topo-reduce').check();
  const still = await busyAnimations();
  check('Reduce motion checkbox: busy, but no animation', still.stillBusy && still.names.every((n) => n === 'none'), still);
  await topo.locator('#topo-reduce').uncheck();
  const again = await busyAnimations();
  check('checkbox off again: busy animates', again.stillBusy && again.names.every((n) => n !== 'none'), again);
  await topo.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const osStill = await busyAnimations();
  check('prefers-reduced-motion: busy, but no animation', osStill.stillBusy && osStill.names.every((n) => n === 'none'), osStill);
  await topo.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await topo.waitForTimeout(100);

  // 6. Dark mode at rest (selection cleared through “All traffic”), and busy (class forced for the picture only).
  await topo.locator('#topo-trace').dispatchEvent('change');
  await topo.emulateMedia({ colorScheme: 'dark' });
  await topo.waitForTimeout(400);
  await topo.locator('#topo').screenshot({ path: `${SHOTS}/ps-4-dark.png` });
  await ps.evaluate((g) => g.classList.add('busy'));
  await topo.waitForTimeout(500);
  await topo.locator('#topo').screenshot({ path: `${SHOTS}/ps-5-dark-busy-forced.png` });
  await ps.evaluate((g) => g.classList.remove('busy'));
  const darkName = await ps.locator('.node-name').evaluate((t) => getComputedStyle(t).fill);
  check('dark: name uses the dark PeopleSoft colour', /251, 138, 76/.test(darkName), darkName);
  await topo.close();

  check('no page or console errors', errors.length === 0, errors);
  return { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: results.length };
}
