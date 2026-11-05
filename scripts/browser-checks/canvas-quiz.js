// Browser check: Dr. Dabirian's Canvas quiz (Part 16) — topic chips, the quiz draft card, the Canvas saved and
// published cards in the Faculty view, and the student's quiz notice and toast (approved mockup
// docs/superpowers/specs/2026-11-04-canvas-quiz-mockup.html, screens 1-5).
// Run it on a SEPARATE mock stack with "today" pinned to 2026-11-04 (Topics 1-16 taught), never the user's demo
// (it presses New conversation, which resets the classroom):
//   node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock --now 2026-11-04T20:00:00Z
//   playwright-cli -s=cq open http://127.0.0.1:5544/faculty
//   playwright-cli -s=cq run-code "$(cat scripts/browser-checks/canvas-quiz.js)"
// Screenshots go to SHOTS (relative to where playwright-cli runs). The mock Faculty and Canvas are labelled
// heuristics: this checks the drawing and the plumbing, not live judgment. Look at every screenshot.
async (page) => {
  const SHOTS = '.superpowers/sdd/2026-11-04-canvas-quiz-mcp/shots';
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
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });

  // A fresh classroom (separate stack only): New conversation resets the drafts, the roster and Canvas.
  await page.goto(`${origin}/conversation`);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.waitForTimeout(1500);

  // The student's own page, open before anything is published (a toast is live-only).
  const student = await page.context().newPage();
  watch(student);
  await student.setViewportSize({ width: 1280, height: 900 });
  await student.emulateMedia({ colorScheme: 'light' });
  await student.goto(`${origin}/conversation`);
  await student.waitForTimeout(1500);

  await page.goto(`${origin}/faculty`);
  // The student's tab counts as in the background (headless pages are all "visible"), so a notice there stays
  // "Notified" until the student looks at it — only then does the signed "opened" receipt go out.
  await student.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
  await page.waitForTimeout(1500);
  const log = page.locator('#prof-log');
  const count = (sel) => page.locator(sel).count();
  async function say(text) {
    const before = await page.locator('#prof-log > li').count();
    await page.locator('#prof-message').fill(text);
    await page.locator('#prof-message').press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('#prof-log > li').length > n && !document.querySelector('#prof-log .chat-pending'), before, { timeout: 30000 });
  }

  // 1. He asks; no topic, so the assistant lists what has been taught.
  await say('@assistant create a quiz for Marketing 351');
  const lead = await log.locator('.msg-text', { hasText: 'Which topic should the quiz cover?' }).first().textContent().catch(() => '');
  check('topic question names Topic 16 and Tue, Nov 3', /through Topic 16 \(Tue, Nov 3\)\./.test(lead), lead);
  const enabled = await page.locator('.tchip:not([disabled])').evaluateAll((b) => b.map((x) => x.dataset.topic));
  const disabled = await page.locator('.tchip[disabled]').evaluateAll((b) => b.map((x) => [x.dataset.topic, x.textContent]));
  check('chips 1-16 enabled', enabled.join() === Array.from({ length: 16 }, (_, i) => i + 1).join(), enabled);
  check('chips 17-20 disabled, each with its date', disabled.length === 4 && disabled.map((d) => d[0]).join() === '17,18,19,20' && /Nov 10/.test(disabled[0][1]) && /Nov 17/.test(disabled[1][1]) && /Nov 19/.test(disabled[2][1]) && /Dec 1/.test(disabled[3][1]), disabled);
  check('three unit headings', await page.locator('.topic-pick .unit h4').allTextContents().then((t) => t.length === 3 && /Exam 1 unit\s*Topics 1–7/.test(t[0]) && /Exam 3 unit\s*Topics 15–20/.test(t[2])));
  check('no Canvas card yet, no answer key on the page', await count('.quiz-card, .lms-card') === 0);
  await log.screenshot({ path: `${SHOTS}/t9-1-topics.png` });

  // 2. Tap Topic 8: the draft card with 5 questions.
  await page.locator('#prof-message').fill('half a thought I was typing');
  await page.locator('.tchip[data-topic="8"]').click();
  await page.waitForSelector('#prof-log .quiz-card .q', { timeout: 30000 });
  const card = page.locator('#prof-log .quiz-card');
  const qs = card.locator('.q-list > .q');
  check('a chip tap leaves the text he had typed in the box', await page.locator('#prof-message').inputValue() === 'half a thought I was typing');
  await page.locator('#prof-message').fill('');
  check('once a draft exists, every chip of the old topic list is disabled', await page.locator('.tchip:not([disabled])').count() === 0);
  check('tapping Topic 8 sends his message', await log.locator('.msg-text', { hasText: 'Topic 8 · Segmentation & targeting' }).count() >= 1);
  check('draft card with 5 questions, each tagged AI draft', await qs.count() === 5 && await card.locator('.q-tag.ai').count() === 5);
  check('slip: title, badge, facts line', /Topic 8 Quiz: Segmentation & Targeting/.test(await card.locator('.q-slip .t').textContent()) && /Not in Canvas yet/.test(await card.locator('.state-badge').textContent()) && /^5 questions · 15 points · 10 minutes · 1 attempt · due Mon, Nov 9, 11:59 PM$/.test(await card.locator('.q-slip .m').textContent()), await card.locator('.q-slip .m').textContent());
  check('exactly one correct answer marked per question', await card.locator('.q-list > .q').evaluateAll((l) => l.every((q) => q.querySelectorAll('.opts li[data-correct]').length === 1)));
  check('ready line and Approve enabled', /✓\s*5 questions ready · 15 points/.test(await card.locator('.q-check').textContent()) && await card.locator('[data-act="approve"]').isEnabled());
  await page.evaluate(() => { document.querySelector('#prof-log .quiz-card').__keep = 'same-element'; });

  // 3. Edit Q2; the Faculty view keeps refreshing (a snapshot every 3 s and a redraw when the chat grows): his edit stays.
  await qs.nth(1).locator('[data-act="edit"]').click();
  const q2 = card.locator('.q-list > .q.editing');
  const typed = 'Which segmentation criterion does a segment fail when no channel can reach it?';
  await q2.locator('textarea').fill(typed);
  check('Edited by you tag appears while typing', /Edited by you/.test(await q2.locator('.q-tag').textContent()));
  await page.waitForTimeout(4000);
  check('after 4 s (a snapshot poll) the edit is still there', await card.locator('.q-list > .q.editing textarea').inputValue() === typed);
  // A redraw of the whole chat (a new assistant message) while a field is being edited.
  await say('@assistant create a quiz for Marketing 351');
  check('a second request while a draft is open: told to approve or discard first', await log.locator('.msg-text', { hasText: 'You have a draft open (Topic 8). Approve or discard it first.' }).count() === 1);
  check('the draft card element survived the redraw with the edit in it', await page.evaluate(() => document.querySelector('#prof-log .quiz-card')?.__keep === 'same-element') && await card.locator('.q-list > .q.editing textarea').inputValue() === typed);
  await q2.locator('[data-act="done"]').click();
  check('Done: Q2 shows his text, tagged Edited by you', (await qs.nth(1).locator('.stem').textContent()) === typed && /Edited by you/.test(await qs.nth(1).locator('.q-tag').textContent()));

  // 4. Remove Q3 + Undo restores it; remove it again.
  const q3 = await qs.nth(2).locator('.stem').textContent();
  await qs.nth(2).locator('[data-act="remove"]').click();
  const removed = card.locator('.q-list > .q.removed');
  const removedText = await removed.textContent();
  check('Remove: “Question 3 removed — “…” · Undo”', /^Question 3 removed — “/.test(removedText) && removedText.includes(q3.slice(0, 30)) && /Undo$/.test(removedText), removedText);
  check('slip now says 4 questions', /^4 questions · 12 points/.test(await card.locator('.q-slip .m').textContent()));
  await removed.locator('[data-act="undo"]').click();
  check('Undo puts Question 3 back', await card.locator('.q-list > .q.removed').count() === 0 && (await card.locator('.q-list > .q').nth(2).locator('.stem').textContent()) === q3 && /^5 questions/.test(await card.locator('.q-slip .m').textContent()));
  await qs.nth(2).locator('[data-act="remove"]').click();

  // 5. Add a question: Approve stays disabled, with a problem line, until the question is complete.
  await card.locator('[data-act="add"]').click();
  const added = card.locator('.q-list > .q.editing');
  check('blank question opens in edit mode, tagged Added by you', await added.count() === 1 && /Added by you/.test(await added.locator('.q-tag').textContent()));
  check('Approve disabled, the check line names the problem', await card.locator('[data-act="approve"]').isDisabled() && /Question 5: The question must be 10–300 characters\./.test(await card.locator('.q-check').textContent()), await card.locator('.q-check').textContent());
  await added.locator('textarea').fill('A coffee chain builds offers only for loyalty-app users who visit often. Which basis of segmentation is this?');
  const ans = added.locator('.edit-opts input[type="text"]');
  await ans.nth(0).fill('Geographic');
  await ans.nth(1).fill('Demographic');
  await ans.nth(2).fill('Psychographic');
  check('three answers filled: still disabled (a fourth answer is missing)', await card.locator('[data-act="approve"]').isDisabled() && /Every answer needs text\./.test(await card.locator('.q-check').textContent()), await card.locator('.q-check').textContent());
  await ans.nth(3).fill('Usage-rate');
  check('four answers but no correct one: still disabled, says to pick one', await card.locator('[data-act="approve"]').isDisabled() && /Pick exactly one correct answer\./.test(await card.locator('.q-check').textContent()), await card.locator('.q-check').textContent());
  await added.locator('.edit-opts input[type="radio"]').nth(3).check();
  check('correct answer picked: Approve enabled, ready line', await card.locator('[data-act="approve"]').isEnabled() && /✓\s*5 questions ready · 15 points/.test(await card.locator('.q-check').textContent()), await card.locator('.q-check').textContent());
  await added.locator('[data-act="done"]').click();
  check('the added question is tagged Added by you and marks Usage-rate correct', /Added by you/.test(await qs.nth(5).locator('.q-tag').textContent()) && /Usage-rate/.test(await qs.nth(5).locator('.opts li[data-correct]').textContent()));
  // Pictures of the whole card: a tall window, so the card is not cut by the chat's own scrolling.
  await page.setViewportSize({ width: 1280, height: 2400 });
  await page.waitForTimeout(400);
  await card.screenshot({ path: `${SHOTS}/t9-2-draft-b.png` });
  await page.setViewportSize({ width: 1280, height: 1000 });

  // 6. Draft one more with AI: a 6th question.
  await card.locator('[data-act="more"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#prof-log .quiz-card .q-list > .q:not(.removed)').length === 6, null, { timeout: 30000 });
  check('Draft one more: 6 questions, the new one tagged AI draft', await card.locator('.q-list > .q:not(.removed)').count() === 6 && /AI draft/.test(await card.locator('.q-list > .q').last().locator('.q-tag').textContent()) && /^6 questions · 18 points/.test(await card.locator('.q-slip .m').textContent()));
  await page.setViewportSize({ width: 1280, height: 2400 });
  await page.waitForTimeout(400);
  await card.screenshot({ path: `${SHOTS}/t9-2-draft.png` });
  // Leaving the Faculty tab and coming back keeps a half-done edit (and takes the answer key out of the page meanwhile).
  await page.setViewportSize({ width: 1280, height: 1000 });
  await qs.nth(1).locator('[data-act="edit"]').click();
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.waitForTimeout(600);
  check('while another tab shows, no answer key is in the page', await page.evaluate(() => document.querySelectorAll('[data-correct], .quiz-card .q').length) === 0);
  await page.getByRole('tab', { name: 'Faculty view' }).click();
  await page.waitForSelector('#prof-log .quiz-card .q.editing textarea');
  check('back on the Faculty tab: the open edit row and his typed text are still there', await page.locator('#prof-log .quiz-card .q.editing textarea').inputValue() === typed && /Edited by you/.test(await page.locator('#prof-log .quiz-card .q.editing .q-tag').textContent()));
  check('back on the Faculty tab: his removal and added question are still there', await page.locator('#prof-log .quiz-card .q-list > .q.removed').count() === 1 && await page.locator('#prof-log .quiz-card .q-list > .q:not(.removed)').count() === 6);
  await page.locator('#prof-log .quiz-card .q.editing [data-act="done"]').click();
  await page.setViewportSize({ width: 1280, height: 2400 });
  await page.waitForTimeout(300);
  // Dark mode: the card stays readable.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await card.screenshot({ path: `${SHOTS}/t9-dark-draft.png` });
  await page.setViewportSize({ width: 1280, height: 1000 });
  const dark = await card.evaluate((c) => { const cs = getComputedStyle(c); const t = getComputedStyle(c.querySelector('.stem')); return { bg: cs.backgroundColor, text: t.color }; });
  const lum = (css) => { const [r, g, b] = css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  check('dark mode: light text on a dark card', lum(dark.bg) < 90 && lum(dark.text) > 160, dark);
  await page.emulateMedia({ colorScheme: 'light' });

  // 7. Approve. First press: Canvas "didn't answer" (a 503 with the result's text). The card reopens with that
  //    sentence; the next press reuses the SAME operation ID, then it goes through.
  const ops = [];
  let blocked = false;
  await page.route('**/api/professor/quiz/actions', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action !== 'approve') return route.continue();
    ops.push(body.operationId);
    if (!blocked) {
      blocked = true;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, retryable: true, unknownOutcome: true, state: 'draft', text: "Canvas didn't answer. Nothing is posted until it confirms — press Approve again; it won't post twice." }) });
    }
    return route.continue();
  });
  await card.locator('[data-act="approve"]').click();
  await page.waitForFunction(() => /Canvas didn't answer/.test(document.querySelector('#prof-log .quiz-card .q-error')?.textContent ?? ''), null, { timeout: 15000 });
  check('Canvas didn’t answer: the card is back with the exact sentence', await page.locator('#prof-log .quiz-card .q-error').textContent() === "Canvas didn't answer. Nothing is posted until it confirms — press Approve again; it won't post twice.");
  check('the card kept his edits after the failed attempt', await card.locator('.q-list > .q:not(.removed)').count() === 6);
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('tab', { name: 'Faculty view' }).click();
  await page.waitForSelector('#prof-log .quiz-card [data-act="approve"]');
  check('after leaving and returning, the failure sentence is still on the card', /Canvas didn't answer/.test(await page.locator('#prof-log .quiz-card .q-error').textContent()));
  await page.locator('#prof-log .quiz-card [data-act="approve"]').click();
  await page.waitForSelector('#prof-log .lms-card', { timeout: 30000 });
  check('pressing Approve again (after leaving and returning) reuses the same operation ID', ops.length === 2 && ops[0] === ops[1], ops);
  await page.unroute('**/api/professor/quiz/actions');
  const approved = await log.locator('li.msg', { hasText: 'You approved the quiz' }).last().textContent();
  check('his approval bubble counts what he changed', /Topic 8 Quiz: Segmentation & Targeting — 6 questions \(1 edited, 1 added, 1 removed by you\)/.test(approved), approved);
  const lms = page.locator('#prof-log .lms-card');
  const lmsText = await lms.textContent();
  check('Canvas card: saved as an unpublished quiz — students can’t see it yet', /Saved in Canvas as an unpublished quiz — students can't see it yet\./.test(lmsText), lmsText);
  check('Canvas card: quiz #4821 · MKTG 351 (Fall 2026)', /#4821 · MKTG 351 \(Fall 2026\)/.test(lmsText));
  check('Canvas card: facts and due date', /6 · 18 points · 10 minutes · 1 attempt/.test(lmsText) && /Mon, Nov 9, 11:59 PM/.test(lmsText), lmsText);
  check('Canvas card: asks to publish, with the student count', /Publish it now\? Publishing makes it visible in Canvas, and your 2 students get a notification\./.test(lmsText), lmsText);
  check('Canvas card: Publish & notify students and Keep as draft', await lms.locator('[data-act="publish"]').isEnabled() && await lms.locator('[data-act="keep"]').isEnabled());
  check('the draft card is gone', await count('#prof-log .quiz-card') === 0);
  await page.evaluate(() => document.querySelector('#prof-log .lms-card').scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/t9-3-saved.png` });

  // 8. Keep as draft, then Publish: the Published card with each student's notice.
  await lms.locator('[data-act="keep"]').click();
  await page.waitForFunction(() => /Kept as a draft in Canvas \(quiz #4821\)\. Nobody was notified\./.test(document.querySelector('#prof-log .lms-card')?.textContent ?? ''), null, { timeout: 15000 });
  check('Keep as draft: “Kept as a draft in Canvas (quiz #4821). Nobody was notified.”', /Kept as a draft in Canvas \(quiz #4821\)\. Nobody was notified\./.test(await lms.textContent()));
  check('after Keep the card still offers Publish & notify students (and no second Keep)', await lms.locator('[data-act="publish"]').isEnabled() && await lms.locator('[data-act="keep"]').count() === 0);
  check('the student page got no notice from keeping a draft', await student.locator('#student-log .quiz-notice').count() === 0);
  await lms.locator('[data-act="publish"]').click();
  await page.waitForFunction(() => /Published/.test(document.querySelector('#prof-log .lms-card .state-badge')?.textContent ?? ''), null, { timeout: 30000 });
  const pub = await lms.textContent();
  check('Published card: ● Published, quiz #4821, due date', /● Published/.test(pub) && /Topic 8 Quiz: Segmentation & Targeting is open in Canvas \(quiz #4821\), due Mon, Nov 9, 11:59 PM\./.test(pub), pub);
  await page.waitForFunction(() => document.querySelectorAll('#prof-log .lms-card .per-student li').length === 2, null, { timeout: 15000 });
  const rows = await lms.locator('.per-student li').evaluateAll((l) => l.map((x) => x.textContent));
  check('Alex Student: Notified (his tab is in the background, so not opened)', rows.some((r) => /^Alex StudentNotified — /.test(r)), rows);
  check('Sam Student: Queued at Hub — their student agent isn’t connected', rows.some((r) => /^Sam StudentQueued at Hub — their student agent isn’t connected/.test(r)), rows);
  check('no publish buttons left after publishing', await lms.locator('[data-act]').count() === 0);
  await page.evaluate(() => document.querySelector('#prof-log .lms-card').scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/t9-4-published.png` });

  // 9. The student's page: the notice, no Reply, the toast, and no answer key anywhere.
  await student.waitForSelector('#student-log .quiz-notice', { timeout: 30000 });
  const notice = student.locator('#student-log .quiz-notice');
  check('exactly one quiz notice', await notice.count() === 1);
  check('notice header: Dr. Dabirian → the whole class', /Dr\. Dabirian → the whole class/.test(await notice.locator('.msg-dir').textContent()), await notice.locator('.msg-dir').textContent());
  check('notice has a Quiz tag and names the quiz', await notice.locator('.kind-tag').textContent() === 'Quiz' && /A new quiz is open in Canvas: Topic 8 Quiz: Segmentation & Targeting\./.test(await notice.locator('.msg-text').textContent()));
  check('notice facts line', /^6 questions · 18 points · 10 minutes · 1 attempt · due Mon, Nov 9, 11:59 PM$/.test(await notice.locator('.quiz-facts').textContent()), await notice.locator('.quiz-facts').textContent());
  check('“Notice only — take it in Canvas”', await notice.locator('.no-action').textContent() === 'Notice only — take it in Canvas');
  check('no Reply button, no button at all, no meeting times on the notice', await notice.locator('button, .reply-action, .meeting-times').count() === 0);
  const toast = student.locator('#toasts .toast');
  check('toast: New quiz in Marketing 351', await toast.count() >= 1 && /New quiz in Marketing 351/.test(await toast.first().locator('.toast-title').textContent()), await toast.allTextContents());
  check('toast text: title — due Mon, Nov 9', await toast.first().locator('.toast-text').textContent() === 'Topic 8 Quiz: Segmentation & Targeting — due Mon, Nov 9', await toast.first().locator('.toast-text').textContent());
  const keyOnStudent = await student.evaluate(() => ({ marker: document.querySelectorAll('[data-correct]').length, quizCards: document.querySelectorAll('.quiz-card, .lms-card, .q-list').length, word: /\bcorrect\b/i.test(document.body.innerText), html: /data-correct/.test(document.documentElement.outerHTML) }));
  check('the student page never shows or holds an answer key', keyOnStudent.marker === 0 && keyOnStudent.quizCards === 0 && !keyOnStudent.word && !keyOnStudent.html, keyOnStudent);
  const fetched = await student.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /\/api\/professor\/quiz/.test(n)));
  check('the student page never fetched a quiz draft', fetched.length === 0, fetched);
  await student.screenshot({ path: `${SHOTS}/t9-5-student.png` });
  // Looking at it counts as opening: the faculty's per-student line changes from Notified to Opened.
  await student.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => /^Alex StudentOpened/.test(document.querySelector('#prof-log .lms-card .per-student li')?.textContent ?? ''), null, { timeout: 20000 });
  check('once the student looks at it, Alex Student shows Opened', true);
  // The same Conversation tab of the Faculty window, after visiting the Faculty view, holds no answer key either.
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.waitForTimeout(500);
  check('leaving the Faculty view removes the cards (and their answer key) from the page', await page.evaluate(() => document.querySelectorAll('.quiz-card, .lms-card, [data-correct]').length) === 0);
  await page.getByRole('tab', { name: 'Faculty view' }).click();
  await page.waitForTimeout(1200);
  check('coming back: the Canvas card is drawn again as Published', /● Published/.test(await page.locator('#prof-log .lms-card').textContent()));

  // 9b. Final review C-1: only the newest topic list has live chips; a tap with the Reply chip active makes no post.
  // He messages Alex and Alex answers (that gives him a ↩ Reply button), then he asks for a quiz again.
  await page.request.post(`${origin}/api/professor/chat`, { data: { operationId: `op-${Date.now()}-note`, text: '@student-alex Please read chapter 2 before Friday.' } });
  await student.locator('#student-log button', { hasText: 'Reply' }).first().waitFor({ timeout: 20000 });
  await student.locator('#student-log button', { hasText: 'Reply' }).first().click();
  await student.locator('#message').fill('Thanks, I will read it.');
  await student.locator('#message').press('Enter');
  await page.locator('#prof-log button.reply-action').first().waitFor({ timeout: 20000 });
  await say('@assistant create a quiz for Marketing 351');
  const lists = page.locator('#prof-log li.has-topics');
  check('two topic lists in the chat: the old one disabled, the newest live', await lists.count() === 2 && await lists.nth(0).locator('.tchip:not([disabled])').count() === 0 && await lists.nth(1).locator('.tchip:not([disabled])').count() === 16);
  const before9b = await page.evaluate(async () => (await (await fetch('/api/professor/state')).json()).lessons.length);
  await page.locator('#prof-log button.reply-action').last().click();
  check('the Reply chip is active', await page.locator('#prof-reply-chip').isVisible());
  await page.locator('#prof-message').fill('half a thought');
  await lists.nth(1).locator('.tchip[data-topic="9"]').click();
  await page.waitForSelector('#prof-log .quiz-card .q', { timeout: 30000 });
  const afterChip = await page.evaluate(async () => (await (await fetch('/api/professor/state')).json()).lessons.length);
  check('the chip tap with the Reply chip active created no post', afterChip === before9b, [before9b, afterChip]);
  check('the Reply chip and the half-typed text are exactly as they were', await page.locator('#prof-reply-chip').isVisible() && await page.locator('#prof-message').inputValue() === 'half a thought');
  const chipMsg = await page.evaluate(async () => (await (await fetch('/api/professor/state')).json()).chat.filter((m) => m.role === 'professor' && /^Topic 9 · /.test(m.text)));
  check('the chip message is recorded as his message to the assistant, not as a reply to Alex', chipMsg.length === 1 && !chipMsg[0].replyTo && chipMsg[0].toAssistant === true, chipMsg);
  check('once the new draft exists, the newest list’s chips are disabled too', await page.locator('.tchip:not([disabled])').count() === 0);
  await page.locator('#prof-message').fill('');
  await page.locator('#prof-reply-clear').click();
  await page.locator('#prof-log .quiz-card [data-act="discard"]').click();
  await page.waitForTimeout(800);

  // 10. After a restart/reset the cards are closed, never stale.
  await page.getByRole('tab', { name: 'Conversation' }).click();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('tab', { name: 'Faculty view' }).click();
  await page.waitForTimeout(1500);
  check('after New conversation no Canvas card is left to press', await page.locator('#prof-log .lms-card, #prof-log .quiz-card, #prof-log [data-act]').count() === 0);

  await student.close();
  const injected = errors.filter((e) => /status of 503/.test(e)); // the one 503 this check injects on purpose (step 7)
  check('the only console error is the injected 503', injected.length === 1, injected);
  const other = errors.filter((e) => !/status of 503/.test(e));
  check('no other page or console errors', other.length === 0, other);
  return { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: results.length };
}
