// Browser check: record what every tab shows during one scripted session, so a change that must not be
// visible (Step 10: the screen moves onto AG-UI) can be compared before and after. Run it on a SEPARATE
// mock stack (deterministic text) — it presses New conversation, which resets the classroom:
//   node scripts/demo/rehearsal-stack.js --ui 5444 --base 52240 --mock
//   playwright-cli -s=same open http://127.0.0.1:5444/conversation
//   playwright-cli -s=same run-code "$(sed 's#__SHOTS__#/tmp/shots#' scripts/browser-checks/same-screen.js)" > before.json
// Times, IDs and dates are normalized; compare the two outputs with `diff`.
async (page) => {
  page.setDefaultTimeout(60000);
  const SHOTS = '__SHOTS__';
  const base = await page.evaluate(() => location.origin);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const norm = (s) => String(s ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\d{2}:\d{2}:\d{2}(\.\d{3})?/g, '<time>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/ls-[0-9a-f]+-[0-9a-f]+/g, '<lesson>')
    .replace(/run[0-9a-f]{6,}/g, 'run<short>')
    .replace(/dl-[0-9a-f]{16}/g, 'dl-<id>')
    .replace(/(booking|request|renewal|loans?)-[0-9a-f]{8}/g, '$1-<short>')
    .replace(/\d{1,2}:\d{2} ?[AP]M/g, '<clock>')
    .replace(/\b[0-9a-f]{8}\b/g, '<short>')
    .replace(/\b(RN|BK|TR|RQ|av)-[A-Za-z0-9-]+/g, '<ref>')
    .replace(/\d+(\.\d+)? ?ms\b/g, '<ms>')
    .replace(/[ \t]+/g, ' ').trim();
  const LOGS = ['student-log', 'studentc-log', 'hub-log', 'tutor-log', 'library-log', 'professor-log', 'prof-log', 'prof-roster', 'lesson-list', 'timeline'];
  async function dump(label, p = page) {
    const raw = await p.evaluate((ids) => ({
      logs: Object.fromEntries(ids.map((id) => [id, [...(document.getElementById(id)?.children ?? [])].map((c) => c.textContent)])),
      state: document.getElementById('state')?.dataset.state ?? null,
      badges: ['browser-feed', 'hub-feed', 'router-mode', 'tutor-mode'].map((id) => document.getElementById(id)?.textContent ?? null),
      strip: [...document.querySelectorAll('#timeline [data-step]')].map((li) => `${li.dataset.step}:${li.dataset.state}:${li.dataset.active ?? ''}`),
      send: document.getElementById('send')?.disabled ?? null,
    }), LOGS);
    for (const k of Object.keys(raw.logs)) raw.logs[k] = raw.logs[k].map(norm);
    raw.badges = raw.badges.map(norm);
    await p.screenshot({ path: `${SHOTS}/${label}.png`, fullPage: true }).catch(() => {});
    return { label, ...raw };
  }
  async function send(text) {
    await page.locator('#message').fill(text);
    await page.locator('#message').press('Enter');
    await page.waitForTimeout(500);
    for (let i = 0; i < 200 && await page.locator('#send').isDisabled(); i++) await page.waitForTimeout(150);
    await page.waitForTimeout(1500); // late telemetry (specialist events trail the A2A reply)
  }
  const uuid = () => page.evaluate(() => crypto.randomUUID());
  const out = [];

  await page.goto(`${base}/conversation`);
  await page.waitForTimeout(1500);
  if (await page.getByRole('button', { name: 'New conversation' }).isVisible()) {
    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.waitForTimeout(2500);
  }
  out.push(await dump('01-fresh'));
  await send('What is the derivative of x^4?');
  out.push(await dump('02-tutor-answer'));
  await send('help');
  out.push(await dump('03-student-clarifies'));
  await send('with renewing a library book');
  out.push(await dump('04-answer-to-clarification'));
  await send('I want to reserve a group study room');
  out.push(await dump('05-booking-form'));
  const cancel = page.getByRole('button', { name: 'Cancel' }).last();
  if (await cancel.isVisible().catch(() => false)) { await cancel.click(); await page.waitForTimeout(2000); }
  out.push(await dump('06-form-cancelled'));
  // The professor sends a message and a lesson while the student is idle.
  await page.request.post(`${base}/api/professor/chat`, { data: { operationId: await uuid(), text: '@student-alex Please read chapter 2 before Friday.' } });
  await page.waitForTimeout(3000); // let the message be delivered and opened before the lesson (deterministic order)
  await page.request.post(`${base}/api/professor/lessons`, { data: { operationId: await uuid(), kind: 'lesson', title: 'Pricing basics', text: 'Value-based pricing sets the price by what the customer gains.', audience: 'all' } });
  await page.waitForTimeout(5000);
  out.push(await dump('07-professor-message-and-lesson'));
  const reply = page.locator('#student-log button', { hasText: 'Reply' }).first();
  if (await reply.isVisible().catch(() => false)) {
    await reply.click();
    await send('Thanks, I will read it.');
  }
  out.push(await dump('08-reply-to-professor'));
  await page.reload();
  await page.waitForTimeout(3000);
  out.push(await dump('09-after-reload'));
  await page.getByRole('tab', { name: 'Professor view' }).click();
  await page.waitForTimeout(4000);
  out.push(await dump('10-professor-view'));
  await page.getByRole('tab', { name: 'Agent activity' }).click();
  await page.waitForTimeout(1000);
  out.push(await dump('11-agent-activity'));
  const second = await page.context().newPage();
  await second.goto(`${base}/conversation`);
  await second.waitForTimeout(3000);
  out.push(await dump('12-second-tab', second));
  await second.close();
  return JSON.stringify({ errors, out }, null, 1);
}
