// Browser check: HR's time-off card in the Faculty view (approved redesign
// docs/superpowers/specs/2026-11-03-hr-card-redesign.html: 3-second summary slip, dropdowns, ⓘ notes) and the
// staff hop on Topology (HR Agent, staff only). Run it on a SEPARATE stack, never the user's demo (it presses
// New conversation, which resets the classroom):
//   node scripts/demo/rehearsal-stack.js --ui 5544 --base 52340 --mock
//   playwright-cli -s=hr open http://127.0.0.1:5544/faculty
//   playwright-cli -s=hr run-code "$(cat scripts/browser-checks/hr-card.js)"
// Screenshots go to SHOTS (relative to where playwright-cli runs). Mock HR = a labelled heuristic: this
// checks the card on screen and the plumbing, not live judgment. Dates like “this Thursday” depend on
// today, so day names are matched by shape. Look at every screenshot.
async (page) => {
  const SHOTS = '.superpowers/sdd/2026-11-03-hr-card-redesign/shots';
  page.setDefaultTimeout(30000);
  const results = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  const origin = await page.evaluate(() => location.origin);
  await page.setViewportSize({ width: 1280, height: 1000 });

  // A fresh classroom (separate stack only): New conversation also resets HR and the Professor's chat.
  await page.goto(`${origin}/conversation`);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.waitForTimeout(1200);
  await page.goto(`${origin}/faculty`);
  await page.waitForTimeout(1200);

  const card = page.locator('#prof-log .hr-card');
  const namePicker = card.locator('a2ui-choicepicker').nth(0);
  const reasonPicker = card.locator('a2ui-choicepicker').nth(1);
  const submit = card.getByRole('button', { name: 'Submit request', exact: true });
  async function say(text) {
    const before = await page.locator('#prof-log > li').count();
    await page.locator('#prof-message').fill(text);
    await page.locator('#prof-message').press('Enter');
    await page.waitForFunction((n) => document.querySelectorAll('#prof-log > li').length > n && !document.querySelector('#prof-log .chat-pending'), before, { timeout: 30000 });
    await page.waitForTimeout(700);
  }
  const text = (sel) => card.locator(sel).first().textContent().then((t) => t?.replace(/\s+/g, ' ').trim() ?? null).catch(() => null);
  const shown = (loc) => loc.first().isVisible().catch(() => false);
  const shot = async (name) => { await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: `${SHOTS}/${name}` }); };
  const visibleChips = (picker) => picker.locator('.a2ui-chip').evaluateAll((bs) => bs.filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()));
  const allChips = (picker) => picker.locator('.a2ui-chip').evaluateAll((bs) => bs.map((b) => b.textContent.trim()));
  const isOpen = (picker) => picker.evaluate((p) => p.classList.contains('open'));
  const tipShown = (info) => info.locator('[role="tooltip"]').evaluate((t) => getComputedStyle(t).visibility === 'visible' && getComputedStyle(t).opacity === '1');
  async function openPicker(picker) {
    await picker.locator('.a2ui-chip-selected, .dd-empty:not([hidden])').first().click();
    await page.waitForTimeout(150);
  }
  async function pick(picker, label) {
    if (!(await isOpen(picker))) await openPicker(picker);
    await picker.locator('.a2ui-chip').filter({ hasText: new RegExp(`^\\s*${label.replace(/[/()]/g, '\\$&')}\\s*$`) }).click();
    await page.waitForTimeout(300);
  }
  async function press(label) {
    await card.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#prof-log .hr-card'), null, { timeout: 30000 });
    await page.waitForTimeout(700);
  }
  const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \\d{1,2}';

  // 1. Bereavement: the 3-second slip (what, reason, when, “doesn't use”), “Picked from what you wrote”, closed dropdowns.
  await say('I want to file for time off. My grandmother passed away, and I need this Thursday and Friday for the funeral.');
  check('bereavement: card shown', await card.count() === 1);
  check('bereavement: lead', (await text('.hr-lead')) === "I'm sorry for your loss. Check it and submit.", await text('.hr-lead'));
  check('bereavement: .hr-what', (await text('.hr-slip .hr-what')) === 'Bereavement', await text('.hr-slip .hr-what'));
  check('bereavement: .hr-why', (await text('.hr-slip .hr-why')) === 'Grandparent/Great Grandparent', await text('.hr-slip .hr-why'));
  check('bereavement: .hr-when', new RegExp(`^${DAY} to ${DAY}, 2 days$`).test(await text('.hr-slip .hr-when')), await text('.hr-slip .hr-when'));
  check('bereavement: .hr-free', (await text('.hr-slip .hr-free')) === "Bereavement doesn't use your vacation or sick leave.", await text('.hr-slip .hr-free'));
  check('bereavement: .hr-because under the slip', /^Picked from what you wrote: “.+”\.$/.test(await text('.hr-because')) && await card.evaluate((c) => c.querySelector('.hr-slip').nextElementSibling?.classList.contains('hr-because')), await text('.hr-because'));
  check('bereavement: surface heading not repeated', !(await shown(card.locator('h3', { hasText: 'Time off request' }))));
  check('bereavement: name dropdown closed shows only the pick', JSON.stringify(await visibleChips(namePicker)) === '["Bereavement"]' && !(await shown(namePicker.locator('.a2ui-filter-input'))), await visibleChips(namePicker));
  check('bereavement: reason dropdown closed shows only the pick', JSON.stringify(await visibleChips(reasonPicker)) === '["Grandparent/Great Grandparent"]', await visibleChips(reasonPicker));
  check('bereavement: Submit enabled', await submit.isEnabled());
  await shot('hr-1-bereavement.png');

  // 2. The note's ⓘ: hover shows the privacy text; the button names the tooltip.
  const noteInfo = card.locator('a2ui-basic-textfield .hr-info');
  check('note ⓘ present after the note label', await noteInfo.count() === 1);
  const describedBy = await noteInfo.locator('button').getAttribute('aria-describedby');
  check('note ⓘ: aria-describedby → role=tooltip', Boolean(describedBy) && await card.locator(`[id="${describedBy}"][role="tooltip"]`).count() === 1, describedBy);
  check('note ⓘ hidden before hover', !(await tipShown(noteInfo)));
  await noteInfo.locator('button').hover();
  await page.waitForTimeout(200);
  check('note ⓘ: hover shows the privacy text', await tipShown(noteInfo) && (await noteInfo.locator('[role="tooltip"]').textContent()).startsWith('Your manager, your timekeeper and Payroll Services can read this note.'));
  await shot('hr-2-note-info-hover.png');
  await page.mouse.move(0, 0);

  // 3. Name dropdown: open, type “sick”, pick Sick Leave → reasons are Sick Leave's; the slip shows the balance.
  await openPicker(namePicker);
  check('name dropdown opens with the filter focused', await isOpen(namePicker) && await namePicker.locator('.a2ui-filter-input').evaluate((i) => document.activeElement === i));
  check('name dropdown lists every name', (await visibleChips(namePicker)).length > 20, (await visibleChips(namePicker)).length);
  await shot('hr-3-name-dropdown-open.png');
  await namePicker.locator('.a2ui-filter-input').fill('sick');
  await page.waitForTimeout(200);
  check('typing “sick” filters the list', JSON.stringify(await visibleChips(namePicker)) === '["Sick Leave"]', await visibleChips(namePicker));
  await shot('hr-4-name-filter-sick.png');
  await pick(namePicker, 'Sick Leave');
  check('picking closes the dropdown', !(await isOpen(namePicker)));
  check('sick: .hr-what', (await text('.hr-slip .hr-what')) === 'Sick Leave', await text('.hr-slip .hr-what'));
  check('sick: reason list is Sick Leave\'s', JSON.stringify(await allChips(reasonPicker)) === '["Bereavement","Family Care","Sick Personal"]', await allChips(reasonPicker));
  check('sick: no default reason → amber placeholder', await shown(reasonPicker.locator('.dd-empty:not([hidden])')) && await reasonPicker.evaluate((p) => p.classList.contains('dd-missing')));
  check('sick: .hr-left', (await text('.hr-slip .hr-left')) === '13 days of sick leave left after this', await text('.hr-slip .hr-left'));
  check('sick: .hr-left-n is the big number', (await text('.hr-left-n')) === '13');
  check('sick: bar keep + use', await card.locator('.hr-bar .hr-keep').count() === 1 && await card.locator('.hr-bar .hr-use').count() === 1);
  const barLabels = await card.locator('.hr-bar-labels span').allTextContents();
  check('sick: bar labels', JSON.stringify(barLabels) === '["You have 15 days now","this request: 2 days"]', barLabels);
  check('sick: “Picked from what you wrote” hidden after a name change', !(await shown(card.locator('.hr-because'))));
  // Carried check (Task 3): the Submit button's `required` check treats [] as empty.
  check('sick: Submit disabled while the reason is []', !(await submit.isEnabled()));
  await shot('hr-5-sick-picked.png');
  // Esc closes; a click outside closes.
  await openPicker(reasonPicker);
  check('reason dropdown opens', await isOpen(reasonPicker));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Esc closes the dropdown', !(await isOpen(reasonPicker)));
  await openPicker(namePicker);
  await card.locator('.hr-slip').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(150);
  check('a click outside closes the dropdown', !(await isOpen(namePicker)));
  await pick(reasonPicker, 'Family Care');
  check('reason picked: .hr-why', (await text('.hr-slip .hr-why')) === 'Family Care', await text('.hr-slip .hr-why'));
  check('reason picked: Submit enabled', await submit.isEnabled());
  await press('Submit request');
  const receipt = page.locator('#prof-log .msg.hr-receipt').last();
  const receiptText = (await receipt.locator('.msg-text').textContent())?.trim();
  check('submit: receipt names what was picked on the card', new RegExp(`^Your time off is recorded\\. Request \\d{7}: Sick Leave \\(Family Care\\), ${DAY} to ${DAY}, 16 hours\\.$`).test(receiptText), receiptText);
  // The closed card: HR's question stays, answered with what was filed; no stale "pick from the dropdown".
  const record = page.locator('#prof-log .msg.hr-closed').last();
  const recordText = ((await record.textContent()) ?? '').replace(/\s+/g, ' ');
  check('submit: the card becomes a record of what was filed', /You submitted\s*Sick Leave\s*Family Care/.test(recordText) && new RegExp(`${DAY} to ${DAY} · 16 hours`).test(recordText), recordText);
  check('submit: no stale dropdown wording left in the chat', !/pick from the dropdown below/.test(await page.locator('#prof-log').textContent()));
  // He teaches every weekday: the assistant offers to cancel those classes (sent only on yes — see the end).
  const offer = ((await page.locator('#prof-log .msg[data-speaker="professor"]').last().textContent()) ?? '').replace(/\s+/g, ' ');
  check('submit: the assistant offers a class cancellation for the filed days', new RegExp(`You have Marketing 351 \\(10:00–10:50 AM, Mihaylo Hall 2405\\) on ${DAY} and ${DAY}\\. Would you like me to send a cancellation to your students\\? To add a note for your students, such as a makeup plan, reply yes followed by the note\\.`).test(offer), offer);
  await receipt.scrollIntoViewIfNeeded();
  await page.locator('#prof-log').screenshot({ path: `${SHOTS}/hr-6-submit-receipt.png` });

  // 4. Leaving at noon Thursday, out Friday: part day + full day, the time from the words, the balance bar.
  await say("I want to file for time off. I'm not feeling well, I'm leaving at noon on Thursday and I'll be out Friday");
  check('noon: .hr-what', (await text('.hr-slip .hr-what')) === 'Sick Leave', await text('.hr-slip .hr-what'));
  check('noon: .hr-when names the start, then the full day', new RegExp(`^${DAY} from 12:00 \\(\\d+(\\.\\d+)? hours?\\), then ${DAY} in full$`).test(await text('.hr-slip .hr-when')), await text('.hr-slip .hr-when'));
  check('noon: lead', /^Feel better soon\./.test(await text('.hr-lead')), await text('.hr-lead'));
  // 13 hours is not a whole or quarter day: the slip says hours, not “13.38 days” (3-second rule).
  check('noon: big number in hours', (await text('.hr-left-n')) === '107' && (await text('.hr-left-t')) === 'hours of sick leave left after this', await text('.hr-slip .hr-left'));
  const noonLabels = await card.locator('.hr-bar-labels span').allTextContents();
  check('noon: bar labels', JSON.stringify(noonLabels) === '["You have 15 days now","this request: 13 hours"]', noonLabels);
  await shot('hr-7-sick-noon.png');
  // Hours edited on the card: the time from the words no longer fits (mockup rule).
  await card.locator('input[type="number"]').fill('12');
  await page.waitForTimeout(300);
  check('noon: edited hours drop the time from the words', !/12:00/.test(await text('.hr-slip .hr-when')) && /12 hours/.test(await text('.hr-slip .hr-when')), await text('.hr-slip .hr-when'));
  await press('Cancel');
  check('cancel: the card becomes "You cancelled this card"', /You cancelled this card\. Nothing was filed\./.test(await page.locator('#prof-log .msg.hr-closed').last().textContent()));
  // Owner 2026-11-04: exactly one cancel sentence on screen (no separate HR bubble repeating it).
  const logText = (await page.locator('#prof-log').textContent()) ?? '';
  check('cancel: the cancel sentence appears exactly once', (logText.match(/You cancelled this card\. Nothing was filed\./g) ?? []).length === 1 && !/Cancelled\. Nothing was recorded/.test(logText), (logText.match(/cancelled/gi) ?? []).length);

  // 5. “I need Friday off” — no reason: amber “Choose the kind of leave”, empty name dropdown highlighted.
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
        const path = `${SHOTS}/hr-12-topology-hub-hr${topoShots.length ? '-b' : ''}.png`;
        await topo.locator('#topo').screenshot({ path });
        topoShots.push(path);
      }
    }
  })();
  await say('I need Friday off');
  await watching;
  check('missing: lead asks for the kind', /^What kind of time off is this\?/.test(await text('.hr-lead')), await text('.hr-lead'));
  check('missing: .hr-what placeholder in amber', (await text('.hr-slip .hr-what')) === 'Choose the kind of leave' && await card.locator('.hr-what.empty').count() === 1);
  check('missing: .hr-free', (await text('.hr-slip .hr-free')) === 'Your balance shows here once you choose the kind of leave.', await text('.hr-slip .hr-free'));
  check('missing: name placeholder button, amber', (await text('a2ui-choicepicker .dd-empty:not([hidden])')) === 'Choose…' && await namePicker.evaluate((p) => p.classList.contains('dd-missing')));
  check('missing: reason disabled until a name', await reasonPicker.evaluate((p) => p.classList.contains('disabled')) && (await reasonPicker.locator('.dd-empty').textContent()).trim() === 'Reason (pick a name first)');
  check('missing: no chip selected', await card.locator('.a2ui-chip-selected').count() === 0);
  check('missing: Submit disabled', !(await submit.isEnabled()));
  // No name: HR's choices as pills between the question and “If none of these fit …” (user rule 2026-11-03).
  const pills = card.locator('.hr-choices:not([hidden]) .hr-pill');
  check('choices: lead is the bare question', (await text('.hr-lead')) === 'What kind of time off is this?', await text('.hr-lead'));
  check('choices: three pills (his leave balances)', JSON.stringify((await pills.allTextContents()).map((t) => t.trim())) === '["Vacation","Sick Leave","Personal Holiday"]', await pills.allTextContents());
  check('choices: hint after the pills', (await text('.hr-hint')) === 'If none of these fit, pick from the dropdown below.', await text('.hr-hint'));
  await shot('hr-8-missing-name.png');
  await pills.filter({ hasText: 'Vacation' }).click();
  await page.waitForTimeout(300);
  check('choices: a tap fills Absence name and its reason', JSON.stringify(await card.locator('.a2ui-chip-selected').allTextContents().then((a) => a.map((t) => t.trim()))) === '["Vacation","Vacation"]', await card.locator('.a2ui-chip-selected').allTextContents());
  check('choices: pills and hint hide once a name is picked', await card.locator('.hr-choices').isHidden() && await card.locator('.hr-hint').isHidden() && (await text('.hr-lead')) === 'Check it and submit.', await text('.hr-lead'));
  check('choices: the summary follows the tap', (await text('.hr-slip .hr-what')) === 'Vacation', await text('.hr-slip .hr-what'));
  await shot('hr-8b-choice-tapped.png');
  // Jury Duty needs proof: an ⓘ after the title (tap shows it).
  await pick(namePicker, 'Jury Duty');
  check('jury: lead follows the name picked on the card', (await text('.hr-lead')) === 'Check it and submit.', await text('.hr-lead'));
  const proofInfo = card.locator('.hr-what-row .hr-info');
  check('jury: proof ⓘ after the title', await proofInfo.count() === 1);
  await proofInfo.locator('button').click();
  await page.waitForTimeout(150);
  check('jury: tap shows the proof note', await tipShown(proofInfo) && (await proofInfo.locator('button').getAttribute('aria-expanded')) === 'true' && /jury summons/.test(await proofInfo.locator('[role="tooltip"]').textContent()));
  check('jury: default reason picked (only one)', JSON.stringify(await visibleChips(reasonPicker)) === '["Jury Duty"]', await visibleChips(reasonPicker));
  check('jury: .hr-free', (await text('.hr-slip .hr-free')) === "Jury Duty doesn't use your vacation or sick leave.", await text('.hr-slip .hr-free'));
  await shot('hr-9-jury-proof-tap.png');
  // Keyboard focus also shows it.
  await proofInfo.locator('button').click(); // tap again: closed
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  check('jury: keyboard focus shows the proof note', await proofInfo.locator('button').evaluate((b) => document.activeElement === b) && await tipShown(proofInfo));
  // Card edits survive a chat follow-up: pick Bereavement, move the dates on the card, then answer in the chat.
  await pick(namePicker, 'Bereavement');
  check('bereavement picked: lead says sorry', (await text('.hr-lead')) === "I'm sorry for your loss. Check it and submit.", await text('.hr-lead'));
  check('bereavement picked: reason asked (amber)', await reasonPicker.evaluate((p) => p.classList.contains('dd-missing')) && (await allChips(reasonPicker)).length === 10, await allChips(reasonPicker));
  const dates = card.locator('input[type="date"]');
  await dates.nth(0).fill('2026-11-12');
  await dates.nth(1).fill('2026-11-13');
  await card.locator('input[type="number"]').fill('16');
  await page.waitForTimeout(300);
  check('card edits: slip follows the dates', (await text('.hr-slip .hr-when')) === 'Thu, Nov 12 to Fri, Nov 13, 2 days', await text('.hr-slip .hr-when'));
  await shot('hr-10-picked-on-card.png');
  await say('It was my uncle');
  check('follow-up: name picked on the card kept', (await text('.hr-slip .hr-what')) === 'Bereavement', await text('.hr-slip .hr-what'));
  check('follow-up: reason read from the chat', (await text('.hr-slip .hr-why')) === 'Aunt/Uncle', await text('.hr-slip .hr-why'));
  check('follow-up: dates edited on the card kept', /^Thu, Nov 12 to Fri, Nov 13/.test(await text('.hr-slip .hr-when')), await text('.hr-slip .hr-when'));
  await shot('hr-11-followup-kept-edits.png');
  await press('Submit request');
  const receipt2 = (await page.locator('#prof-log .msg.hr-receipt').last().locator('.msg-text').textContent())?.trim();
  check('follow-up: submit files the edited dates', /Bereavement \(Aunt\/Uncle\), Thu, Nov 12 to Fri, Nov 13, 16 hours\.$/.test(receipt2), receipt2);
  // Topology: the staff run in the event list and as a trace (Professor → Hub → HR and back).
  check('topology: hub→hr pulse seen live', topoShots.length > 0, topoShots);
  const forwarded = await topo.locator('#topo-events li', { hasText: 'Forwarded to HR Agent' }).count();
  check('topology: event list has “Forwarded to HR Agent”', forwarded > 0, forwarded);
  const staffTrace = await topo.locator('#topo-trace option', { hasText: 'Staff request (Faculty → HR)' }).first().getAttribute('value').catch(() => null);
  if (staffTrace) await topo.locator('#topo-trace').selectOption(staffTrace);
  await topo.waitForTimeout(400);
  check('topology: staff trace uses hub-hr and hub-professor', await topo.locator('[data-edge="hub-hr"].in-trace').count() === 1 && await topo.locator('[data-edge="hub-professor"].in-trace').count() === 1);
  await topo.screenshot({ path: `${SHOTS}/hr-13-topology-staff-trace.png` });
  await topo.close();

  // The cancellation offer was never answered, so each filing added its class days (Nov 5–6, then Nov 12–13):
  // “yes” sends them all, with dates only, to the students.
  await say('yes');
  const sent = ((await page.locator('#prof-log').textContent()) ?? '').replace(/\s+/g, ' ');
  check('cancellation: “yes” sends it to the students and the chat states the real counts (review A4)', /25 students notified\./.test(sent) && /Marketing 351 \(10:00–10:50 AM, Mihaylo Hall 2405\) is cancelled on Thu, Nov 5, Fri, Nov 6, Thu, Nov 12 and Fri, Nov 13\./.test(sent), sent.slice(-300));
  // Part 17: the cancellation goes to all 25 students, so its card is a summary with the rows folded away.
  const cancelPost = page.locator('#prof-log .sent-post, #prof-log .post-card').last();
  const cancelSum = await cancelPost.locator('.dsum .pill').allTextContents();
  check('cancellation: delivery summary "25 notified", fold of 25', cancelSum.join(' | ') === '25 notified' && await cancelPost.locator('details.dlist li').count() === 25, cancelSum);
  await page.locator('#prof-log').screenshot({ path: `${SHOTS}/hr-14-cancellation-sent.png` });
  await page.goto(`${origin}/conversation`);
  const studentSaw = await page.waitForFunction(() => /Marketing 351 \(10:00–10:50 AM, Mihaylo Hall 2405\) is cancelled on Thu, Nov 5, Fri, Nov 6, Thu, Nov 12 and Fri, Nov 13\./.test(document.body.textContent), null, { timeout: 15000 }).then(() => true).catch(() => false);
  const studentText = (await page.locator('#view-conversation').textContent()) ?? ''; // the student's own view (the page also holds the hidden Faculty view)
  check('cancellation: the student sees it, with no reason', studentSaw && !/uncle|bereave|funeral|sick|grandmother/i.test(studentText));
  await page.screenshot({ path: `${SHOTS}/hr-15-student-sees-cancellation.png` });

  check('no page or console errors', errors.length === 0, errors);
  return { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), total: results.length };
}
