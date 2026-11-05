// Browser check: the CHRS class roster (Part 17) — the "CHRS · Class roster" card, the header count, and the delivery
// summary + fold for big audiences (approved mockup docs/superpowers/specs/2026-11-05-chrs-roster-mockup.html, screens 1-3).
// Run it on a SEPARATE mock stack with "today" pinned to 2026-11-04 (it presses New conversation, which resets the classroom):
//   node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock --now 2026-11-04T20:00:00Z
//   playwright-cli -s=cr open http://127.0.0.1:5544/faculty
//   playwright-cli -s=cr run-code "$(cat scripts/browser-checks/chrs-roster.js)"
// The class cancellation summary is checked at the end of scripts/browser-checks/hr-card.js. The mock Faculty and CHRS are
// labelled heuristics: this checks drawing and plumbing, not live judgment. Look at every screenshot.
async (page) => {
  const SHOTS = '.superpowers/sdd/2026-11-05-chrs-roster/shots';
  page.setDefaultTimeout(30000);
  const results = [];
  const errors = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  const origin = await page.evaluate(() => location.origin);
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
  };
  watch(page);
  let student;
  try {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });

  await page.goto(`${origin}/conversation`);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.waitForTimeout(1500);
  // Alex's own page stays open: he is the one student who is online.
  student = await page.context().newPage();
  watch(student);
  await student.setViewportSize({ width: 1280, height: 900 });
  await student.goto(`${origin}/conversation`);
  await student.waitForTimeout(1500);
  await student.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));

  await page.goto(`${origin}/faculty`);
  await page.waitForTimeout(1500);
  const log = page.locator('#prof-log');
  async function say(text) {
    const before = await page.locator('#prof-log > li').count();
    await page.locator('#prof-message').fill(text);
    await page.locator('#prof-message').press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('#prof-log > li').length > n && !document.querySelector('#prof-log .chat-pending'), before, { timeout: 30000 });
  }

  check('before any roster request the header adds no student count', !/\d+ students/.test(await page.locator('#prof-roster').textContent()), await page.locator('#prof-roster').textContent());

  check('before the count is known the header shows no student chips', await page.locator('#prof-roster .presence').count() === 0 && (await page.locator('#prof-roster').textContent()).trim() === '', await page.locator('#prof-roster').textContent());
  await page.locator('#view-professor .panel-head').screenshot({ path: `${SHOTS}/t5-fix-header-before-count.png` });
  // 1. The roster card.
  await say('show me my class roster');
  await page.waitForSelector('#prof-log .roster-card[data-state="ready"]', { timeout: 30000 });
  const card = page.locator('#prof-log .roster-card');
  const head = ((await card.locator('.cr-head').textContent()) ?? '').replace(/\s+/g, ' ');
  check('card label is CHRS · Class roster', /CHRS · Class roster/.test(await card.locator('.msg-dir').textContent()));
  check('title, term line, class line', /Class Roster/.test(head) && /Fall 2026 · Regular Academic Session · California State University, Fullerton · Undergraduate/.test(head) && /MKTG 351 - 01 \(12351\) Principles of Marketing \(Lecture\)/.test(head), head);
  check('Days and Times come from the data: MoTuWeThFr 10:00AM - 10:50AM, room, instructor, dates', /MoTuWeThFr 10:00AM - 10:50AM/.test(head) && /Mihaylo Hall 1xxx/.test(head) && /Dr\. Dabirian/.test(head) && /08\/24\/2026 - 12\/18\/2026/.test(head), head);
  check('counts: Enrollment Status Enrolled, Capacity 35, Enrolled 25', /Enrollment StatusEnrolled/.test(head) && /Enrollment Capacity35/.test(head) && /Enrolled25/.test(head), head);
  check('the grid is titled Enrolled Students', /Enrolled Students/.test(await card.locator('.cr-grid-title').textContent()));
  const rows = card.locator('table.roster tbody tr');
  check('25 rows', await rows.count() === 25, await rows.count());
  check('column headings', (await card.locator('table.roster th').allTextContents()).join('|') === '|ID|Name|Email|Pronouns|Units|Program and Plan|Academic Level', await card.locator('table.roster th').allTextContents());
  check('first row is 1 · Aguilar,Mariana', /^1\s*\d{9}\s*Aguilar,Mariana/.test((await rows.first().textContent()) ?? ''), await rows.first().textContent());
  const names = await card.locator('table.roster tbody td:nth-child(3)').allTextContents();
  check('Alex Student and Sam Student are on the roster', names.includes('Student,Alex') && names.includes('Student,Sam'), names.filter((n) => /Student/.test(n)));
  check('sorted by last name', names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'));
  check('footer: fictional records, private (FERPA)', /Fictional demo records\. For your class only — student records are private \(FERPA\)\./.test(await card.locator('.roster-foot').textContent()));
  check('the grid scrolls inside the card (max-height box)', await card.locator('.roster-scroll').evaluate((e) => e.scrollHeight > e.clientHeight && getComputedStyle(e).overflowY === 'auto'));
  check('header reads "25 students · 1 online"', (await page.locator('#prof-roster').textContent()).trim() === '25 students · 1 online', await page.locator('#prof-roster').textContent());
  await page.evaluate(() => { document.querySelector('#prof-log .roster-card').__keep = 'same-element'; });
  await card.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/t5-1-roster-card.png` });
  await card.screenshot({ path: `${SHOTS}/t5-1-roster-card-element.png` });

  // 2. Notify everyone: the card is kept through the redraw.
  await say('notify everyone that the midterm review session moves to Thursday');
  await page.waitForFunction(() => /Sent to all 25 students in Marketing 351\./.test(document.querySelector('#prof-log').textContent), null, { timeout: 30000 });
  check('"Sent to all 25 students in Marketing 351."', true);
  check('the roster card element survived the redraw', await page.evaluate(() => document.querySelector('#prof-log .roster-card')?.__keep === 'same-element') && await rows.count() === 25);
  const post = page.locator('#prof-log .sent-post').last();
  await post.locator('.dsum').waitFor();
  const sum = await post.locator('.dsum .pill').allTextContents();
  check('summary: "Delivered to 1" and "24 not online yet — they\'ll get it when they are"', sum.length === 2 && sum[0] === 'Delivered to 1' && sum[1] === "24 not online yet — they'll get it when they are", sum);
  check('the head says "to the whole class (25)"', /the whole class \(25\)/.test(await post.locator('.msg-head .msg-dir').textContent()));
  const fold = post.locator('details.dlist');
  check('the fold is closed and says "Show all 25 students"', await fold.evaluate((d) => !d.open) && (await fold.locator('summary').textContent()) === 'Show all 25 students');
  await fold.locator('summary').click();
  const frows = await fold.locator('.per-student li').evaluateAll((l) => l.map((x) => x.textContent));
  check('fold lists 25 students by name', frows.length === 25 && frows.some((r) => /^Mariana AguilarNot delivered yet — Mariana isn't online\. It will arrive when they are\./.test(r)), frows.slice(0, 2));
  check('Alex Student shows Delivered', frows.some((r) => /^Alex StudentDelivered/.test(r)), frows.filter((r) => /Alex/.test(r)));
  check('the fold stays open after a redraw', await page.evaluate(() => document.querySelector('#prof-log .sent-post details.dlist')?.open));
  check('header still reads "25 students · 1 online"', (await page.locator('#prof-roster').textContent()).trim() === '25 students · 1 online');
  await post.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/t5-2-notify.png` });
  await fold.locator('summary').click();
  await page.waitForTimeout(200);
  await log.screenshot({ path: `${SHOTS}/t5-2-notify-folded.png` });
  await page.locator('#prof-roster').screenshot({ path: `${SHOTS}/t5-3-header.png` });
  await page.locator('#view-professor .panel-head').screenshot({ path: `${SHOTS}/t5-3-header-bar.png` });

  // 3. A tab round trip keeps the roster card (same element, same rows).
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('tab', { name: 'Faculty view' }).click();
  await page.waitForTimeout(600);
  check('after leaving the Faculty view and coming back the card is the same element with 25 rows', await page.evaluate(() => document.querySelector('#prof-log .roster-card')?.__keep === 'same-element') && await rows.count() === 25);

  // 4. The quiz published card: the same summary.
  await say('@assistant create a quiz for Marketing 351');
  await page.locator('.tchip[data-topic="8"]').click();
  await page.waitForSelector('#prof-log .quiz-card [data-act="approve"]:not([disabled])', { timeout: 30000 });
  await page.locator('#prof-log .quiz-card [data-act="approve"]').click();
  await page.waitForSelector('#prof-log .lms-card [data-act="publish"]', { timeout: 30000 });
  check('publish prompt counts the 25 students', /your 25 students get a notification/.test(await page.locator('#prof-log .lms-card').textContent()), await page.locator('#prof-log .lms-card').textContent());
  check('publish prompt never says "2 students"', !/\b2 students\b/.test(await page.locator('#prof-log .lms-card').textContent()));
  await page.locator('#prof-log .lms-card').screenshot({ path: `${SHOTS}/t5-fix-publish-prompt.png` });
  await page.locator('#prof-log .lms-card [data-act="publish"]').click();
  await page.waitForFunction(() => /Published/.test(document.querySelector('#prof-log .lms-card .state-badge')?.textContent ?? '') && document.querySelectorAll('#prof-log .lms-card details.dlist li').length === 25, null, { timeout: 30000 });
  const lms = page.locator('#prof-log .lms-card');
  const qsum = await lms.locator('.dsum .pill').allTextContents();
  check('quiz published card: "Delivered to 1" + "24 not online yet — they\'ll get it when they are"', qsum[0] === 'Delivered to 1' && qsum[1] === "24 not online yet — they'll get it when they are", qsum);
  check('quiz fold lists 25 students, Alex Notified', await lms.locator('details.dlist li').count() === 25 && (await lms.locator('details.dlist li').allTextContents()).some((r) => /^Alex StudentNotified/.test(r)));
  await lms.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/t5-4-quiz-published.png` });

  // 5. Dark mode: the card keeps its indigo accent and stays readable.
  await page.emulateMedia({ colorScheme: 'dark' });
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  check('dark mode: the accent is the light indigo', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chrs').trim()) === '#a5b4fc');
  await page.screenshot({ path: `${SHOTS}/t5-1-roster-card-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });

  // 6. Privacy: the student's page never fetches the roster and holds no roster email or ID.
  const sawRosterFetch = [];
  student.on('request', (r) => { if (/\/api\/.*roster/.test(r.url())) sawRosterFetch.push(r.url()); });
  await student.reload();
  await student.waitForTimeout(2500);
  const html = await student.evaluate(() => document.documentElement.outerHTML);
  check('the student page never asks for the roster', sawRosterFetch.length === 0, sawRosterFetch);
  check('no roster email or 888… ID anywhere in the /conversation page', !/@csu\.fullerton\.example/.test(html) && !/\b888\d{6}\b/.test(html));
  check('the student tab\'s hidden Faculty section holds no roster rows', await student.evaluate(() => !document.querySelector('#view-professor table.roster')));

  } catch (e) {
    check('the script ran to the end', false, `${String(e).slice(0, 200)} | chat: ${((await page.locator('#prof-log').innerText().catch(() => '')) ?? '').slice(-400)}`);
  }
  check('no page or console errors', errors.length === 0, errors);
  await student?.close();
  return { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: results.length };
}
