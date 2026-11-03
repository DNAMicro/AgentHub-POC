// Browser check: HR's time-off card in the Professor view, and the staff hop on Topology (HR Agent, staff
// only). Run it on a SEPARATE stack, never the user's demo (it presses New conversation, which resets the
// classroom):
//   node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock
//   playwright-cli -s=hr open http://127.0.0.1:5544/professor
//   playwright-cli -s=hr run-code "$(cat scripts/browser-checks/hr-card.js)"
// Screenshots go to SHOTS (relative to where playwright-cli runs). Mock HR = a labelled heuristic: this
// checks the card on screen and the plumbing, not live judgment. Look at every screenshot.
async (page) => {
  const SHOTS = '.superpowers/sdd/2026-11-02-hr-agent-time-off/shots';
  page.setDefaultTimeout(30000);
  const results = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  const origin = await page.evaluate(() => location.origin);
  await page.setViewportSize({ width: 1280, height: 1000 });

  // A fresh classroom (separate stack only): New conversation also resets HR and the Professor's chat.
  await page.goto(`${origin}/conversation`);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.waitForTimeout(1200);
  await page.goto(`${origin}/professor`);
  await page.waitForTimeout(1200);

  const card = page.locator('#prof-log .hr-card');
  async function say(text) {
    const before = await page.locator('#prof-log > li').count();
    await page.locator('#prof-message').fill(text);
    await page.locator('#prof-message').press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('#prof-log > li').length > n && !document.querySelector('#prof-log .chat-pending'), before, { timeout: 30000 });
    await page.waitForTimeout(700);
  }
  const text = (sel) => card.locator(sel).first().textContent().then((t) => t?.trim() ?? null).catch(() => null);
  const shot = async (name) => { await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: `${SHOTS}/${name}` }); };
  // The star of a required label is drawn red: the label's gradient ends in the --req colour.
  const starRed = () => card.locator('a2ui-choicepicker > label').evaluate((l) => getComputedStyle(l).backgroundImage.includes('linear-gradient') && getComputedStyle(l).color === 'rgba(0, 0, 0, 0)');
  const visibleHeading = () => card.locator('h3', { hasText: 'Time off request' }).isVisible().catch(() => false);
  async function press(label) {
    await card.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#prof-log .hr-card'), null, { timeout: 30000 });
    await page.waitForTimeout(700);
  }

  // 1. Bereavement: title, one when line, one why line, rows, the “doesn't use” note; then Submit → receipt.
  await say('I want to file for time off. My grandmother passed away, and I need this Thursday and Friday for the funeral.');
  check('bereavement: card shown', await card.count() === 1);
  check('bereavement: lead', /^I'm sorry for your loss\. Here's your request\. Check it and submit\./.test(await text('.hr-lead')), await text('.hr-lead'));
  check('bereavement: title', (await text('.hr-title')) === 'Bereavement/Funeral', await text('.hr-title'));
  check('bereavement: when', /· 2 full days$/.test(await text('.hr-when')), await text('.hr-when'));
  check('bereavement: why', /^Chosen because you said “.+”\.$/.test(await text('.hr-why')), await text('.hr-why'));
  check('bereavement: relationship row filled', (await card.locator('input[type="text"]').inputValue()) === 'grandmother');
  check('bereavement: no-credits note', (await text('.hr-note')) === 'This doesn\'t use your vacation or sick hours.', await text('.hr-note'));
  check('bereavement: red star', await starRed());
  check('bereavement: surface heading not repeated', !(await visibleHeading()));
  check('bereavement: buttons', (await card.getByRole('button', { name: 'Submit request', exact: true }).isVisible()) && (await card.getByRole('button', { name: 'Cancel', exact: true }).isVisible()));
  await shot('hr-1-bereavement.png');
  await press('Submit request');
  const receipt = page.locator('#prof-log .msg.hr-receipt').last();
  const receiptText = (await receipt.locator('.msg-text').textContent())?.trim();
  check('submit: receipt bubble', /^Sent to your manager for a decision\. Request TO-\w+: Bereavement\/Funeral, Thu, Nov 5 – Fri, Nov 6, 16 h\.$/.test(receiptText), receiptText);
  await receipt.scrollIntoViewIfNeeded();
  await page.locator('#prof-log').screenshot({ path: `${SHOTS}/hr-4-submit-receipt.png` });

  // 2. Going home sick at noon: a partial day with the balance bar (now / after, striped = this request).
  await say("I want to file for time off. I'm not feeling well and I'm leaving at noon today.");
  check('sick: title', (await text('.hr-title')) === 'Sick – Self', await text('.hr-title'));
  check('sick: when names the start and hours', /from 12:00 \(\d+(\.\d+)? hours?\)$/.test(await text('.hr-when')), await text('.hr-when'));
  check('sick: balance bar', /^Sick hours/.test(await text('.hr-bal-row')) && await card.locator('.hr-meter .use').count() === 1, await text('.hr-bal-row'));
  check('sick: lead', /^Feel better soon\./.test(await text('.hr-lead')), await text('.hr-lead'));
  await shot('hr-2-sick-noon.png');
  await press('Cancel');
  check('cancel: HR says nothing was sent', /Cancelled\. Nothing was sent to your manager\./.test(await page.locator('#prof-log .msg[data-speaker="hr"]').last().textContent()));

  // 3. “I need Friday off” — no reason: the absence name is empty and highlighted, and HR asks in the chat.
  //    Meanwhile a second tab watches Topology for the Hub → HR hop of this staff request.
  const topo = await page.context().newPage();
  await topo.setViewportSize({ width: 1280, height: 1000 });
  await topo.goto(`${origin}/topology`);
  await topo.waitForTimeout(1500);
  const topoShots = [];
  const watching = (async () => {
    for (let i = 0; i < 24; i++) {
      await topo.waitForTimeout(250);
      const lit = await topo.locator('[data-edge="hub-hr"] .lane.lit').count();
      if (lit && topoShots.length < 2) {
        const path = `${SHOTS}/hr-5-topology-hub-hr${topoShots.length ? '-b' : ''}.png`;
        await topo.locator('#topo').screenshot({ path });
        topoShots.push(path);
      }
    }
  })();
  await say('I need Friday off');
  await watching;
  check('missing: title is the placeholder', (await text('.hr-title')) === 'Time off request', await text('.hr-title'));
  check('missing: absence name row highlighted', (await card.getAttribute('data-missing'))?.split(' ').includes('absenceName')
    && await card.locator('a2ui-basic-row:has(a2ui-choicepicker)').evaluate((r) => getComputedStyle(r).boxShadow.includes('inset')));
  check('missing: no chip selected', await card.locator('.a2ui-chip-selected').count() === 0);
  check('missing: HR asks in the chat', /What kind of time off is this/.test(await text('.hr-lead')), await text('.hr-lead'));
  await shot('hr-3-missing-name.png');
  // The relationship row is always there (final fix 1); its star follows the name picked on the card.
  const relLabel = card.locator('a2ui-basic-textfield:has(input[type="text"]) > label');
  const isRed = (loc) => loc.evaluate((l) => getComputedStyle(l).color === 'rgba(0, 0, 0, 0)');
  check('relationship row on a no-reason card', await relLabel.count() === 1);
  check('relationship label says when it is needed', (await relLabel.textContent())?.trim() === 'Relationship (bereavement or family care)', await relLabel.textContent());
  check('relationship: no star while not needed', !(await isRed(relLabel)));
  check('hours keeps its red star', await isRed(card.locator('a2ui-basic-textfield:has(input[type="number"]) > label')));
  await card.getByRole('button', { name: 'Bereavement/Funeral', exact: true }).click();
  await page.waitForTimeout(300);
  check('relationship: label gets the star after picking Bereavement/Funeral', (await relLabel.textContent())?.trim() === 'Relationship *', await relLabel.textContent());
  check('relationship: star drawn red', await isRed(relLabel));
  // Card edits survive a chat follow-up (final fix 2): move the dates on the card, then answer in the chat.
  const dates = card.locator('input[type="date"]');
  await dates.nth(0).fill('2026-11-12');
  await dates.nth(1).fill('2026-11-13');
  await shot('hr-7-picked-on-card.png');
  await say('It was my uncle');
  check('follow-up: name picked on the card kept', (await text('.hr-title')) === 'Bereavement/Funeral', await text('.hr-title'));
  check('follow-up: dates edited on the card kept', /^Thu, Nov 12 – Fri, Nov 13/.test(await text('.hr-when')), await text('.hr-when'));
  check('follow-up: relationship read from the chat', (await card.locator('input[type="text"]').inputValue()) === 'uncle');
  await shot('hr-8-followup-kept-edits.png');
  await press('Submit request');
  const receipt2 = (await page.locator('#prof-log .msg.hr-receipt').last().locator('.msg-text').textContent())?.trim();
  check('follow-up: submit files the edited dates', /Bereavement\/Funeral, Thu, Nov 12 – Fri, Nov 13, 16 h\.$/.test(receipt2), receipt2);
  // Topology: the staff run in the event list and as a trace (Professor → Hub → HR and back).
  check('topology: hub→hr pulse seen live', topoShots.length > 0, topoShots);
  const forwarded = await topo.locator('#topo-events li', { hasText: 'Forwarded to HR Agent' }).count();
  check('topology: event list has “Forwarded to HR Agent”', forwarded > 0, forwarded);
  const staffTrace = await topo.locator('#topo-trace option', { hasText: 'Staff request' }).first().getAttribute('value').catch(() => null);
  if (staffTrace) await topo.locator('#topo-trace').selectOption(staffTrace);
  await topo.waitForTimeout(400);
  check('topology: staff trace uses hub-hr and hub-professor', await topo.locator('[data-edge="hub-hr"].in-trace').count() === 1 && await topo.locator('[data-edge="hub-professor"].in-trace').count() === 1);
  await topo.screenshot({ path: `${SHOTS}/hr-6-topology-staff-trace.png` });
  await topo.close();

  check('no page errors', errors.length === 0, errors);
  return { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: results.length };
}
