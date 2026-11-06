// Browser check: the CHRS class roster (Part 17) — the "CHRS · Class roster" card, the header count, and the delivery
// summary + fold for big audiences, and roster questions in general (section 7b2, 2026-11-05) (approved mockup docs/superpowers/specs/2026-11-05-chrs-roster-mockup.html, screens 1-3).
// Run it on a SEPARATE mock stack with "today" pinned to 2026-11-04 (it presses New conversation, which resets the classroom):
//   node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock --now 2026-11-04T20:00:00Z
//   playwright-cli -s=cr open http://127.0.0.1:5544/faculty
//   playwright-cli -s=cr run-code "$(cat scripts/browser-checks/chrs-roster.js)"
// The class cancellation summary is checked at the end of scripts/browser-checks/hr-card.js. The mock Faculty and CHRS are
// labelled heuristics: this checks drawing and plumbing, not live judgment. Look at every screenshot.
// Section 8 (F1, the quiz notice when the class list is unavailable) runs only when the page was opened with
// ?f1=<Hub port> (e.g. http://127.0.0.1:5544/faculty?f1=52343). It needs CHRS paused from a shell at the right moment:
// when the screenshot s-f1-0-stop-chrs.png appears, run `kill -STOP <CHRS pid>`; when s-f1-3-start-chrs.png appears,
// run `kill -CONT <CHRS pid>`. The script waits for the Hub to see CHRS go down and come back.
async (page) => {
  const SHOTS = '.superpowers/sdd/2026-11-05-chrs-roster/shots';
  page.setDefaultTimeout(30000);
  const results = [];
  const errors = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  const origin = await page.evaluate(() => location.origin);
  const hubPort = await page.evaluate(() => new URLSearchParams(location.search).get('f1')); // section 8 only (read before the first goto)
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
  check('Days and Times come from the data: MoTuWeThFr 10:00AM - 10:50AM, room, instructor, dates', /MoTuWeThFr 10:00AM - 10:50AM/.test(head) && /Mihaylo Hall 2405/.test(head) && /Dr\. Dabirian/.test(head) && /08\/24\/2026 - 12\/18\/2026/.test(head), head);
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
  await page.waitForFunction(() => /Sent to your 25 students\. 1 student received it in the app\. 24 students aren't online, so they were emailed\./.test(document.querySelector('#prof-log').textContent), null, { timeout: 30000 });
  check('review A4: "Sent to your 25 students. 1 student received it in the app. 24 students aren\'t online, so they were emailed."', true);
  check('the roster card element survived the redraw', await page.evaluate(() => document.querySelector('#prof-log .roster-card')?.__keep === 'same-element') && await rows.count() === 25);
  const post = page.locator('#prof-log .sent-post').last();
  await post.locator('.dsum').waitFor();
  const sum = await post.locator('.dsum .pill').allTextContents();
  check('summary: "Delivered to 1" and "Emailed 24" (review C16)', sum.length === 2 && sum[0] === 'Delivered to 1' && sum[1] === 'Emailed 24', sum);
  check('the head says "to the whole class (25)"', /the whole class \(25\)/.test(await post.locator('.msg-head .msg-dir').textContent()));
  const fold = post.locator('details.dlist');
  check('the fold is closed and says "Show all 25 students"', await fold.evaluate((d) => !d.open) && (await fold.locator('summary').textContent()) === 'Show all 25 students');
  await fold.locator('summary').click();
  const frows = await fold.locator('.per-student li').evaluateAll((l) => l.map((x) => x.textContent));
  check('fold lists 25 students by name', frows.length === 25 && frows.some((r) => /^Mariana AguilarEmailed — Mariana isn't online, so they were emailed\. They'll also receive it in the app when they're online\./.test(r)), frows.slice(0, 2));
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
  check('quiz published card: "Delivered to 1" + "Emailed 24"', qsum[0] === 'Delivered to 1' && qsum[1] === 'Emailed 24', qsum);
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

  // 7. F3: a student's details are shown on the roster card with that row highlighted; the chat has the sentence only.
  await page.emulateMedia({ colorScheme: 'light' });
  await say("what's Hana Yamamoto's email?");
  await page.waitForSelector('#prof-log .roster-card[data-highlight="student-hana-yamamoto"][data-state="ready"]', { timeout: 30000 });
  const hiCard = page.locator('#prof-log .roster-card[data-highlight="student-hana-yamamoto"]');
  const hiRows = hiCard.locator('tr.cr-hi');
  check('F3: exactly one highlighted row, Hana Yamamoto', await hiRows.count() === 1 && /Yamamoto,Hana/.test(await hiRows.first().textContent()), await hiRows.count());
  check('F3: the reply names the student only', await page.locator('#prof-log').evaluate((l) => [...l.querySelectorAll(':scope > li')].some((li) => /^Hana Yamamoto is highlighted on your roster below\.$/.test(li.querySelector('.msg-text')?.textContent ?? ''))));
  check('F3: the chat bubbles (outside the roster cards) hold no email or ID', await page.locator('#prof-log').evaluate((l) => ![...l.querySelectorAll(':scope > li:not(.roster-card)')].some((li) => /@csu\.fullerton\.example|\b888\d{6}\b/.test(li.textContent))));
  await page.waitForTimeout(400);
  const inBox = await hiCard.evaluate((c) => { const box = c.querySelector('.roster-scroll').getBoundingClientRect(); const r = c.querySelector('tr.cr-hi').getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom + 1; });
  check('F3: the highlighted row (row 25) is scrolled into view inside the card', inBox);
  await hiCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/s-f3-highlight.png` });
  await hiCard.screenshot({ path: `${SHOTS}/s-f3-highlight-card.png` });

  // 7b. Round 2, R4: "who are my seniors?" highlights every senior row (which rows come only with the rows); the chat says the
  // count only.
  await say('who are my seniors?');
  await page.waitForFunction(() => { const c = [...document.querySelectorAll('#prof-log .roster-card')].at(-1); return c?.dataset.state === 'ready' && c.querySelectorAll('tr.cr-hi').length > 1; }, null, { timeout: 30000 });
  const sCard = page.locator('#prof-log .roster-card').last();
  const sRows = sCard.locator('tr.cr-hi');
  const sCount = await sRows.count();
  const sLevels = await sRows.locator('td:last-child').allTextContents();
  check('R4: every highlighted row is a Senior, and every Senior row is highlighted', sLevels.every((l) => l.trim() === 'Senior') && (await sCard.locator('tbody tr td:last-child').allTextContents()).filter((l) => l.trim() === 'Senior').length === sCount, sLevels);
  check(`R4: the reply says the count only ("${sCount} seniors are highlighted on your roster below.")`, await page.locator('#prof-log').evaluate((l, n) => [...l.querySelectorAll(':scope > li')].some((li) => (li.querySelector('.msg-text')?.textContent ?? '') === `${n} seniors are highlighted on your roster below.`), sCount));
  check('R4: no level or major in the chat bubbles outside the roster cards', await page.locator('#prof-log').evaluate((l) => ![...l.querySelectorAll(':scope > li:not(.roster-card)')].some((li) => /\bSenior\b|Business Admin/.test(li.textContent))));
  await page.waitForTimeout(400);
  await sCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/s2-r4-seniors.png` });
  await sCard.screenshot({ path: `${SHOTS}/s2-r4-seniors-card.png` });

  // 7b2. Roster questions in general (owner, 2026-11-05: "anyone not a business major?" was posted to all 25): the answer
  // highlights the matching rows, the chat says the count only, and nothing goes to the class.
  const postsBefore = (await (await page.request.get(`${origin}/api/professor/state`)).json()).lessons.length;
  await say('anyone not a business major?');
  await page.waitForFunction(() => { const c = [...document.querySelectorAll('#prof-log .roster-card')].at(-1); return c?.dataset.state === 'ready' && c.querySelectorAll('tr.cr-hi').length > 0 && c.querySelectorAll('tr.cr-hi').length < 10; }, null, { timeout: 30000 });
  const qCard = page.locator('#prof-log .roster-card').last();
  const qPlans = await qCard.locator('tr.cr-hi td:nth-last-child(2)').allTextContents();
  const allPlans = await qCard.locator('tbody tr td:nth-last-child(2)').allTextContents();
  check('S3: "anyone not a business major?" highlights exactly the rows outside Business Admin', qPlans.length === allPlans.filter((t) => !/Business Admin/.test(t)).length && qPlans.every((t) => !/Business Admin/.test(t)), qPlans);
  check(`S3: the reply is "Yes — ${qPlans.length} students match; they're highlighted on your roster below."`, await page.locator('#prof-log').evaluate((l, n) => [...l.querySelectorAll(':scope > li')].some((li) => (li.querySelector('.msg-text')?.textContent ?? '') === `Yes — ${n} students match; they're highlighted on your roster below.`), qPlans.length));
  const postsAfter = (await (await page.request.get(`${origin}/api/professor/state`)).json()).lessons.length;
  check('S3: nothing was posted to the class', postsAfter === postsBefore, { postsBefore, postsAfter });
  check('S3: no major in the chat bubbles outside the roster cards', await page.locator('#prof-log').evaluate((l) => ![...l.querySelectorAll(':scope > li:not(.roster-card)')].some((li) => /Communications -|Graphic Design|Business Admin/.test(li.textContent))));
  await page.waitForTimeout(400);
  await qCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/s3-not-business.png` });
  await qCard.screenshot({ path: `${SHOTS}/s3-not-business-card.png` });

  // 7c. Round 2, R2: @-suggestions come from the roster (names only), and @mariana reaches Mariana Aguilar.
  const box = page.locator('#prof-message');
  await box.fill('');
  await box.click();
  await box.pressSequentially('@agu', { delay: 40 });
  await page.waitForFunction(() => !document.querySelector('#mention-list').hidden && /Mariana Aguilar/.test(document.querySelector('#mention-list').textContent), null, { timeout: 15000 }).catch(() => {});
  const sugg = await page.locator('#mention-list li').allTextContents();
  check('R2: "@agu" suggests "@mariana — Mariana Aguilar" (last-name match, roster names)', sugg.length === 1 && sugg[0] === '@mariana — Mariana Aguilar', sugg);
  await page.locator('#view-professor').screenshot({ path: `${SHOTS}/s2-r2-suggest-agu.png` });
  await box.fill('');
  await box.pressSequentially('@', { delay: 40 });
  await page.waitForTimeout(400);
  const all = await page.locator('#mention-list li').allTextContents();
  check('R2: "@" lists the assistant and roster students (more than the two sessions), no email or ID', all.length > 3 && /^@assistant/.test(all[0]) && all.some((t) => /Mariana Aguilar/.test(t)) && !all.some((t) => /@csu|888\d{6}|student-/.test(t)), all);
  await page.screenshot({ path: `${SHOTS}/s2-r2-suggest-all.png` });
  await box.fill('');
  await box.pressSequentially('@mari', { delay: 40 });
  await page.waitForTimeout(300);
  await box.press('Enter');
  check('R2: picking the suggestion writes "@mariana "', (await box.inputValue()) === '@mariana ', await box.inputValue());
  await box.pressSequentially('please resubmit your assignment', { delay: 10 });
  const beforeN = await page.locator('#prof-log > li').count();
  await box.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#prof-log > li').length > n && !document.querySelector('#prof-log .chat-pending'), beforeN, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const lastPost = page.locator('#prof-log .sent-post').last();
  const lastText = ((await lastPost.textContent()) ?? '').replace(/\s+/g, ' ');
  check('R2: "@mariana please resubmit your assignment" went to Mariana Aguilar (not "There\'s no @mariana")', /please resubmit your assignment/.test(lastText) && /Mariana/.test(lastText) && !(await page.locator('#prof-log').textContent()).includes("There's no @mariana"), lastText.slice(0, 200));
  await lastPost.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/s2-r2-mariana-sent.png` });

  // 8. F1 (only with ?f1=<Hub port>): Canvas publishes, the class list is unavailable, and the card keeps the sentence and a
  // retry button across a reload and a tab round trip; once the list is back the retry notifies the class (Canvas once).
  if (hubPort) {
    const expected = errors.length; // the retryable publish answers 503 and the old roster card's fetch 404 after the reset: expected here
    const chrsStatus = async () => { try { const r = await page.request.get(`http://127.0.0.1:${hubPort}/viz/topology`); return (await r.json()).specialists.find((x) => x.agentId === 'chrs')?.status ?? null; } catch { return null; } };
    const until = async (want, what) => { for (let i = 0; i < 240; i++) { if (want(await chrsStatus())) return true; await page.waitForTimeout(500); } throw new Error(`timed out waiting for ${what}`); };
    const facultyUrl = `${origin}/faculty`;
    await page.goto(`${origin}/conversation`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'New conversation' }).click(); // clears the Hub's 60 s roster cache
    await page.waitForTimeout(1500);
    await page.goto(facultyUrl);
    await page.waitForTimeout(1500);
    await say('@assistant create a quiz for Marketing 351');
    await page.locator('.tchip[data-topic="8"]').last().click();
    await page.waitForSelector('#prof-log .quiz-card [data-act="approve"]:not([disabled])', { timeout: 30000 });
    await page.locator('#prof-log .quiz-card [data-act="approve"]').click();
    await page.waitForSelector('#prof-log .lms-card [data-act="publish"]', { timeout: 30000 });
    await page.screenshot({ path: `${SHOTS}/s-f1-0-stop-chrs.png` });
    await until((st) => st && st !== 'ready', 'CHRS to go down');
    await page.locator('#prof-log .lms-card [data-act="publish"]').click();
    const NO_LIST = "Published in Canvas, but I couldn't get your class list, so students weren't told yet. Press Publish again in a moment — they're notified only once.";
    const owed = page.locator('#prof-log .lms-card [data-notice="pending"]');
    await owed.waitFor({ timeout: 60000 });
    const lmsCard = page.locator('#prof-log .lms-card');
    const showsOwed = async () => (await owed.count()) === 1 && (await owed.locator('.lms-note[role="status"]').textContent()) === NO_LIST && (await owed.locator('[data-act="publish"]').textContent()) === 'Publish & notify students' && /● Published/.test(await lmsCard.textContent()) && !/Sending…/.test(await lmsCard.textContent());
    check('F1: published card shows the class-list sentence and "Publish & notify students" (no "Sending…")', await showsOwed(), await lmsCard.textContent());
    await page.waitForTimeout(3500); // a 3 s state refresh redraws the card from the server summary
    check('F1: still shown after a redraw', await showsOwed());
    await lmsCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/s-f1-1-notice-owed.png` });
    await lmsCard.screenshot({ path: `${SHOTS}/s-f1-1-notice-owed-card.png` });
    await page.getByRole('tab', { name: 'Conversation' }).click();
    await page.waitForTimeout(400);
    await page.getByRole('tab', { name: 'Faculty view' }).click();
    await page.waitForTimeout(1500);
    check('F1: still shown after leaving the Faculty view and coming back', await showsOwed());
    await page.reload();
    await page.waitForTimeout(2500);
    await owed.waitFor({ timeout: 15000 }).catch(() => {});
    check('F1: still shown after a page reload', await showsOwed());
    await page.screenshot({ path: `${SHOTS}/s-f1-2-after-reload.png` });
    await page.screenshot({ path: `${SHOTS}/s-f1-3-start-chrs.png` });
    await until((st) => st === 'ready', 'CHRS to come back');
    await owed.locator('[data-act="publish"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#prof-log .lms-card details.dlist li').length === 25, null, { timeout: 60000 });
    const fsum = await lmsCard.locator('.dsum .pill').allTextContents();
    check('F1: after the retry the summary replaces the sentence: "Delivered to 1" + "Emailed 24"', fsum[0] === 'Delivered to 1' && fsum[1] === 'Emailed 24' && (await owed.count()) === 0, fsum);
    await lmsCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/s-f1-4-delivered.png` });
    await lmsCard.screenshot({ path: `${SHOTS}/s-f1-4-delivered-card.png` });
    const later = errors.splice(expected);
    errors.push(...later.filter((e) => !/status of (503|404) /.test(e)));
  }

  } catch (e) {
    check('the script ran to the end', false, `${String(e).slice(0, 200)} | chat: ${((await page.locator('#prof-log').innerText().catch(() => '')) ?? '').slice(-400)}`);
  }
  check('no page or console errors', errors.length === 0, errors);
  await student?.close();
  return { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: results.length };
}
